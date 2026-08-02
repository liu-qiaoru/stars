"""Test Phase 9A-C2 cloud evaluation without sending network requests."""

import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from media_agent_worker.phase9a_c2_cloud_comparison import (
    C2_BUNDLE_FINGERPRINT,
    C2_REFERENCE_FINGERPRINT,
    Phase9aC2SnapshotResolver,
    configure_c2_read_only,
    redact_c2_failure_messages,
    summarize_c2_provider,
    validate_c2_budget,
    validate_c2_freeze_bundle,
    validate_c2_providers,
)


FREEZE_PATH = Path(
    "docs/superpowers/reports/2026-08-02-phase9a-c2-human-freeze.json"
)


class FrozenC2InputTests(unittest.TestCase):
    def test_accepts_only_the_confirmed_30_case_reference(self):
        manifest = validate_c2_freeze_bundle(json.loads(FREEZE_PATH.read_text(encoding="utf-8")))

        self.assertEqual(len(manifest["cases"]), 30)
        self.assertEqual(manifest["repeat_count"], 3)
        self.assertEqual(
            {level: sum(row["expected_relevance"] == level for row in manifest["cases"])
             for level in (0, 1, 2)},
            {0: 16, 1: 7, 2: 7},
        )
        self.assertEqual(
            manifest["bundle_fingerprint"], C2_BUNDLE_FINGERPRINT
        )
        self.assertEqual(
            manifest["reference_fingerprint"], C2_REFERENCE_FINGERPRINT
        )

    def test_rejects_a_changed_label_even_if_the_self_declared_fingerprint_is_unchanged(self):
        bundle = json.loads(FREEZE_PATH.read_text(encoding="utf-8"))
        changed = copy.deepcopy(bundle)
        first_case_id = changed["packet"]["cases"][0]["id"]
        changed["reference"]["results"][first_case_id]["relevance"] = 2

        with self.assertRaisesRegex(ValueError, "bundle fingerprint"):
            validate_c2_freeze_bundle(changed)

    def test_requires_exactly_the_two_authorized_qwen_models(self):
        self.assertEqual(
            validate_c2_providers(["qwen3-vl-plus", "qwen3-vl-flash"]),
            ["qwen3-vl-plus", "qwen3-vl-flash"],
        )
        for invalid in (
            ["qwen3-vl-plus"],
            ["qwen3-vl-plus", "qwen3-vl-flash", "qwen3-vl-flash"],
            ["qwen3-vl-plus", "qwen3-vl-flash", "glm-4.6v-flash"],
        ):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ValueError, "exactly"
            ):
                validate_c2_providers(invalid)

    def test_budget_cannot_expand_beyond_the_authorized_two_yuan(self):
        self.assertEqual(validate_c2_budget(2), 2.0)
        self.assertEqual(validate_c2_budget(0.5), 0.5)
        for invalid in (-0.01, 2.000001, float("inf")):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ValueError, "authorized"
            ):
                validate_c2_budget(invalid)

    def test_failure_messages_cannot_persist_local_paths(self):
        report = {
            "aborted": {
                "failure_type": "RuntimeError",
                "error_message": "ffmpeg failed for /Users/private/video.mp4",
            },
            "results": [
                {
                    "failure_type": "RuntimeError",
                    "error_message": "CLOUD_HTTP_ERROR: qwen returned HTTP 400",
                }
            ],
        }

        redacted = redact_c2_failure_messages(report)

        self.assertEqual(redacted["aborted"]["error_message"], "LOCAL_FAILURE_REDACTED")
        self.assertEqual(
            redacted["results"][0]["error_message"], "CLOUD_HTTP_ERROR"
        )
        self.assertNotIn("/Users/", json.dumps(redacted))


