"""Freeze Phase 9A-C2 human reference labels after explicit adjudication.

The command validates the frozen packet, both independent browser exports, and one
human-confirmed decision for every atomic disagreement. It writes a single audit
bundle containing all inputs, agreement metrics, adjudication, and the final 30-case
reference. It never connects to PostgreSQL, Qdrant, or a model provider.
"""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

from .json_artifacts import ensure_distinct_output_path, read_json, write_json_atomically
from .phase9a_c2_blind_dataset import (
    calculate_annotation_agreement,
    derive_atomic_judgment,
    validate_annotation_export,
    validate_blind_packet,
)


HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _canonical_sha256(value):
    """Return a stable digest independent of JSON key order and indentation."""
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _validate_decision(case, decision):
    """Validate one full atomic decision and derive its non-editable relevance."""
    if not isinstance(decision, dict):
        raise ValueError(f"{case['id']} adjudication must be an object")
    must_have = decision.get("must_have")
    exclusions = decision.get("exclusions")
    notes = decision.get("notes")
    allowed = {"yes", "no", "uncertain"}
    if (
        not isinstance(must_have, list)
        or len(must_have) != len(case["must_have"])
        or any(answer not in allowed for answer in must_have)
    ):
        raise ValueError(f"{case['id']} adjudication must_have answers are invalid")
    if (
        not isinstance(exclusions, list)
        or len(exclusions) != len(case["exclusions"])
        or any(answer not in allowed for answer in exclusions)
    ):
        raise ValueError(f"{case['id']} adjudication exclusion answers are invalid")
    if not isinstance(notes, str) or not notes.strip() or len(notes) > 1000:
        raise ValueError(f"{case['id']} adjudication notes must explain the visible evidence")
    return {
        "must_have": list(must_have),
        "exclusions": list(exclusions),
        "notes": notes.strip(),
        **derive_atomic_judgment(must_have, exclusions),
        "source": "adjudication",
    }


def _normalize_annotation(packet, annotation):
    """Copy only the documented browser-export fields into the committed bundle."""
    return {
        "schema_version": annotation["schema_version"],
        "packet_fingerprint": annotation["packet_fingerprint"],
        "annotation_round": annotation["annotation_round"],
        "results": {
            case["id"]: {
                "case_id": case["id"],
                "must_have": list(annotation["results"][case["id"]]["must_have"]),
                "exclusions": list(annotation["results"][case["id"]]["exclusions"]),
                "notes": annotation["results"][case["id"]].get("notes", ""),
                "relevance": annotation["results"][case["id"]]["relevance"],
                "unjudgeable": annotation["results"][case["id"]]["unjudgeable"],
            }
            for case in packet["cases"]
        },
    }


def _normalize_adjudication(packet, adjudication, expected_case_ids):
    """Copy only reviewed adjudication fields in frozen packet order.

    The browser export and hand-written adjudication file are external inputs. They
    may accidentally contain local paths or future fields, so the committed audit
    bundle uses an explicit allow-list instead of copying the whole object.
    """
    normalized = {
        "schema_version": adjudication["schema_version"],
        "packet_fingerprint": adjudication["packet_fingerprint"],
        "confirmation_text": adjudication["confirmation_text"],
        "decisions": {},
    }
    confirmed_on = adjudication.get("confirmed_on")
    if confirmed_on is not None:
        if not isinstance(confirmed_on, str) or not confirmed_on.strip():
            raise ValueError("Adjudication confirmed_on must be a non-empty string")
        normalized["confirmed_on"] = confirmed_on.strip()

    for case in packet["cases"]:
        case_id = case["id"]
        if case_id not in expected_case_ids:
            continue
        decision = adjudication["decisions"][case_id]
        normalized["decisions"][case_id] = {
            "must_have": list(decision["must_have"]),
            "exclusions": list(decision["exclusions"]),
            "notes": decision["notes"].strip(),
        }
    return normalized


