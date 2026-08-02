"""Evaluate the two authorized Alibaba Qwen models on Phase 9A-C2.

This command is an isolated, synchronous evaluation entry point. It accepts only the
30-case human-freeze bundle confirmed on 2026-08-02, resolves current source videos
through read-only PostgreSQL queries, and reuses the existing temporary-frame cloud
runner. It never creates Worker jobs, writes PostgreSQL or Qdrant, or changes search
ranking. Every paid request is guarded by the shared CNY budget ledger.
"""

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path

from .cloud_multi_frame_comparison import (
    BudgetLedger,
    CloudMultiFrameRunner,
    CloudVlmClient,
    DEFAULT_BUDGET_CNY,
    PROVIDERS,
    resolve_provider_endpoint,
)
from .env import load_project_env
from .json_artifacts import ensure_distinct_output_path, read_json, write_json_atomically
from .multi_frame_vlm_feasibility import classify_source_group
from .phase9a_c2_blind_dataset import validate_blind_packet
from .repository import connect_from_env


C2_BUNDLE_FINGERPRINT = (
    "sha256:dd16339029c33c275bb17d926a99c99a86304dd358f3ef1a9bcd8713e5a91a0b"
)
C2_REFERENCE_FINGERPRINT = (
    "sha256:1ebf793e56b41287d07c9fc073cef91d8713d2003bece0702716e6d2f24410ff"
)
C2_PACKET_FINGERPRINT = (
    "sha256:c016eb5a2a06500fe5e38eeb16cd9930601f89581f37836c1c2ec339406f1afc"
)
C2_PROVIDER_IDS = ("qwen3-vl-plus", "qwen3-vl-flash")
C2_REPORT_SCHEMA_VERSION = "phase9a-c2-cloud-comparison-v1"
C2_AUTHORIZED_BUDGET_CNY = 2.0


def _canonical_sha256(value):
    """Return the stable SHA-256 identity used by the human-freeze command."""
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate_c2_freeze_bundle(bundle):
    """Validate the exact confirmed bundle and derive a model-only manifest.

    The bundle contains annotations and adjudication for audit, but cloud inference
    needs only immutable case identities, user queries, scene boundaries, and final
    labels. Unknown fields or changed fingerprints fail before database or network
    access so observed model output can never influence the reference set.
    """
    expected_bundle_keys = {
        "schema_version",
        "packet",
        "annotation_inputs",
        "agreement",
        "adjudication_fingerprint",
        "adjudication",
        "reference",
        "database_writes",
        "cloud_calls",
        "bundle_fingerprint",
    }
    if not isinstance(bundle, dict) or set(bundle) != expected_bundle_keys:
        raise ValueError("Phase 9A-C2 freeze bundle fields changed")
    if bundle.get("schema_version") != "phase9a-c2-human-freeze-bundle-v1":
        raise ValueError("Phase 9A-C2 freeze bundle schema_version changed")

    fingerprint_input = copy.deepcopy(bundle)
    declared_bundle_fingerprint = fingerprint_input.pop("bundle_fingerprint", None)
    calculated_bundle_fingerprint = _canonical_sha256(fingerprint_input)
    if (
        declared_bundle_fingerprint != calculated_bundle_fingerprint
        or declared_bundle_fingerprint != C2_BUNDLE_FINGERPRINT
    ):
        raise ValueError("Phase 9A-C2 bundle fingerprint does not match the confirmed input")

    packet = validate_blind_packet(bundle["packet"])
    if packet["packet_fingerprint"] != C2_PACKET_FINGERPRINT:
        raise ValueError("Phase 9A-C2 packet fingerprint changed")
    reference = bundle.get("reference")
    expected_reference_keys = {
        "schema_version",
        "packet_fingerprint",
        "case_count",
        "adjudicated_case_ids",
        "label_counts",
        "results",
        "reference_fingerprint",
    }
    if not isinstance(reference, dict) or set(reference) != expected_reference_keys:
        raise ValueError("Phase 9A-C2 reference fields changed")
    reference_input = copy.deepcopy(reference)
    declared_reference_fingerprint = reference_input.pop("reference_fingerprint", None)
    if (
        _canonical_sha256(reference_input) != declared_reference_fingerprint
        or declared_reference_fingerprint != C2_REFERENCE_FINGERPRINT
    ):
        raise ValueError("Phase 9A-C2 reference fingerprint changed")

    results = reference.get("results")
    case_ids = [case["id"] for case in packet["cases"]]
    if (
        reference.get("case_count") != 30
        or not isinstance(results, dict)
        or set(results) != set(case_ids)
    ):
        raise ValueError("Phase 9A-C2 reference must cover all 30 packet cases")

    cases = []
    for case in packet["cases"]:
        judgment = results[case["id"]]
        relevance = judgment.get("relevance") if isinstance(judgment, dict) else None
        if judgment.get("unjudgeable") is not False or relevance not in (0, 1, 2):
            raise ValueError(f"{case['id']} must have one judgeable frozen relevance")
        cases.append(
            {
                "id": case["id"],
                "query_id": case["query_id"],
                "candidate_key": case["candidate_key"],
                "file_id": case["file_id"],
                "scene_id": case["scene_id"],
                "query": case["query"],
                "start_time_seconds": float(case["start_time_seconds"]),
                "end_time_seconds": float(case["end_time_seconds"]),
                "expected_relevance": relevance,
            }
        )

    return {
        "schema_version": "phase9a-c2-cloud-manifest-v1",
        "phase8_run_id": packet["phase8_run_id"],
        "bundle_fingerprint": declared_bundle_fingerprint,
        "packet_fingerprint": packet["packet_fingerprint"],
        "reference_fingerprint": declared_reference_fingerprint,
        "repeat_count": 3,
        "cases": cases,
    }