class C2MetricsTests(unittest.TestCase):
    def test_reports_majority_accuracy_stability_kappa_and_confusion(self):
        expected = {"case-a": 0, "case-b": 2}
        rows = []
        for case_id, labels in (
            ("case-a", [0, 0, 0]),
            ("case-b", [1, 2, 1]),
        ):
            for repeat_index, label in enumerate(labels, start=1):
                rows.append(
                    {
                        "case_id": case_id,
                        "repeat_index": repeat_index,
                        "expected_relevance": expected[case_id],
                        "relevance": label,
                        "failure_type": None,
                        "inference_seconds": 1.0,
                        "estimated_cost_cny": 0.01,
                    }
                )

        summary = summarize_c2_provider(
            rows,
            expected_labels=expected,
            repeat_count=3,
        )

        self.assertEqual(summary["stable_case_count"], 1)
        self.assertEqual(summary["stability_rate"], 0.5)
        self.assertEqual(summary["majority_exact_match_count"], 1)
        self.assertEqual(summary["majority_exact_accuracy"], 0.5)
        self.assertAlmostEqual(summary["repeat_level_exact_accuracy"], 4 / 6, places=6)
        self.assertEqual(summary["confusion_matrix"]["2"]["1"], 1)
        self.assertLess(summary["quadratic_weighted_kappa"], 1.0)

    def test_incomplete_calls_do_not_publish_quality_metrics(self):
        summary = summarize_c2_provider(
            [
                {
                    "case_id": "case-a",
                    "repeat_index": 1,
                    "expected_relevance": 0,
                    "relevance": 0,
                    "failure_type": None,
                    "inference_seconds": 1.0,
                    "estimated_cost_cny": 0.01,
                }
            ],
            expected_labels={"case-a": 0},
            repeat_count=3,
        )

        self.assertFalse(summary["complete"])
        self.assertIsNone(summary["majority_exact_accuracy"])
        self.assertIsNone(summary["quadratic_weighted_kappa"])


class SnapshotResolverTests(unittest.TestCase):
    def test_configures_the_database_connection_as_read_only(self):
        connection = SimpleNamespace(read_only=False)

        configured = configure_c2_read_only(connection)

        self.assertIs(configured, connection)
        self.assertTrue(connection.read_only)

    def test_resolves_media_identity_without_joining_phase8_old_judgments(self):
        """C2 新标签是唯一答案；数据库只提供视频身份、边界和本地路径。"""

        class FakeCursor:
            def __init__(self, row):
                self.row = row
                self.sql = None
                self.description = [
                    SimpleNamespace(name=name)
                    for name in (
                        "id",
                        "query_id",
                        "candidate_key",
                        "file_id",
                        "scene_id",
                        "file_generation",
                        "start_time_seconds",
                        "end_time_seconds",
                        "rrf_rank",
                        "source_evidence_json",
                        "query_text",
                        "path",
                        "index_generation",
                        "deleted_at",
                    )
                ]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, parameters):
                self.sql = sql
                self.parameters = parameters

            def fetchone(self):
                return self.row

        class FakeConnection:
            def __init__(self, cursor):
                self.fake_cursor = cursor

            def cursor(self):
                return self.fake_cursor

        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "video.mp4"
            source_path.write_bytes(b"video-placeholder")
            case = {
                "id": "c2-test",
                "query_id": "11111111-1111-4111-8111-111111111111",
                "candidate_key": "22222222-2222-4222-8222-222222222222",
                "file_id": "33333333-3333-4333-8333-333333333333",
                "scene_id": "22222222-2222-4222-8222-222222222222",
                "query": "有人在桌前",
                "start_time_seconds": 3.0,
                "end_time_seconds": 5.0,
                "expected_relevance": 1,
            }
            cursor = FakeCursor(
                (
                    "44444444-4444-4444-8444-444444444444",
                    case["query_id"],
                    case["candidate_key"],
                    case["file_id"],
                    case["scene_id"],
                    2,
                    3.0,
                    5.0,
                    4,
                    {
                        "source_ranks": {"visual": 4},
                        "best_frame_time_seconds": 4.0,
                    },
                    case["query"],
                    str(source_path),
                    2,
                    None,
                )
            )
            resolver = Phase9aC2SnapshotResolver(FakeConnection(cursor))

            resolved = resolver.resolve(
                {"phase8_run_id": "run-id", "cases": [case]}
            )

        self.assertEqual(resolved[0]["expected_relevance"], 1)
        self.assertEqual(resolved[0]["source_group"], "siglip_visual")
        self.assertNotIn("evaluation_judgments", cursor.sql)
        self.assertEqual(
            cursor.parameters,
            ("run-id", case["query_id"], case["candidate_key"]),
        )


if __name__ == "__main__":
    unittest.main()
