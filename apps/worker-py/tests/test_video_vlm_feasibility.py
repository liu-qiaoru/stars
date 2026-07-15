import json
import time
import unittest

from media_agent_worker.video_vlm_feasibility import (
    InferenceTimeoutError,
    _inference_timeout,
    evaluate_feasibility_gate,
    parse_verification_response,
    validate_benchmark_manifest,
)


def build_manifest():
    """Return the smallest valid matrix: 10 scenes, three durations, and both FPS values."""
    durations = [5, 15, 30, 5, 15, 30, 5, 15, 30, 30]
    return {
        "fps_values": [1, 2],
        "cases": [
            {
                "id": f"case-{index}",
                "source_path": f"/media/case-{index}.mp4",
                "start_seconds": 0,
                "duration_seconds": duration,
                "query": "人物是否做出了指定动作？",
                "expected_relevance": 2,
                "transient_action": index == 1,
            }
            for index, duration in enumerate(durations, start=1)
        ],
    }


class VideoVlmFeasibilityManifestTests(unittest.TestCase):
    def test_requires_ten_real_scenes_three_durations_and_both_fps_values(self):
        manifest = validate_benchmark_manifest(build_manifest(), path_exists=lambda _path: True)

        self.assertEqual(len(manifest["cases"]), 10)
        self.assertEqual(manifest["fps_values"], [1.0, 2.0])

    def test_rejects_missing_files_and_incomplete_duration_matrix(self):
        missing_file = build_manifest()
        with self.assertRaisesRegex(ValueError, "does not exist"):
            validate_benchmark_manifest(missing_file, path_exists=lambda _path: False)

        missing_duration = build_manifest()
        for case in missing_duration["cases"]:
            case["duration_seconds"] = 5
        with self.assertRaisesRegex(ValueError, "5, 15, and 30"):
            validate_benchmark_manifest(missing_duration, path_exists=lambda _path: True)


class VideoVlmStructuredOutputTests(unittest.TestCase):
    def test_accepts_only_the_strict_relevance_shape(self):
        response = parse_verification_response(
            json.dumps(
                {
                    "relevance": 2,
                    "matched_constraints": ["单手比耶"],
                    "missing_constraints": [],
                    "reason": "人物短暂用一只手比耶。",
                },
                ensure_ascii=False,
            )
        )

        self.assertEqual(response["relevance"], 2)

        with self.assertRaisesRegex(ValueError, "strict JSON"):
            parse_verification_response("```json\n{}\n```")
        with self.assertRaisesRegex(ValueError, "relevance"):
            parse_verification_response(
                '{"relevance": 3, "matched_constraints": [], "missing_constraints": [], "reason": "x"}'
            )


class VideoVlmFeasibilityGateTests(unittest.TestCase):
    def test_interrupts_an_inference_that_exceeds_its_seconds_budget(self):
        with self.assertRaises(InferenceTimeoutError):
            with _inference_timeout(0.01):
                time.sleep(0.1)

    def test_passes_when_all_outputs_are_correct_fast_and_stable_at_one_fps(self):
        results = []
        for case in build_manifest()["cases"]:
            for fps in (1.0, 2.0):
                results.append(
                    {
                        "case_id": case["id"],
                        "duration_seconds": float(case["duration_seconds"]),
                        "fps": fps,
                        "inference_seconds": 20.0,
                        "expected_relevance": 2,
                        "relevance": 2,
                        "transient_action": case["transient_action"],
                        "failure_type": None,
                    }
                )

        gate = evaluate_feasibility_gate(results)

        self.assertTrue(gate["automatic_gate_passed"])
        self.assertEqual(gate["worst_top3_30_second_total_seconds"], 60.0)

    def test_fails_for_slow_thirty_second_video_or_low_fps_transient_miss(self):
        results = [
            {
                "case_id": "transient",
                "duration_seconds": 30.0,
                "fps": 1.0,
                "inference_seconds": 61.0,
                "expected_relevance": 2,
                "relevance": 0,
                "transient_action": True,
                "failure_type": None,
            },
            {
                "case_id": "transient",
                "duration_seconds": 30.0,
                "fps": 2.0,
                "inference_seconds": 40.0,
                "expected_relevance": 2,
                "relevance": 2,
                "transient_action": True,
                "failure_type": None,
            },
        ]

        gate = evaluate_feasibility_gate(results)

        self.assertFalse(gate["automatic_gate_passed"])
        self.assertFalse(gate["all_30_second_inferences_within_60_seconds"])
        self.assertFalse(gate["one_fps_preserves_transient_actions"])


if __name__ == "__main__":
    unittest.main()
