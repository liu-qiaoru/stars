import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from media_agent_worker.multi_frame_vlm_feasibility import (
    apply_phase9a_gate,
    apply_human_review,
    build_verification_prompt,
    calculate_motion_peak_times,
    classify_source_group,
    main,
    MultiFrameSampler,
    report_review_fingerprint,
    Phase9aRunner,
    select_frame_times,
    validate_phase9a_manifest,
)


def build_manifest():
    """Return a frozen experiment definition before any model output is observed."""
    cases = []
    for index in range(12):
        cases.append(
            {
                "id": f"case-{index + 1}",
                "query_id": f"00000000-0000-4000-8000-{index + 1:012d}",
                "candidate_key": f"10000000-0000-4000-8000-{index + 1:012d}",
                "expected_relevance": index % 3,
                "coverage_tags": [
                    "caption_only" if index < 3 else "siglip_visual",
                    "short_scene" if 3 <= index < 6 else "standard_scene",
                    "thirty_second" if 6 <= index < 9 else "standard_duration",
                ],
            }
        )
    return {
        "schema_version": "phase9a-multi-frame-v1",
        "phase8_run_id": "6298b745-d9d3-44bf-86a0-2d0a0b46360c",
        "ollama_model": "qwen2.5vl:7b",
        "ollama_digest": "a" * 64,
        "prompt_version": "frame-verify-v1",
        "repeat_count": 3,
        "source_group_gate": {
            "minimum_cases_per_group": 3,
            "maximum_caption_only_accuracy_gap": 0.2,
        },
        "cases": cases,
    }


class Phase9aManifestTests(unittest.TestCase):
    def test_requires_frozen_run_digest_repeats_and_source_groups(self):
        manifest = validate_phase9a_manifest(build_manifest())

        self.assertEqual(manifest["repeat_count"], 3)
        self.assertEqual(len(manifest["cases"]), 12)

        invalid = build_manifest()
        invalid["ollama_digest"] = "latest"
        with self.assertRaisesRegex(ValueError, "digest"):
            validate_phase9a_manifest(invalid)

        insufficient_caption_only = build_manifest()
        insufficient_caption_only["cases"][2]["coverage_tags"] = ["siglip_visual"]
        with self.assertRaisesRegex(ValueError, "caption_only"):
            validate_phase9a_manifest(insufficient_caption_only)


class Phase9aFrameSelectionTests(unittest.TestCase):
    def test_ffmpeg_failure_keeps_diagnostic_but_redacts_source_path(self):
        source_path = "/private/media/secret video.mp4"
        runner = mock.Mock(
            return_value=SimpleNamespace(
                returncode=1,
                stdout=b"",
                stderr=f"decoder failed while reading {source_path}".encode(),
            )
        )
        sampler = MultiFrameSampler(ffmpeg_runner=runner)

        with self.assertRaises(RuntimeError) as raised:
            sampler._scan_motion(
                {
                    "source_path": source_path,
                    "scene_start_seconds": 1.0,
                    "duration_seconds": 2.0,
                }
            )

        self.assertIn("exit code 1", str(raised.exception))
        self.assertIn("decoder failed", str(raised.exception))
        self.assertNotIn(source_path, str(raised.exception))

    def test_selects_bounded_uniform_local_and_motion_frames(self):
        selected = select_frame_times(
            scene_start_seconds=10.0,
            scene_end_seconds=40.0,
            best_frame_time_seconds=25.0,
            motion_peak_times_seconds=[15.5, 35.5],
        )

        self.assertGreaterEqual(len(selected), 1)
        self.assertLessEqual(len(selected), 12)
        self.assertEqual([row["time_seconds"] for row in selected], sorted(row["time_seconds"] for row in selected))
        self.assertTrue(all(10.0 <= row["time_seconds"] < 40.0 for row in selected))
        self.assertTrue(any("siglip_best" in row["selection_reasons"] for row in selected))
        self.assertTrue(any("motion_peak" in row["selection_reasons"] for row in selected))

    def test_caption_only_and_half_second_scene_never_invent_best_hit(self):
        selected = select_frame_times(
            scene_start_seconds=3.0,
            scene_end_seconds=3.5,
            best_frame_time_seconds=None,
            motion_peak_times_seconds=[],
        )

        self.assertGreaterEqual(len(selected), 1)
        self.assertTrue(all(row["time_seconds"] < 3.5 for row in selected))
        self.assertFalse(any("siglip_best" in row["selection_reasons"] for row in selected))

    def test_calculates_local_motion_peaks_with_fixed_half_second_spacing(self):
        # 五张 2x1 灰度帧：第 2 张突变、随后保持、最后再次突变。
        frames = [bytes(values) for values in ([0, 0], [255, 255], [255, 255], [0, 0], [255, 255])]
        peaks = calculate_motion_peak_times(
            frames,
            scene_start_seconds=10.0,
            step_seconds=0.5,
            max_peaks=2,
        )

        self.assertEqual(peaks, [10.5, 11.5])


