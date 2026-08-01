"""Test the isolated domestic-cloud multi-frame comparison without network calls."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from media_agent_worker.cloud_multi_frame_comparison import (
    BudgetLedger,
    CloudMultiFrameRunner,
    CloudVlmClient,
    FROZEN_MANIFEST_SHA256,
    PROVIDERS,
    validate_cloud_manifest_bytes,
    validate_selected_providers,
    summarize_provider_results,
)


class FakeSampler:
    """Create one temporary JPEG-shaped file so cleanup can be asserted."""

    created_paths = []

    def prepare(self, case, case_directory):
        path = Path(case_directory) / "frame-01.jpg"
        path.write_bytes(b"fake-jpeg")
        self.created_paths.append(path)
        return [
            {
                "frame_index": 1,
                "time_seconds": case["scene_start_seconds"],
                "selection_reasons": ["uniform"],
                "content_hash": "sha256:" + "0" * 64,
                "width": 640,
                "height": 360,
                "path": str(path),
            }
        ]


class FakeClient:
    def __init__(self, provider_id, relevance=2):
        self.provider_id = provider_id
        self.relevance = relevance

    def verify(self, image_paths, prompt):
        self.last_paths = list(image_paths)
        self.last_prompt = prompt
        return {
            "relevance": self.relevance,
            "matched_constraints": ["人物"],
            "missing_constraints": [],
            "reason": "画面支持查询约束",
            "raw_response": json.dumps({"relevance": self.relevance}),
            "inference_seconds": 0.25,
            "usage": {"input_tokens": 1000, "output_tokens": 100, "total_tokens": 1100},
        }


class FailingClient:
    def __init__(self, provider_id):
        self.provider_id = provider_id
        self.call_count = 0

    def verify(self, image_paths, prompt):
        self.call_count += 1
        raise TimeoutError("provider timed out")


def build_case():
    return {
        "id": "cloud-case-1",
        "query_id": "11111111-1111-4111-8111-111111111111",
        "candidate_key": "22222222-2222-4222-8222-222222222222",
        "expected_relevance": 2,
        "coverage_tags": ["siglip_visual", "short_scene"],
        "query": "一个人在拿筷子",
        "rrf_rank": 1,
        "source_group": "siglip_visual",
        "scene_start_seconds": 3.0,
        "scene_end_seconds": 5.0,
        "duration_seconds": 2.0,
        "best_frame_time_seconds": 4.0,
        "source_path": "/private/source/video.mp4",
    }


class BudgetLedgerTests(unittest.TestCase):
    def test_reserves_worst_case_cost_before_a_paid_request(self):
        ledger = BudgetLedger(max_budget_cny=0.036)

        with self.assertRaisesRegex(RuntimeError, "CLOUD_BUDGET_EXHAUSTED"):
            ledger.reserve(PROVIDERS["qwen3-vl-plus"])

    def test_records_actual_usage_without_exposing_api_credentials(self):
        ledger = BudgetLedger(max_budget_cny=2.0)
        reservation = ledger.reserve(PROVIDERS["qwen3-vl-plus"])
        cost = ledger.commit(
            reservation,
            input_tokens=1_000,
            output_tokens=100,
        )

        self.assertAlmostEqual(cost, 0.002)
        self.assertAlmostEqual(ledger.spent_cny, 0.002)

    def test_rejects_output_beyond_the_reserved_token_limit(self):
        ledger = BudgetLedger(max_budget_cny=2.0)
        reservation = ledger.reserve(PROVIDERS["qwen3-vl-plus"])

        with self.assertRaisesRegex(RuntimeError, "CLOUD_OUTPUT_TOKEN_LIMIT_EXCEEDED"):
            ledger.commit(
                reservation,
                input_tokens=1_000,
                output_tokens=501,
            )


class FrozenInputTests(unittest.TestCase):
    def test_accepts_only_the_original_phase9a_manifest_bytes(self):
        manifest_path = Path(
            "docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json"
        )
        original = manifest_path.read_bytes()

        manifest = validate_cloud_manifest_bytes(original)

        self.assertEqual(len(manifest["cases"]), 12)
        self.assertEqual(
            FROZEN_MANIFEST_SHA256,
            "a074c5329c005c4efc478cbd189fcc15c8be0e100d535fff87ab224f0992c108",
        )
        with self.assertRaisesRegex(ValueError, "frozen Phase 9A manifest"):
            validate_cloud_manifest_bytes(original + b"\n")

    def test_formal_comparison_requires_all_three_providers(self):
        self.assertEqual(
            validate_selected_providers(list(PROVIDERS)),
            list(PROVIDERS),
        )
        with self.assertRaisesRegex(ValueError, "exactly all three"):
            validate_selected_providers(["glm-4.6v-flash"])


class CloudVlmClientTests(unittest.TestCase):
    def test_sends_base64_frames_and_strict_json_request(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "relevance": 2,
                                "matched_constraints": ["人物"],
                                "missing_constraints": [],
                                "reason": "画面支持查询约束",
                            }
                        )
                    }
                }
            ],
            "usage": {"prompt_tokens": 25, "completion_tokens": 15, "total_tokens": 40},
        }
        opened = mock.MagicMock()
        opened.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode()
        opened.return_value.__enter__.return_value.status = 200
        client = CloudVlmClient(
            provider=PROVIDERS["qwen3-vl-flash"],
            api_key="secret-key",
            urlopen=opened,
        )

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "frame.jpg"
            image_path.write_bytes(b"jpeg")
            result = client.verify([str(image_path)], "prompt")

        request = opened.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(payload["model"], "qwen3-vl-flash-2026-01-22")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["max_completion_tokens"], 500)
        self.assertFalse(payload["enable_thinking"])
        image_part = payload["messages"][0]["content"][0]
        self.assertTrue(image_part["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("secret-key", json.dumps(payload))
        self.assertEqual(result["usage"]["input_tokens"], 25)
        self.assertEqual(result["relevance"], 2)


class CloudMultiFrameRunnerTests(unittest.TestCase):
    def test_reuses_frames_across_models_and_removes_them_afterward(self):
        sampler = FakeSampler()
        clients = {
            "glm-4.6v-flash": FakeClient("glm-4.6v-flash"),
            "qwen3-vl-plus": FakeClient("qwen3-vl-plus"),
        }
        runner = CloudMultiFrameRunner(
            cases=[build_case()],
            clients=clients,
            repeat_count=3,
            sampler=sampler,
            budget=BudgetLedger(max_budget_cny=2.0),
        )

        report = runner.run()

        self.assertEqual(len(report["results"]), 6)
        self.assertFalse(report["temporary_frames_retained"])
        self.assertTrue(all(not path.exists() for path in sampler.created_paths))
        self.assertEqual(report["providers"]["glm-4.6v-flash"]["exact_case_accuracy"], 1.0)
        self.assertEqual(report["decision"], "pending_human_reason_review")

    def test_stops_after_first_unknown_cloud_charge(self):
        client = FailingClient("qwen3-vl-plus")
        runner = CloudMultiFrameRunner(
            cases=[build_case()],
            clients={"qwen3-vl-plus": client},
            repeat_count=3,
            sampler=FakeSampler(),
            budget=BudgetLedger(max_budget_cny=2.0),
        )

        report = runner.run()

        self.assertEqual(client.call_count, 1)
        self.assertEqual(report["budget"]["unpriced_failed_request_count"], 1)
        self.assertEqual(report["decision"], "incomplete_due_to_failure")


class SummaryTests(unittest.TestCase):
    def test_unstable_repeated_labels_do_not_count_as_exact_case_match(self):
        rows = [
            {
                "case_id": "a",
                "expected_relevance": 2,
                "relevance": value,
                "failure_type": None,
                "inference_seconds": 1.0,
                "estimated_cost_cny": 0.0,
            }
            for value in (2, 1, 2)
        ]

        summary = summarize_provider_results(rows, expected_case_count=1, repeat_count=3)

        self.assertEqual(summary["stable_case_count"], 0)
        self.assertEqual(summary["exact_case_match_count"], 0)
        self.assertEqual(summary["exact_case_accuracy"], 0.0)


if __name__ == "__main__":
    unittest.main()
