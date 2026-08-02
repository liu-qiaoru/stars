import unittest
import json
import tempfile
from pathlib import Path

from media_agent_worker.phase9a_c2_annotation_agreement import main as agreement_main
from media_agent_worker.phase9a_c2_freeze_reference import finalize_reference_labels
from media_agent_worker.phase9a_c2_blind_dataset import (
    _load_excluded_pairs,
    _packet_fingerprint,
    build_blind_packet,
    calculate_annotation_agreement,
    derive_atomic_judgment,
    select_blind_cases,
    validate_annotation_export,
    validate_blind_packet,
)
from media_agent_worker.json_artifacts import ensure_distinct_output_path


def build_candidate(index, *, stratum, source_group, relevance, duration_bucket="standard"):
    """构造覆盖一个固定配额槽位的候选，避免测试依赖真实 PostgreSQL。"""
    duration = {"short": 2.0, "standard": 12.0, "thirty_second": 30.0}[duration_bucket]
    query_type = "known_target" if stratum == "control" else "discovery"
    category = {
        "action": "人物动作",
        "relation": "人物与物体关系",
        "control": "视频指定目标",
    }[stratum]
    return {
        "candidate_id": f"20000000-0000-4000-8000-{index:012d}",
        "query_id": f"30000000-0000-4000-8000-{index:012d}",
        "candidate_key": f"40000000-0000-4000-8000-{index:012d}",
        "file_id": f"50000000-0000-4000-8000-{index:012d}",
        "scene_id": f"40000000-0000-4000-8000-{index:012d}",
        "file_generation": 1,
        "query_text": f"测试查询 {index}",
        "query_type": query_type,
        "intent_category": category,
        "must_have": ["至少一人", "目标动作或关系成立"],
        "exclusions": ["只有物体没有人物"],
        "start_time_seconds": 10.0,
        "end_time_seconds": 10.0 + duration,
        "source_group": source_group,
        "old_relevance": relevance,
        # 这些字段只供测试泄漏守卫；输出盲标包绝不能保留。
        "source_evidence": {"caption": "私人描述", "rrf_rank": 1},
        "source_path": "/private/media/secret.mp4",
    }


def build_quota_candidates():
    """按正式 30 个槽位构造最小可满足数据，并增加可替换候选。"""
    slots = [
        # action：标签 0/1/2 = 2/5/3，Caption/SigLIP2 = 3/7。
        ("action", "caption_only", 0, "thirty_second"),
        ("action", "caption_only", 1, "short"),
        ("action", "caption_only", 2, "thirty_second"),
        ("action", "siglip_visual", 0, "short"),
        ("action", "siglip_visual", 1, "thirty_second"),
        ("action", "siglip_visual", 1, "short"),
        ("action", "siglip_visual", 1, "standard"),
        ("action", "siglip_visual", 1, "standard"),
        ("action", "siglip_visual", 2, "thirty_second"),
        ("action", "siglip_visual", 2, "standard"),
        # relation：标签 0/1/2 = 3/5/2，Caption/SigLIP2 = 3/7。
        ("relation", "caption_only", 0, "thirty_second"),
        ("relation", "caption_only", 1, "short"),
        ("relation", "caption_only", 2, "standard"),
        ("relation", "siglip_visual", 0, "short"),
        ("relation", "siglip_visual", 0, "standard"),
        ("relation", "siglip_visual", 1, "standard"),
        ("relation", "siglip_visual", 1, "short"),
        ("relation", "siglip_visual", 1, "standard"),
        ("relation", "siglip_visual", 1, "standard"),
        ("relation", "siglip_visual", 2, "short"),
        # control：标签 0/2 = 5/5，Caption/SigLIP2 = 2/8。
        ("control", "caption_only", 0, "standard"),
        ("control", "caption_only", 2, "standard"),
        *(("control", "siglip_visual", 0, "standard") for _ in range(4)),
        *(("control", "siglip_visual", 2, "standard") for _ in range(4)),
    ]
    return [
        build_candidate(
            index,
            stratum=stratum,
            source_group=source,
            relevance=relevance,
            duration_bucket=duration,
        )
        for index, (stratum, source, relevance, duration) in enumerate(slots, start=1)
    ]