def validate_c2_providers(provider_ids):
    """Require exactly the two models covered by the user's upload authorization."""
    selected = list(dict.fromkeys(provider_ids))
    if len(provider_ids) != len(C2_PROVIDER_IDS) or tuple(selected) != C2_PROVIDER_IDS:
        raise ValueError(
            "Phase 9A-C2 requires exactly qwen3-vl-plus then qwen3-vl-flash"
        )
    return selected


def validate_c2_budget(value):
    """Reject any command-line budget outside the user's explicit 0–2 CNY scope."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        or value > C2_AUTHORIZED_BUDGET_CNY
    ):
        raise ValueError("Phase 9A-C2 budget must remain inside the authorized 0–2 CNY range")
    return float(value)


def configure_c2_read_only(connection):
    """Enable PostgreSQL's connection-level write guard before the first query."""
    connection.read_only = True
    if connection.read_only is not True:
        raise RuntimeError("Phase 9A-C2 PostgreSQL connection did not enter read-only mode")
    return connection


def redact_c2_failure_messages(report):
    """Keep only fixed error codes so reports cannot persist a local media path.

    Cloud client exceptions begin with a controlled ``CLOUD_*`` code. File, FFmpeg,
    Pillow, and unexpected exceptions may contain absolute input or temporary paths,
    so their free text is replaced before the report fingerprint is calculated.
    """
    redacted = copy.deepcopy(report)

    def redact(container):
        if not isinstance(container, dict) or "error_message" not in container:
            return
        message = container.get("error_message")
        code = message.split(":", 1)[0] if isinstance(message, str) else ""
        if code.startswith("CLOUD_") and code.replace("_", "").isalnum():
            container["error_message"] = code
        else:
            container["error_message"] = "LOCAL_FAILURE_REDACTED"

    redact(redacted.get("aborted"))
    for row in redacted.get("results") or []:
        redact(row)
    return redacted