class Phase9aPromptAndGateTests(unittest.TestCase):
    def test_source_group_requires_caption_or_visual_evidence(self):
        self.assertEqual(classify_source_group({"caption": 1}), "caption_only")
        self.assertEqual(
            classify_source_group({"caption": 2, "visual": 1}), "siglip_visual"
        )
        with self.assertRaisesRegex(ValueError, "visual or Caption"):
            classify_source_group({"transcript": 1})

    def test_prompt_maps_each_image_to_absolute_time_and_forbids_hidden_events(self):
        prompt = build_verification_prompt(
            "有人挥手",
            [
                {"frame_index": 1, "time_seconds": 10.5},
                {"frame_index": 2, "time_seconds": 11.0},
            ],
        )

        self.assertIn("图片 1 = 场景绝对时间 10.500 秒", prompt)
        self.assertIn("不得推断", prompt)
        self.assertIn("不得使用音频", prompt)

    def test_gate_requires_stability_accuracy_speed_frames_and_swap(self):
        results = []
        for case in build_manifest()["cases"]:
            for repeat_index in range(3):
                results.append(
                    {
                        "case_id": case["id"],
                        "repeat_index": repeat_index + 1,
                        "duration_seconds": 30.0 if "thirty_second" in case["coverage_tags"] else 2.0,
                        "expected_relevance": case["expected_relevance"],
                        "relevance": case["expected_relevance"],
                        "source_group": "caption_only" if "caption_only" in case["coverage_tags"] else "siglip_visual",
                        "frame_count": 5,
                        "scene_start_seconds": 10.0,
                        "scene_end_seconds": 40.0,
                        "frame_evidence": [
                            {
                                "frame_index": frame_index,
                                "time_seconds": 10.0 + frame_index,
                                "selection_reasons": ["uniform_coverage"],
                                "content_hash": "sha256:" + f"{frame_index:064x}",
                                "width": 640,
                                "height": 360,
                            }
                            for frame_index in range(1, 6)
                        ],
                        "inference_seconds": 20.0,
                        "failure_type": None,
                    }
                )
        gate = apply_phase9a_gate(
            build_manifest(),
            results,
            {
                "start_swap_used_bytes": 0,
                "peak_swap_used_bytes": 1024,
                "end_swap_used_bytes": 0,
                "peak_system_memory_used_bytes": 20 * 1024**3,
                "cold_start_prepared": True,
                "ollama_unload_succeeded": True,
                "cleanup_cooldown_seconds": 10.0,
                "unload_error": None,
            },
        )

        self.assertTrue(gate["automatic_gate_passed"])
        self.assertEqual(gate["worst_top3_30_second_total_seconds"], 60.0)

        results[0]["relevance"] = (results[0]["expected_relevance"] + 1) % 3
        failed = apply_phase9a_gate(build_manifest(), results, gate["resource_metrics"])
        self.assertFalse(failed["automatic_gate_passed"])
        self.assertFalse(failed["all_repeats_stable"])

        unload_failed_metrics = {
            **gate["resource_metrics"],
            "ollama_unload_succeeded": False,
            "unload_error": "RuntimeError: unload failed",
        }
        unload_failed = apply_phase9a_gate(
            build_manifest(), results[1:] + [results[0]], unload_failed_metrics
        )
        self.assertFalse(unload_failed["swap_pressure_within_limit"])
        self.assertFalse(unload_failed["automatic_gate_passed"])

        results[0]["frame_evidence"][-1]["time_seconds"] = 40.0
        outside_boundary = apply_phase9a_gate(
            build_manifest(), results, gate["resource_metrics"]
        )
        self.assertFalse(outside_boundary["strict_frame_contract_passed"])
        self.assertFalse(outside_boundary["automatic_gate_passed"])

    def test_human_review_is_bound_to_exact_report_and_all_cases(self):
        report = {
            "schema_version": "phase9a-multi-frame-v1",
            "phase8_run_id": build_manifest()["phase8_run_id"],
            "prompt_version": "frame-verify-v1",
            "sampling_fingerprint": "sha256:" + "b" * 64,
            "runtime": {"digest": "a" * 64},
            "results": [
                {"case_id": case["id"], "relevance": case["expected_relevance"]}
                for case in build_manifest()["cases"]
            ],
            "gate": {
                "automatic_gate_passed": True,
                "human_reason_review": "pending",
                "final_gate_passed": False,
            },
        }
        review = {
            "schema_version": "phase9a-human-review-v1",
            "report_fingerprint": report_review_fingerprint(report),
            "decision": "failed",
            "reviewed_case_ids": [case["id"] for case in build_manifest()["cases"]],
            "reason_issue_case_ids": ["case-1"],
            "ambiguous_frozen_label_case_ids": [],
            "notes": "逐例查看全部抽帧。",
        }

        finalized = apply_human_review(report, review)

        self.assertEqual(finalized["gate"]["human_reason_review"], "failed")
        self.assertFalse(finalized["gate"]["final_gate_passed"])
        review["report_fingerprint"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            apply_human_review(report, review)

        contradictory = {
            **review,
            "report_fingerprint": report_review_fingerprint(report),
            "decision": "passed",
        }
        with self.assertRaisesRegex(ValueError, "cannot pass"):
            apply_human_review(report, contradictory)

    def test_main_saves_failure_report_when_manifest_validation_fails(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            manifest_path = Path(temp_directory) / "invalid-manifest.json"
            output_path = Path(temp_directory) / "failure-report.json"
            manifest_path.write_text("{}\n", encoding="utf-8")

            with mock.patch("builtins.print"):
                exit_code = main(
                    [
                        "--manifest",
                        str(manifest_path),
                        "--output",
                        str(output_path),
                    ]
                )

            self.assertEqual(exit_code, 2)
            report = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(report["failure"]["stage"], "load_manifest")
            self.assertFalse(report["gate"]["final_gate_passed"])

    @mock.patch("media_agent_worker.multi_frame_vlm_feasibility.time.sleep")
    @mock.patch("media_agent_worker.multi_frame_vlm_feasibility.SystemResourceMonitor")
    def test_runner_unloads_ollama_before_end_resource_sample(self, monitor_class, sleep):
        """防止把仍驻留的 Ollama 模型误报成 Phase 9A 结束内存残留。"""

        monitor = monitor_class.return_value
        monitor.stop.return_value = {
            "start_swap_used_bytes": 0,
            "peak_swap_used_bytes": 1024,
            "end_swap_used_bytes": 0,
            "peak_system_memory_used_bytes": 20 * 1024**3,
            "cold_start_prepared": True,
        }
        client = mock.Mock()
        client.runtime_info.return_value = {"model": "qwen2.5vl:7b"}
        client.verify.return_value = {
            "relevance": 2,
            "inference_seconds": 1.0,
        }
        prepared_paths = []
        sampler = mock.Mock()

        def prepare(_case, case_directory):
            # 真实创建一张临时文件，才能证明 Runner 离开上下文后确实清理它，
            # 而不只是验证调用了一个 mock 方法。
            frame_path = Path(case_directory) / "frame.jpg"
            frame_path.write_bytes(b"temporary frame")
            prepared_paths.append(frame_path)
            return [
                {
                    "frame_index": 1,
                    "time_seconds": 1.0,
                    "selection_reasons": ["uniform"],
                    "content_hash": "sha256:" + "a" * 64,
                    "width": 640,
                    "height": 360,
                    "path": str(frame_path),
                }
            ]

        sampler.prepare.side_effect = prepare
        case = {
            **build_manifest()["cases"][0],
            "query": "生日蛋糕",
            "rrf_rank": 1,
            "source_group": "caption_only",
            "scene_start_seconds": 1.0,
            "scene_end_seconds": 3.0,
            "duration_seconds": 2.0,
        }

        report = Phase9aRunner(
            build_manifest(), [case], ollama_client=client, sampler=sampler
        ).run()

        # 第一次卸载建立真正的冷启动和资源起点，第二次卸载用于测量结束残留。
        self.assertEqual(client.unload.call_count, 2)
        self.assertEqual(
            sleep.call_args_list,
            [mock.call(10.0), mock.call(10.0)],
        )
        self.assertTrue(report["gate"]["resource_metrics"]["ollama_unload_succeeded"])
        self.assertEqual(len(prepared_paths), 1)
        self.assertFalse(prepared_paths[0].exists())


if __name__ == "__main__":
    unittest.main()