def finalize_reference_labels(
    packet,
    round_a,
    round_b,
    adjudication,
    *,
    annotation_a_sha256,
    annotation_b_sha256,
):
    """Return one immutable audit bundle after all disagreements are resolved.

    Cases with identical atomic answers use round A as the canonical copy. Cases with
    any atomic difference must have an explicit adjudication; neither model output nor
    the old Phase 8 label participates in this decision.
    """
    validate_blind_packet(packet)
    validate_annotation_export(packet, round_a, expected_round="A")
    validate_annotation_export(packet, round_b, expected_round="B")
    for field_name, digest in (
        ("annotation_a_sha256", annotation_a_sha256),
        ("annotation_b_sha256", annotation_b_sha256),
    ):
        if not isinstance(digest, str) or not HEX_SHA256.fullmatch(digest):
            raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")

    agreement = calculate_annotation_agreement(packet, round_a, round_b)
    if not isinstance(adjudication, dict):
        raise ValueError("Adjudication must be an object")
    if adjudication.get("schema_version") != "phase9a-c2-adjudication-v1":
        raise ValueError("Adjudication schema_version is invalid")
    if adjudication.get("packet_fingerprint") != packet["packet_fingerprint"]:
        raise ValueError("Adjudication packet_fingerprint does not match")
    if adjudication.get("confirmation_text") != "确认裁决":
        raise ValueError("Adjudication requires the user's exact confirmation text")
    decisions = adjudication.get("decisions")
    expected_decisions = set(agreement["atomic_disagreement_case_ids"])
    if not isinstance(decisions, dict) or set(decisions) != expected_decisions:
        raise ValueError("Adjudication decisions must exactly cover atomic disagreements")

    final_results = {}
    for case in packet["cases"]:
        case_id = case["id"]
        if case_id in decisions:
            final_results[case_id] = _validate_decision(case, decisions[case_id])
            continue
        # No atomic disagreement means both rounds encode the same decision. Copying
        # A is deterministic; B was already validated and compared above.
        source = round_a["results"][case_id]
        final_results[case_id] = {
            "must_have": list(source["must_have"]),
            "exclusions": list(source["exclusions"]),
            "notes": source.get("notes", ""),
            "relevance": source["relevance"],
            "unjudgeable": source["unjudgeable"],
            "source": "round_agreement",
        }

    counts = {
        str(level): sum(
            not result["unjudgeable"] and result["relevance"] == level
            for result in final_results.values()
        )
        for level in (0, 1, 2)
    }
    counts["unjudgeable"] = sum(result["unjudgeable"] for result in final_results.values())
    reference = {
        "schema_version": "phase9a-c2-frozen-reference-v1",
        "packet_fingerprint": packet["packet_fingerprint"],
        "case_count": len(final_results),
        "adjudicated_case_ids": sorted(expected_decisions),
        "label_counts": counts,
        "results": final_results,
    }
    reference["reference_fingerprint"] = _canonical_sha256(reference)
    normalized_a = _normalize_annotation(packet, round_a)
    normalized_b = _normalize_annotation(packet, round_b)
    normalized_adjudication = _normalize_adjudication(
        packet, adjudication, expected_decisions
    )
    bundle = {
        "schema_version": "phase9a-c2-human-freeze-bundle-v1",
        "packet": copy.deepcopy(packet),
        "annotation_inputs": {
            "round_a_sha256": f"sha256:{annotation_a_sha256}",
            "round_b_sha256": f"sha256:{annotation_b_sha256}",
            # Raw-byte SHA values preserve the identity of the downloaded files;
            # normalized snapshots deliberately omit undocumented extra fields.
            "round_a_normalized_fingerprint": _canonical_sha256(normalized_a),
            "round_b_normalized_fingerprint": _canonical_sha256(normalized_b),
            "round_a": normalized_a,
            "round_b": normalized_b,
        },
        "agreement": agreement,
        "adjudication_fingerprint": _canonical_sha256(normalized_adjudication),
        "adjudication": normalized_adjudication,
        "reference": reference,
        "database_writes": 0,
        "cloud_calls": 0,
    }
    # The bundle fingerprint covers every preceding field, including both raw-file
    # hashes and normalized snapshots. Recomputing it therefore exposes replacement
    # of an input file, a decision, an agreement metric, or the final reference.
    bundle["bundle_fingerprint"] = _canonical_sha256(bundle)
    return bundle


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Freeze Phase 9A-C2 human reference labels")
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--annotation-a", type=Path, required=True)
    parser.add_argument("--annotation-b", type=Path, required=True)
    parser.add_argument("--adjudication", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv=None):
    """Validate local inputs and atomically write the frozen audit bundle."""
    args = parse_args(argv)
    input_paths = [args.packet, args.annotation_a, args.annotation_b, args.adjudication]
    ensure_distinct_output_path(args.output, input_paths)
    round_a_bytes = args.annotation_a.read_bytes()
    round_b_bytes = args.annotation_b.read_bytes()
    bundle = finalize_reference_labels(
        read_json(args.packet),
        json.loads(round_a_bytes.decode("utf-8")),
        json.loads(round_b_bytes.decode("utf-8")),
        read_json(args.adjudication),
        annotation_a_sha256=hashlib.sha256(round_a_bytes).hexdigest(),
        annotation_b_sha256=hashlib.sha256(round_b_bytes).hexdigest(),
    )
    write_json_atomically(bundle, args.output)
    reference = bundle["reference"]
    print(
        json.dumps(
            {
                "output": str(args.output),
                "case_count": reference["case_count"],
                "label_counts": reference["label_counts"],
                "reference_fingerprint": reference["reference_fingerprint"],
                "bundle_fingerprint": bundle["bundle_fingerprint"],
                "database_writes": 0,
                "cloud_calls": 0,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