class Phase9aC2SnapshotResolver:
    """Resolve frozen case identities to local files without trusting old labels.

    Phase 8's judgment is deliberately not joined because 12 of the 30 labels changed
    under the stricter C2 protocol. PostgreSQL supplies only candidate identity,
    current file state, source-channel evidence, and a local path for FFmpeg. All
    externally visible query, file, scene, and time fields must still equal the
    confirmed packet before any frame can be uploaded.
    """

    def __init__(self, connection):
        self.connection = connection

    def resolve(self, manifest):
        resolved = []
        with self.connection.cursor() as cursor:
            for case in manifest["cases"]:
                cursor.execute(
                    """
                    SELECT
                        c.id,
                        c.query_id,
                        c.candidate_key,
                        c.file_id,
                        c.scene_id,
                        c.file_generation,
                        c.start_time_seconds,
                        c.end_time_seconds,
                        c.rrf_rank,
                        c.source_evidence_json,
                        q.query_text,
                        mf.path,
                        mf.index_generation,
                        mf.deleted_at
                    FROM evaluation_candidates c
                    JOIN evaluation_queries q ON q.id = c.query_id
                    JOIN media_files mf ON mf.id = c.file_id
                    WHERE c.run_id = %s
                      AND c.query_id = %s
                      AND c.candidate_key = %s
                      AND c.media_type = 'video'
                    """,
                    (
                        manifest["phase8_run_id"],
                        case["query_id"],
                        case["candidate_key"],
                    ),
                )
                row = cursor.fetchone()
                if row is None:
                    raise ValueError(f"Frozen Phase 9A-C2 candidate not found: {case['id']}")
                columns = [description.name for description in cursor.description]
                values = dict(zip(columns, row))
                if (
                    str(values["file_id"]) != case["file_id"]
                    or str(values["scene_id"]) != case["scene_id"]
                    or str(values["candidate_key"]) != case["candidate_key"]
                ):
                    raise ValueError(f"{case['id']} candidate identity changed")
                if values["query_text"] != case["query"]:
                    raise ValueError(f"{case['id']} query text changed")
                start = float(values["start_time_seconds"])
                end = float(values["end_time_seconds"])
                if (
                    abs(start - case["start_time_seconds"]) > 1e-6
                    or abs(end - case["end_time_seconds"]) > 1e-6
                ):
                    raise ValueError(f"{case['id']} scene boundary changed")
                if values["deleted_at"] is not None:
                    raise ValueError(f"{case['id']} source file is deleted")
                if values["file_generation"] != values["index_generation"]:
                    raise ValueError(f"{case['id']} search index generation changed")
                source_path = Path(values["path"]).resolve()
                if not source_path.is_file():
                    raise ValueError(f"{case['id']} source video does not exist")

                evidence = values["source_evidence_json"] or {}
                source_group = classify_source_group(evidence.get("source_ranks") or {})
                best_frame = evidence.get("best_frame_time_seconds")
                if source_group == "caption_only" and best_frame is not None:
                    raise ValueError(f"{case['id']} Caption-only candidate invented a best frame")
                duration = end - start
                coverage_tags = [source_group]
                if duration <= 3.0:
                    coverage_tags.append("short_scene")
                if duration >= 29.5:
                    coverage_tags.append("thirty_second")
                resolved.append(
                    {
                        **case,
                        "candidate_id": str(values["id"]),
                        "source_path": str(source_path),
                        "query": values["query_text"],
                        "rrf_rank": (
                            int(values["rrf_rank"])
                            if values["rrf_rank"] is not None
                            else None
                        ),
                        "scene_start_seconds": start,
                        "scene_end_seconds": end,
                        "duration_seconds": duration,
                        "best_frame_time_seconds": (
                            float(best_frame) if best_frame is not None else None
                        ),
                        "source_group": source_group,
                        "coverage_tags": coverage_tags,
                    }
                )
        return resolved


def _quadratic_weighted_kappa(expected, predicted):
    """Compute ordinal agreement where a 0↔2 error costs more than 0↔1."""
    count = len(expected)
    if count != len(predicted) or count == 0:
        return None
    observed = [[0 for _ in range(3)] for _ in range(3)]
    expected_counts = [0, 0, 0]
    predicted_counts = [0, 0, 0]
    for truth, guess in zip(expected, predicted):
        observed[truth][guess] += 1
        expected_counts[truth] += 1
        predicted_counts[guess] += 1
    observed_disagreement = sum(
        ((truth - guess) ** 2 / 4) * observed[truth][guess]
        for truth in range(3)
        for guess in range(3)
    )
    chance_disagreement = sum(
        ((truth - guess) ** 2 / 4)
        * expected_counts[truth]
        * predicted_counts[guess]
        / count
        for truth in range(3)
        for guess in range(3)
    )
    if chance_disagreement == 0:
        return 1.0 if observed_disagreement == 0 else None
    return round(1 - observed_disagreement / chance_disagreement, 6)


