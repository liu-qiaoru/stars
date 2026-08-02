"""Validate two Phase 9A-C2 human exports and write their agreement report.

This local command reads only JSON files exported by the browser. It does not connect
to PostgreSQL, Qdrant, or a model provider. A report is written only after both rounds
cover the exact frozen packet and every automatic relevance level is recomputed.
"""

import argparse
import json
from pathlib import Path

from .json_artifacts import ensure_distinct_output_path, read_json, write_json_atomically
from .phase9a_c2_blind_dataset import calculate_annotation_agreement


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Compare Phase 9A-C2 annotation rounds")
    parser.add_argument("--packet", type=Path, required=True, help="Frozen blind packet JSON")
    parser.add_argument("--annotation-a", type=Path, required=True, help="Round A export JSON")
    parser.add_argument("--annotation-b", type=Path, required=True, help="Round B export JSON")
    parser.add_argument("--output", type=Path, required=True, help="Agreement report JSON")
    return parser.parse_args(argv)


def main(argv=None):
    """Validate both rounds, calculate agreement, and return zero on full success."""
    args = parse_args(argv)
    ensure_distinct_output_path(
        args.output,
        [args.packet, args.annotation_a, args.annotation_b],
    )
    packet = read_json(args.packet)
    round_a = read_json(args.annotation_a)
    round_b = read_json(args.annotation_b)
    report = calculate_annotation_agreement(packet, round_a, round_b)
    write_json_atomically(report, args.output)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "case_count": report["case_count"],
                "exact_agreement_count": report["exact_agreement_count"],
                "disagreement_count": report["disagreement_count"],
                "quadratic_weighted_kappa": report["quadratic_weighted_kappa"],
                "database_writes": 0,
                "cloud_calls": 0,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