class Phase9aC2SelectionTests(unittest.TestCase):
    def test_selects_exact_balanced_unseen_cases_deterministically(self):
        candidates = build_quota_candidates()
        old_pair = (candidates[0]["query_id"], candidates[0]["candidate_key"])
        replacement = build_candidate(
            99,
            stratum="action",
            source_group="caption_only",
            relevance=0,
            duration_bucket="thirty_second",
        )

        first = select_blind_cases(candidates + [replacement], excluded_pairs={old_pair})
        second = select_blind_cases(list(reversed(candidates + [replacement])), excluded_pairs={old_pair})

        self.assertEqual(first, second)
        self.assertEqual(len(first), 30)
        self.assertNotIn(old_pair, {(row["query_id"], row["candidate_key"]) for row in first})
        self.assertEqual(len({row["scene_id"] for row in first}), 30)
        self.assertEqual(
            {level: sum(row["old_relevance"] == level for row in first) for level in (0, 1, 2)},
            {0: 10, 1: 10, 2: 10},
        )
        self.assertEqual(sum(row["source_group"] == "caption_only" for row in first), 8)
        self.assertEqual(sum(row["source_group"] == "siglip_visual" for row in first), 22)

    def test_fails_instead_of_silently_returning_a_partial_packet(self):
        with self.assertRaisesRegex(ValueError, "quota slot"):
            select_blind_cases(build_quota_candidates()[:-1], excluded_pairs=set())


class Phase9aC2PacketTests(unittest.TestCase):
    def test_packet_hides_labels_ranks_captions_and_local_paths(self):
        selected = select_blind_cases(build_quota_candidates(), excluded_pairs=set())
        selected[0]["must_have"].append("能从口型、声音或连续画面判断人物正在讲话")
        packet = build_blind_packet(selected)
        validated = validate_blind_packet(packet)
        serialized = str(validated).lower()

        self.assertEqual(validated["schema_version"], "phase9a-c2-blind-annotation-v1")
        self.assertEqual(len(validated["cases"]), 30)
        self.assertNotIn("old_relevance", serialized)
        self.assertNotIn("rrf_rank", serialized)
        self.assertNotIn("私人描述", serialized)
        self.assertNotIn("/private/media", serialized)
        self.assertNotIn("声音", serialized)
        self.assertIn("能从口型或连续画面判断人物正在讲话", serialized)
        self.assertNotIn("relevance_commitment_counts", validated["selection_summary"])

    def test_rejects_duplicate_scene_and_accidental_forbidden_fields(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        packet["cases"][1]["scene_id"] = packet["cases"][0]["scene_id"]
        packet["packet_fingerprint"] = _packet_fingerprint(packet)
        with self.assertRaisesRegex(ValueError, "scene"):
            validate_blind_packet(packet)

        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        packet["cases"][0]["expected_relevance"] = 2
        packet["packet_fingerprint"] = _packet_fingerprint(packet)
        with self.assertRaisesRegex(ValueError, "forbidden"):
            validate_blind_packet(packet)

    def test_rejects_changed_selection_seed_or_frozen_summary_values(self):
        """防止修改固定抽样协议后仅重算指纹就伪装成原盲标包。"""
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        packet["selection_seed"] = "different-selection"
        packet["packet_fingerprint"] = _packet_fingerprint(packet)
        with self.assertRaisesRegex(ValueError, "selection_seed"):
            validate_blind_packet(packet)

        for field, changed_value in (
            ("case_count", 29),
            ("minimum_short_scene_count", 4),
            ("minimum_thirty_second_scene_count", 4),
        ):
            packet = build_blind_packet(
                select_blind_cases(build_quota_candidates(), excluded_pairs=set())
            )
            packet["selection_summary"][field] = changed_value
            packet["packet_fingerprint"] = _packet_fingerprint(packet)
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "selection_summary"
            ):
                validate_blind_packet(packet)