def summarize_c2_provider(rows, *, expected_labels, repeat_count):
    """Summarize complete three-repeat predictions against the frozen 30 labels."""
    successful = [row for row in rows if row.get("failure_type") is None]
    expected_call_count = len(expected_labels) * repeat_count
    complete = len(successful) == expected_call_count
    by_case = {}
    for row in successful:
        by_case.setdefault(row["case_id"], []).append(row)

    majority_labels = {}
    stable_case_count = 0
    if complete:
        for case_id, truth in expected_labels.items():
            case_rows = sorted(by_case.get(case_id, []), key=lambda row: row["repeat_index"])
            labels = [row["relevance"] for row in case_rows]
            if len(labels) != repeat_count or any(label not in (0, 1, 2) for label in labels):
                complete = False
                break
            stable_case_count += int(len(set(labels)) == 1)
            majority_labels[case_id] = max((0, 1, 2), key=lambda label: labels.count(label))

    if not complete:
        return {
            "complete": False,
            "expected_call_count": expected_call_count,
            "successful_call_count": len(successful),
            "stable_case_count": None,
            "stability_rate": None,
            "majority_exact_match_count": None,
            "majority_exact_accuracy": None,
            "repeat_level_exact_accuracy": None,
            "quadratic_weighted_kappa": None,
            "confusion_matrix": None,
        }

    ordered_case_ids = list(expected_labels)
    truth_values = [expected_labels[case_id] for case_id in ordered_case_ids]
    predicted_values = [majority_labels[case_id] for case_id in ordered_case_ids]
    majority_matches = sum(
        truth == guess for truth, guess in zip(truth_values, predicted_values)
    )
    repeat_matches = sum(
        row["relevance"] == expected_labels[row["case_id"]] for row in successful
    )
    confusion = {
        str(truth): {str(guess): 0 for guess in range(3)} for truth in range(3)
    }
    for truth, guess in zip(truth_values, predicted_values):
        confusion[str(truth)][str(guess)] += 1
    return {
        "complete": True,
        "expected_call_count": expected_call_count,
        "successful_call_count": len(successful),
        "stable_case_count": stable_case_count,
        "stability_rate": round(stable_case_count / len(expected_labels), 6),
        "majority_exact_match_count": majority_matches,
        "majority_exact_accuracy": round(majority_matches / len(expected_labels), 6),
        "repeat_level_exact_accuracy": round(repeat_matches / expected_call_count, 6),
        "quadratic_weighted_kappa": _quadratic_weighted_kappa(
            truth_values, predicted_values
        ),
        "confusion_matrix": confusion,
        "majority_labels": majority_labels,
    }


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze-bundle", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--provider",
        action="append",
        choices=C2_PROVIDER_IDS,
        required=True,
        help="Pass Plus first and Flash second; both are mandatory",
    )
    parser.add_argument("--max-budget-cny", type=float, default=DEFAULT_BUDGET_CNY)
    parser.add_argument("--timeout-seconds", type=float, default=90.0)
    parser.add_argument("--confirm-external-upload", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    """Run the paid comparison and atomically persist a redacted JSON report."""
    args = _parse_args(argv)
    if not args.confirm_external_upload:
        raise RuntimeError("External upload requires --confirm-external-upload")
    freeze_path = Path(args.freeze_bundle).resolve()
    output_path = Path(args.output).resolve()
    ensure_distinct_output_path(output_path, [freeze_path])
    if output_path.suffix.lower() != ".json":
        raise ValueError("Output must be a .json report path")
    manifest = validate_c2_freeze_bundle(read_json(freeze_path))
    selected_ids = validate_c2_providers(args.provider)
    authorized_budget = validate_c2_budget(args.max_budget_cny)
    load_project_env()

    # Validate both credentials and endpoints before extracting or uploading a frame,
    # so a configuration error cannot create an incomplete paid comparison by design.
    clients = {}
    for provider_id in selected_ids:
        provider = PROVIDERS[provider_id]
        clients[provider_id] = CloudVlmClient(
            provider=provider,
            api_key=os.environ.get(provider.api_key_env),
            endpoint=resolve_provider_endpoint(provider),
            timeout_seconds=args.timeout_seconds,
        )

    connection = configure_c2_read_only(connect_from_env())
    try:
        cases = Phase9aC2SnapshotResolver(connection).resolve(manifest)
    finally:
        connection.close()
    if output_path in {Path(case["source_path"]).resolve() for case in cases}:
        raise ValueError("Report path must not overwrite a source video")

    report = CloudMultiFrameRunner(
        cases=cases,
        clients=clients,
        repeat_count=manifest["repeat_count"],
        budget=BudgetLedger(max_budget_cny=authorized_budget),
    ).run()
    report = redact_c2_failure_messages(report)
    report["schema_version"] = C2_REPORT_SCHEMA_VERSION
    report["experiment_scope"] = "phase9a_c2_unseen_30_case_qwen_comparison"
    report["freeze_identity"] = {
        "bundle_fingerprint": manifest["bundle_fingerprint"],
        "packet_fingerprint": manifest["packet_fingerprint"],
        "reference_fingerprint": manifest["reference_fingerprint"],
    }
    report["authorization"] = {
        "confirmed": True,
        "providers": selected_ids,
        "uploaded": ["temporary_jpeg_frames", "query", "frame_timestamps"],
        "maximum_budget_cny": authorized_budget,
    }
    report["declared_provider_ids"] = selected_ids
    report["execution_provider_ids"] = selected_ids
    expected_labels = {
        case["id"]: case["expected_relevance"] for case in manifest["cases"]
    }
    report["c2_quality"] = {
        provider_id: summarize_c2_provider(
            [row for row in report["results"] if row["provider_id"] == provider_id],
            expected_labels=expected_labels,
            repeat_count=manifest["repeat_count"],
        )
        for provider_id in selected_ids
    }
    report["report_fingerprint"] = _canonical_sha256(report)
    write_json_atomically(report, output_path)
    print(
        json.dumps(
            {
                "output": str(output_path),
                "budget": report["budget"],
                "c2_quality": report["c2_quality"],
                "report_fingerprint": report["report_fingerprint"],
                "aborted": report["aborted"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    complete = report["aborted"] is None and all(
        summary["complete"] for summary in report["c2_quality"].values()
    )
    return 0 if complete else 2


if __name__ == "__main__":
    raise SystemExit(main())