class Phase9aC2AgreementTests(unittest.TestCase):
    def build_annotation(self, packet, round_name, *, changed_case_id=None):
        results = {}
        for case in packet["cases"]:
            must_have = ["yes"] * len(case["must_have"])
            exclusions = ["no"] * len(case["exclusions"])
            if case["id"] == changed_case_id:
                must_have[0] = "no"
            judgment = derive_atomic_judgment(must_have, exclusions)
            results[case["id"]] = {
                "case_id": case["id"],
                "must_have": must_have,
                "exclusions": exclusions,
                **judgment,
            }
        return {
            "schema_version": "phase9a-c2-human-annotation-v1",
            "packet_fingerprint": packet["packet_fingerprint"],
            "annotation_round": round_name,
            "results": results,
        }

    def test_validates_derived_results_and_calculates_round_agreement(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        round_a = self.build_annotation(packet, "A")
        round_b = self.build_annotation(packet, "B", changed_case_id=packet["cases"][0]["id"])

        validate_annotation_export(packet, round_a, expected_round="A")
        validate_annotation_export(packet, round_b, expected_round="B")
        report = calculate_annotation_agreement(packet, round_a, round_b)

        self.assertEqual(report["exact_agreement_count"], 29)
        self.assertEqual(report["disagreement_count"], 1)
        self.assertEqual(report["disagreement_case_ids"], [packet["cases"][0]["id"]])
        self.assertLess(report["quadratic_weighted_kappa"], 1.0)

    def test_rejects_tampered_automatic_relevance(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        annotation = self.build_annotation(packet, "A")
        first = packet["cases"][0]["id"]
        annotation["results"][first]["relevance"] = 0

        with self.assertRaisesRegex(ValueError, "derived judgment"):
            validate_annotation_export(packet, annotation, expected_round="A")

    def test_cli_writes_a_machine_readable_agreement_report(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        round_a = self.build_annotation(packet, "A")
        round_b = self.build_annotation(packet, "B")
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            paths = {
                "packet": root / "packet.json",
                "a": root / "a.json",
                "b": root / "b.json",
                "report": root / "report.json",
            }
            for key, value in (("packet", packet), ("a", round_a), ("b", round_b)):
                paths[key].write_text(json.dumps(value), encoding="utf-8")

            exit_code = agreement_main(
                [
                    "--packet",
                    str(paths["packet"]),
                    "--annotation-a",
                    str(paths["a"]),
                    "--annotation-b",
                    str(paths["b"]),
                    "--output",
                    str(paths["report"]),
                ]
            )

            self.assertEqual(exit_code, 0)
            report = json.loads(paths["report"].read_text(encoding="utf-8"))
            self.assertEqual(report["exact_agreement_count"], 30)
            self.assertEqual(report["quadratic_weighted_kappa"], 1.0)

    def test_rejects_replaced_old_manifest_and_output_input_collision(self):
        original_path = Path(
            "docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json"
        )
        original = json.loads(original_path.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            tampered = root / "tampered.json"
            original["cases"][0]["candidate_key"] = "99999999-9999-4999-8999-999999999999"
            tampered.write_text(json.dumps(original), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "original frozen Phase 9A manifest"):
                _load_excluded_pairs(tampered)
            with self.assertRaisesRegex(ValueError, "must not overwrite"):
                ensure_distinct_output_path(tampered, [tampered])

    def test_freezes_only_after_every_atomic_disagreement_is_adjudicated(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        first_case = packet["cases"][0]
        round_a = self.build_annotation(packet, "A")
        round_a["undocumented_private_field"] = "/private/path-must-not-be-committed"
        round_b = self.build_annotation(packet, "B", changed_case_id=first_case["id"])
        adjudication = {
            "schema_version": "phase9a-c2-adjudication-v1",
            "packet_fingerprint": packet["packet_fingerprint"],
            "confirmation_text": "确认裁决",
            "decisions": {
                first_case["id"]: {
                    "must_have": ["yes"] * len(first_case["must_have"]),
                    "exclusions": ["no"] * len(first_case["exclusions"]),
                    "notes": "复核可见画面后确认全部必须条件成立。",
                }
            },
            "undocumented_private_field": "/private/adjudication-path",
        }

        bundle = finalize_reference_labels(
            packet,
            round_a,
            round_b,
            adjudication,
            annotation_a_sha256="a" * 64,
            annotation_b_sha256="b" * 64,
        )

        self.assertEqual(bundle["schema_version"], "phase9a-c2-human-freeze-bundle-v1")
        self.assertEqual(bundle["agreement"]["disagreement_count"], 1)
        self.assertEqual(bundle["reference"]["results"][first_case["id"]]["relevance"], 2)
        self.assertEqual(bundle["reference"]["results"][first_case["id"]]["source"], "adjudication")
        self.assertEqual(len(bundle["reference"]["results"]), 30)
        self.assertTrue(bundle["reference"]["reference_fingerprint"].startswith("sha256:"))
        self.assertNotIn("undocumented_private_field", bundle["annotation_inputs"]["round_a"])
        self.assertNotIn("undocumented_private_field", bundle["adjudication"])
        self.assertTrue(bundle["annotation_inputs"]["round_a_normalized_fingerprint"].startswith("sha256:"))
        self.assertTrue(bundle["annotation_inputs"]["round_b_normalized_fingerprint"].startswith("sha256:"))
        self.assertTrue(bundle["adjudication_fingerprint"].startswith("sha256:"))
        self.assertTrue(bundle["bundle_fingerprint"].startswith("sha256:"))

        changed_input_identity = finalize_reference_labels(
            packet,
            round_a,
            round_b,
            adjudication,
            annotation_a_sha256="c" * 64,
            annotation_b_sha256="b" * 64,
        )
        self.assertNotEqual(bundle["bundle_fingerprint"], changed_input_identity["bundle_fingerprint"])

        tampered_packet = json.loads(json.dumps(packet))
        tampered_packet["undocumented_private_field"] = "/private/packet-path"
        tampered_packet["packet_fingerprint"] = _packet_fingerprint(tampered_packet)
        with self.assertRaisesRegex(ValueError, "root fields changed"):
            finalize_reference_labels(
                tampered_packet,
                round_a,
                round_b,
                adjudication,
                annotation_a_sha256="a" * 64,
                annotation_b_sha256="b" * 64,
            )

    def test_refuses_missing_or_extra_adjudication_decisions(self):
        packet = build_blind_packet(select_blind_cases(build_quota_candidates(), excluded_pairs=set()))
        first_case = packet["cases"][0]
        round_a = self.build_annotation(packet, "A")
        round_b = self.build_annotation(packet, "B", changed_case_id=first_case["id"])
        base = {
            "schema_version": "phase9a-c2-adjudication-v1",
            "packet_fingerprint": packet["packet_fingerprint"],
            "confirmation_text": "确认裁决",
            "decisions": {},
        }

        with self.assertRaisesRegex(ValueError, "exactly cover atomic disagreements"):
            finalize_reference_labels(
                packet,
                round_a,
                round_b,
                base,
                annotation_a_sha256="a" * 64,
                annotation_b_sha256="b" * 64,
            )

        agreed_case = packet["cases"][1]
        base["decisions"] = {
            first_case["id"]: {
                "must_have": ["yes"] * len(first_case["must_have"]),
                "exclusions": ["no"] * len(first_case["exclusions"]),
                "notes": "确认。",
            },
            agreed_case["id"]: {
                "must_have": ["yes"] * len(agreed_case["must_have"]),
                "exclusions": ["no"] * len(agreed_case["exclusions"]),
                "notes": "不应覆盖无分歧样本。",
            },
        }
        with self.assertRaisesRegex(ValueError, "exactly cover atomic disagreements"):
            finalize_reference_labels(
                packet,
                round_a,
                round_b,
                base,
                annotation_a_sha256="a" * 64,
                annotation_b_sha256="b" * 64,
            )


if __name__ == "__main__":
    unittest.main()
