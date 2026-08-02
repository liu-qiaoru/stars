"""Build the local-only Phase 9A-C2 blind annotation packet.

The command reads the immutable Phase 8 PostgreSQL snapshot, deterministically
selects 30 query/video-scene pairs, and writes a JSON packet consumed by the Web
annotation page. It never writes PostgreSQL or Qdrant and deliberately strips old
human labels, retrieval ranks, generated Captions, and local file paths.

This module is separate from cloud model execution. Human labels must be exported,
adjudicated, and frozen before any new frames are sent to a model provider.
"""

import argparse
import hashlib
import json
from pathlib import Path

from .env import load_project_env
from .json_artifacts import ensure_distinct_output_path, write_json_atomically
from .multi_frame_vlm_feasibility import PHASE8_FORMAL_RUN_ID, classify_source_group
from .repository import connect_from_env


PACKET_SCHEMA_VERSION = "phase9a-c2-blind-annotation-v1"
SELECTION_SEED = "phase9a-c2-unseen-v1"
EXPECTED_CASE_COUNT = 30
OLD_MANIFEST_PATH = Path(
    "docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json"
)
# The original manifest has already been exposed to all tested models. Locking its
# exact bytes prevents `--old-manifest` from substituting another 12-row file and
# accidentally allowing an observed pair into the new blind set.
ORIGINAL_PHASE9A_MANIFEST_SHA256 = "a074c5329c005c4efc478cbd189fcc15c8be0e100d535fff87ab224f0992c108"

# Each tuple is (semantic stratum, retrieval source, old Phase 8 relevance,
# duration bucket). Old relevance is used only to balance the hidden sample; it is
# removed before the browser packet is written.
SELECTION_SLOTS = (
    # 10 action/state cases: old labels 0/1/2 = 2/5/3, sources = 3/7.
    ("action", "caption_only", 0, "thirty_second"),
    ("action", "caption_only", 1, "short"),
    ("action", "caption_only", 2, "thirty_second"),
    ("action", "siglip_visual", 0, "short"),
    ("action", "siglip_visual", 1, "thirty_second"),
    ("action", "siglip_visual", 1, "short"),
    ("action", "siglip_visual", 1, "any"),
    ("action", "siglip_visual", 1, "any"),
    ("action", "siglip_visual", 2, "thirty_second"),
    ("action", "siglip_visual", 2, "any"),
    # 10 relationship/environment cases: old labels 0/1/2 = 3/5/2, sources = 3/7.
    ("relation", "caption_only", 0, "thirty_second"),
    ("relation", "caption_only", 1, "short"),
    ("relation", "caption_only", 2, "any"),
    ("relation", "siglip_visual", 0, "short"),
    ("relation", "siglip_visual", 0, "any"),
    # 真实快照中该组合只有一个候选，且会与唯一场景/每查询最多两条规则冲突；关系组
    # 已由 Caption relevance-0 槽位覆盖 30 秒，整体仍由校验器强制至少五条长场景。
    ("relation", "siglip_visual", 1, "any"),
    ("relation", "siglip_visual", 1, "short"),
    ("relation", "siglip_visual", 1, "any"),
    ("relation", "siglip_visual", 1, "any"),
    ("relation", "siglip_visual", 2, "short"),
    # 10 clear controls: 5 old positives and 5 old negatives, sources = 2/8.
    ("control", "caption_only", 0, "any"),
    ("control", "caption_only", 2, "any"),
    *(("control", "siglip_visual", 0, "any") for _ in range(4)),
    *(("control", "siglip_visual", 2, "any") for _ in range(4)),
)


def _stable_key(seed, candidate):
    """Return a database-order-independent key for reproducible sampling."""
    identity = f"{seed}|{candidate['query_id']}|{candidate['candidate_key']}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _semantic_stratum(candidate):
    """Map frozen Phase 8 query metadata into one of the three declared strata."""
    query_type = candidate["query_type"]
    category = candidate["intent_category"]
    if query_type == "discovery" and category == "人物动作":
        return "action"
    if query_type == "discovery" and category in {
        "人物与物体关系",
        "空间关系",
        "环境主体组合",
    }:
        return "relation"
    if query_type == "known_target" and candidate["old_relevance"] in (0, 2):
        return "control"
    return None


def _duration_bucket(candidate):
    """Classify scene length using seconds from the frozen candidate snapshot."""
    duration = candidate["end_time_seconds"] - candidate["start_time_seconds"]
    if duration <= 3.0:
        return "short"
    if duration >= 29.5:
        return "thirty_second"
    return "standard"


def select_blind_cases(candidates, *, excluded_pairs, seed=SELECTION_SEED):
    """Select all 30 quota slots or fail without returning a partial experiment.

    Candidate ordering from PostgreSQL is not stable unless explicitly requested, so
    every slot sorts by a SHA-256 digest of stable UUIDs. A scene can appear only once
    and one query can contribute at most two candidates, preventing a single clip or
    query wording from dominating the small evaluation set.
    """
    normalized = []
    for candidate in candidates:
        pair = (candidate["query_id"], candidate["candidate_key"])
        if pair in excluded_pairs:
            continue
        stratum = _semantic_stratum(candidate)
        if stratum is None:
            continue
        normalized.append(
            {
                **candidate,
                "stratum": stratum,
                "duration_bucket": _duration_bucket(candidate),
            }
        )

    selected = []
    used_pairs = set()
    used_scenes = set()
    query_counts = {}
    for slot_index, (stratum, source_group, relevance, duration_bucket) in enumerate(
        SELECTION_SLOTS,
        start=1,
    ):
        eligible = []
        for candidate in normalized:
            pair = (candidate["query_id"], candidate["candidate_key"])
            if pair in used_pairs or candidate["scene_id"] in used_scenes:
                continue
            if query_counts.get(candidate["query_id"], 0) >= 2:
                continue
            if candidate["stratum"] != stratum:
                continue
            if candidate["source_group"] != source_group:
                continue
            if candidate["old_relevance"] != relevance:
                continue
            if duration_bucket != "any" and candidate["duration_bucket"] != duration_bucket:
                continue
            eligible.append(candidate)
        if not eligible:
            raise ValueError(
                "Unable to fill quota slot "
                f"{slot_index}: {stratum}/{source_group}/relevance-{relevance}/{duration_bucket}"
            )
        chosen = min(eligible, key=lambda item: _stable_key(f"{seed}:{slot_index}", item))
        selected.append(chosen)
        pair = (chosen["query_id"], chosen["candidate_key"])
        used_pairs.add(pair)
        used_scenes.add(chosen["scene_id"])
        query_counts[chosen["query_id"]] = query_counts.get(chosen["query_id"], 0) + 1

    _validate_selection(selected)
    # The annotation order is separately shuffled so it does not reveal quota order.
    return sorted(selected, key=lambda item: _stable_key(f"{seed}:blind-order", item))


def _validate_selection(selected):
    """Assert the frozen balancing rules before removing private audit fields."""
    if len(selected) != EXPECTED_CASE_COUNT:
        raise ValueError(f"Selection must contain exactly {EXPECTED_CASE_COUNT} cases")
    strata = {name: sum(row["stratum"] == name for row in selected) for name in ("action", "relation", "control")}
    if strata != {"action": 10, "relation": 10, "control": 10}:
        raise ValueError(f"Selection stratum quotas changed: {strata}")
    sources = {
        name: sum(row["source_group"] == name for row in selected)
        for name in ("caption_only", "siglip_visual")
    }
    if sources != {"caption_only": 8, "siglip_visual": 22}:
        raise ValueError(f"Selection source quotas changed: {sources}")
    levels = {level: sum(row["old_relevance"] == level for row in selected) for level in (0, 1, 2)}
    if levels != {0: 10, 1: 10, 2: 10}:
        raise ValueError(f"Selection relevance quotas changed: {levels}")
    duration_counts = {
        bucket: sum(row["duration_bucket"] == bucket for row in selected)
        for bucket in ("short", "thirty_second")
    }
    if duration_counts["short"] < 5 or duration_counts["thirty_second"] < 5:
        raise ValueError(f"Selection duration coverage is insufficient: {duration_counts}")


def build_blind_packet(selected, *, seed=SELECTION_SEED):
    """Strip sampling evidence and create the JSON consumed by the browser UI."""
    _validate_selection(selected)
    cases = []
    for index, candidate in enumerate(selected, start=1):
        short_digest = _stable_key(f"{seed}:case-id", candidate)[:8]
        cases.append(
            {
                "id": f"c2-{index:02d}-{short_digest}",
                "query_id": candidate["query_id"],
                "candidate_key": candidate["candidate_key"],
                "file_id": candidate["file_id"],
                "scene_id": candidate["scene_id"],
                "query": candidate["query_text"],
                "must_have": [_visual_only_constraint(value) for value in candidate["must_have"]],
                "exclusions": [_visual_only_constraint(value) for value in candidate["exclusions"]],
                "start_time_seconds": candidate["start_time_seconds"],
                "end_time_seconds": candidate["end_time_seconds"],
            }
        )
    packet = {
        "schema_version": PACKET_SCHEMA_VERSION,
        "phase8_run_id": PHASE8_FORMAL_RUN_ID,
        "selection_seed": seed,
        "selection_summary": {
            "case_count": EXPECTED_CASE_COUNT,
            # Old relevance counts are deliberately omitted too. Even aggregate
            # counts could encourage an annotator to force the new answers into the
            # previous distribution instead of judging the visible evidence.
            "minimum_short_scene_count": 5,
            "minimum_thirty_second_scene_count": 5,
        },
        "cases": cases,
    }
    packet["packet_fingerprint"] = _packet_fingerprint(packet)
    return validate_blind_packet(packet)


def _visual_only_constraint(value):
    """Remove the audio alternative from frozen wording for frame-only judgment."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Blind constraints must be non-empty strings")
    return value.replace("口型、声音或连续画面", "口型或连续画面").strip()


def _packet_fingerprint(packet):
    """Bind exported answers to exact case text, identities, and time boundaries."""
    unsigned = {key: value for key, value in packet.items() if key != "packet_fingerprint"}
    canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_blind_packet(packet):
    """Reject incomplete packets and accidental evidence leakage before UI use."""
    if not isinstance(packet, dict) or packet.get("schema_version") != PACKET_SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {PACKET_SCHEMA_VERSION}")
    if packet.get("phase8_run_id") != PHASE8_FORMAL_RUN_ID:
        raise ValueError("phase8_run_id must remain the frozen Phase 8 run")
    cases = packet.get("cases")
    if not isinstance(cases, list) or len(cases) != EXPECTED_CASE_COUNT:
        raise ValueError(f"Blind packet must contain exactly {EXPECTED_CASE_COUNT} cases")
    if packet.get("packet_fingerprint") != _packet_fingerprint(packet):
        raise ValueError("packet_fingerprint does not match packet content")

    forbidden_case_keys = {
        "expected_relevance",
        "old_relevance",
        "relevance",
        "rrf_rank",
        "current_rank",
        "source_evidence",
        "source_group",
        "caption",
        "path",
        "coverage_tags",
        "stratum",
    }
    ids = set()
    pairs = set()
    scenes = set()
    required_keys = {
        "id",
        "query_id",
        "candidate_key",
        "file_id",
        "scene_id",
        "query",
        "must_have",
        "exclusions",
        "start_time_seconds",
        "end_time_seconds",
    }
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("Every blind case must be an object")
        leaked = forbidden_case_keys & set(case)
        if leaked:
            raise ValueError(f"Blind case contains forbidden fields: {sorted(leaked)}")
        if set(case) != required_keys:
            raise ValueError(f"Blind case fields changed: {sorted(set(case))}")
        if not case["id"] or case["id"] in ids:
            raise ValueError("Blind case id must be unique")
        pair = (case["query_id"], case["candidate_key"])
        if pair in pairs:
            raise ValueError("Blind query/candidate pair must be unique")
        if case["scene_id"] in scenes:
            raise ValueError("Blind scene must be unique")
        if case["candidate_key"] != case["scene_id"]:
            raise ValueError("Video candidate_key must equal the stable scene id")
        if not isinstance(case["must_have"], list) or not case["must_have"]:
            raise ValueError("Every blind case needs at least one must_have constraint")
        if not isinstance(case["exclusions"], list):
            raise ValueError("Blind case exclusions must be a list")
        visual_constraints = [*case["must_have"], *case["exclusions"]]
        if any(
            not isinstance(constraint, str)
            or not constraint.strip()
            or any(audio_term in constraint for audio_term in ("声音", "音频", "语音"))
            for constraint in visual_constraints
        ):
            raise ValueError("Blind constraints must be non-empty and visually judgeable")
        start = case["start_time_seconds"]
        end = case["end_time_seconds"]
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
            raise ValueError("Blind scene times must be increasing seconds")
        ids.add(case["id"])
        pairs.add(pair)
        scenes.add(case["scene_id"])
    return packet


def derive_atomic_judgment(must_have, exclusions):
    """Apply the same fixed relevance rule used by the TypeScript annotation page."""
    answers = [*must_have, *exclusions]
    if any(answer == "uncertain" for answer in answers):
        return {"relevance": None, "unjudgeable": True}
    if any(answer == "yes" for answer in exclusions):
        return {"relevance": 0, "unjudgeable": False}
    matched_count = sum(answer == "yes" for answer in must_have)
    if matched_count == len(must_have):
        return {"relevance": 2, "unjudgeable": False}
    if matched_count > 0:
        return {"relevance": 1, "unjudgeable": False}
    return {"relevance": 0, "unjudgeable": False}


def validate_annotation_export(packet, annotation, *, expected_round):
    """Validate a complete A/B browser export and recompute every derived label."""
    validate_blind_packet(packet)
    if not isinstance(annotation, dict):
        raise ValueError("Annotation export must be an object")
    if annotation.get("schema_version") != "phase9a-c2-human-annotation-v1":
        raise ValueError("Annotation schema_version is invalid")
    if annotation.get("packet_fingerprint") != packet["packet_fingerprint"]:
        raise ValueError("Annotation packet_fingerprint does not match the blind packet")
    if annotation.get("annotation_round") != expected_round:
        raise ValueError(f"Annotation round must be {expected_round}")
    results = annotation.get("results")
    expected_ids = {case["id"] for case in packet["cases"]}
    if not isinstance(results, dict) or set(results) != expected_ids:
        raise ValueError("Annotation results must cover every blind case exactly once")

    allowed_answers = {"yes", "no", "uncertain"}
    cases_by_id = {case["id"]: case for case in packet["cases"]}
    for case_id, result in results.items():
        case = cases_by_id[case_id]
        if not isinstance(result, dict) or result.get("case_id") != case_id:
            raise ValueError(f"{case_id} result identity changed")
        must_have = result.get("must_have")
        exclusions = result.get("exclusions")
        if not isinstance(must_have, list) or len(must_have) != len(case["must_have"]):
            raise ValueError(f"{case_id} must_have answer count changed")
        if not isinstance(exclusions, list) or len(exclusions) != len(case["exclusions"]):
            raise ValueError(f"{case_id} exclusion answer count changed")
        if any(answer not in allowed_answers for answer in [*must_have, *exclusions]):
            raise ValueError(f"{case_id} contains an invalid atomic answer")
        notes = result.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 1000:
            raise ValueError(f"{case_id} notes must be a string of at most 1000 characters")
        derived = derive_atomic_judgment(must_have, exclusions)
        if result.get("relevance") != derived["relevance"] or result.get("unjudgeable") != derived[
            "unjudgeable"
        ]:
            raise ValueError(f"{case_id} derived judgment was changed after annotation")
    return annotation


def calculate_annotation_agreement(packet, round_a, round_b):
    """Compare two independent rounds and calculate quadratic weighted kappa.

    Quadratic weighted kappa gives a 0-vs-2 disagreement four times the penalty of
    an adjacent 0-vs-1 or 1-vs-2 disagreement. `unjudgeable` cases remain visible in
    exact agreement counts but are excluded from kappa because they are not ordinal
    relevance levels.
    """
    validate_annotation_export(packet, round_a, expected_round="A")
    validate_annotation_export(packet, round_b, expected_round="B")
    disagreements = []
    atomic_disagreements = []
    judgeable_pairs = []
    unjudgeable_a = 0
    unjudgeable_b = 0
    for case in packet["cases"]:
        case_id = case["id"]
        left = round_a["results"][case_id]
        right = round_b["results"][case_id]
        left_label = None if left["unjudgeable"] else left["relevance"]
        right_label = None if right["unjudgeable"] else right["relevance"]
        unjudgeable_a += int(left["unjudgeable"])
        unjudgeable_b += int(right["unjudgeable"])
        if left_label != right_label:
            disagreements.append(case_id)
        if left["must_have"] != right["must_have"] or left["exclusions"] != right["exclusions"]:
            atomic_disagreements.append(case_id)
        if left_label is not None and right_label is not None:
            judgeable_pairs.append((left_label, right_label))

    total = len(packet["cases"])
    exact_count = total - len(disagreements)
    return {
        "schema_version": "phase9a-c2-annotation-agreement-v1",
        "packet_fingerprint": packet["packet_fingerprint"],
        "case_count": total,
        "exact_agreement_count": exact_count,
        "exact_agreement_rate": exact_count / total,
        "disagreement_count": len(disagreements),
        "disagreement_case_ids": disagreements,
        "atomic_disagreement_count": len(atomic_disagreements),
        "atomic_disagreement_case_ids": atomic_disagreements,
        "round_a_unjudgeable_count": unjudgeable_a,
        "round_b_unjudgeable_count": unjudgeable_b,
        "kappa_case_count": len(judgeable_pairs),
        "quadratic_weighted_kappa": _quadratic_weighted_kappa(judgeable_pairs),
    }


def _quadratic_weighted_kappa(pairs):
    """Return chance-corrected ordinal agreement for relevance levels 0, 1, and 2."""
    if not pairs:
        return None
    count = len(pairs)
    left_counts = [sum(left == level for left, _ in pairs) for level in range(3)]
    right_counts = [sum(right == level for _, right in pairs) for level in range(3)]
    observed_disagreement = sum(((left - right) ** 2 / 4) for left, right in pairs) / count
    expected_disagreement = sum(
        ((left - right) ** 2 / 4)
        * (left_counts[left] / count)
        * (right_counts[right] / count)
        for left in range(3)
        for right in range(3)
    )
    if expected_disagreement == 0:
        return 1.0 if observed_disagreement == 0 else None
    return 1.0 - observed_disagreement / expected_disagreement


class Phase8BlindCandidateResolver:
    """Read eligible candidates without changing the frozen evaluation snapshot."""

    def __init__(self, connection):
        self.connection = connection

    def resolve(self):
        """Return current-generation, judged video candidates and private audit fields."""
        with self.connection.cursor() as cursor:
            # This SELECT joins the frozen candidate to its query, old judgment, and
            # current file generation. No UPDATE/INSERT/DELETE is issued; stale or
            # deleted media is excluded rather than silently relabeled.
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
                    c.source_evidence_json,
                    q.query_text,
                    q.query_type,
                    q.intent_category,
                    q.must_have_json,
                    q.exclusions_json,
                    j.relevance,
                    mf.index_generation
                FROM evaluation_candidates c
                JOIN evaluation_queries q ON q.id = c.query_id
                JOIN evaluation_judgments j ON j.candidate_id = c.id
                JOIN media_files mf ON mf.id = c.file_id
                WHERE c.run_id = %s
                  AND c.media_type = 'video'
                  AND c.primary_pool = true
                  AND c.scene_id IS NOT NULL
                  AND c.start_time_seconds IS NOT NULL
                  AND c.end_time_seconds IS NOT NULL
                  AND j.unjudgeable = false
                  AND j.relevance IN (0, 1, 2)
                  AND mf.deleted_at IS NULL
                  AND mf.index_generation = c.file_generation
                  AND q.intent_category NOT LIKE '%%英文配对%%'
                """,
                (PHASE8_FORMAL_RUN_ID,),
            )
            columns = [description.name for description in cursor.description]
            resolved = []
            for row in cursor.fetchall():
                values = dict(zip(columns, row))
                evidence = values["source_evidence_json"] or {}
                resolved.append(
                    {
                        "candidate_id": str(values["id"]),
                        "query_id": str(values["query_id"]),
                        "candidate_key": values["candidate_key"],
                        "file_id": str(values["file_id"]),
                        "scene_id": str(values["scene_id"]),
                        "file_generation": values["file_generation"],
                        "query_text": values["query_text"],
                        "query_type": values["query_type"],
                        "intent_category": values["intent_category"],
                        "must_have": values["must_have_json"],
                        "exclusions": values["exclusions_json"],
                        "start_time_seconds": float(values["start_time_seconds"]),
                        "end_time_seconds": float(values["end_time_seconds"]),
                        "source_group": classify_source_group(evidence.get("source_ranks") or {}),
                        "old_relevance": values["relevance"],
                    }
                )
            return resolved


def _load_excluded_pairs(path):
    """Read the old 12-case manifest so no observed pair can enter the new test."""
    raw_manifest = path.read_bytes()
    digest = hashlib.sha256(raw_manifest).hexdigest()
    if digest != ORIGINAL_PHASE9A_MANIFEST_SHA256:
        raise ValueError(
            "Old-pair exclusion requires the original frozen Phase 9A manifest "
            f"sha256:{ORIGINAL_PHASE9A_MANIFEST_SHA256}, got sha256:{digest}"
        )
    manifest = json.loads(raw_manifest.decode("utf-8"))
    cases = manifest.get("cases")
    if not isinstance(cases, list) or len(cases) != 12:
        raise ValueError("Original Phase 9A manifest must still contain exactly 12 cases")
    return {(case["query_id"], case["candidate_key"]) for case in cases}


def write_packet_atomically(packet, output_path):
    """Write a complete validated packet or leave the previous file untouched."""
    validate_blind_packet(packet)
    write_json_atomically(packet, output_path)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Build the local Phase 9A-C2 blind packet")
    parser.add_argument("--output", type=Path, required=True, help="Output JSON packet path")
    parser.add_argument(
        "--old-manifest",
        type=Path,
        default=OLD_MANIFEST_PATH,
        help="Frozen original Phase 9A manifest used only for pair exclusion",
    )
    return parser.parse_args(argv)


def main(argv=None):
    """Connect read-only, freeze the 30-case packet, and print only safe metadata."""
    args = parse_args(argv)
    ensure_distinct_output_path(args.output, [args.old_manifest])
    load_project_env()
    connection = connect_from_env()
    try:
        # PostgreSQL enforces read-only mode as a second guard in addition to using
        # only SELECT statements in the resolver.
        connection.read_only = True
        candidates = Phase8BlindCandidateResolver(connection).resolve()
        excluded_pairs = _load_excluded_pairs(args.old_manifest)
        selected = select_blind_cases(candidates, excluded_pairs=excluded_pairs)
        packet = build_blind_packet(selected)
        write_packet_atomically(packet, args.output)
    finally:
        connection.close()
    print(
        json.dumps(
            {
                "output": str(args.output),
                "case_count": len(packet["cases"]),
                "packet_fingerprint": packet["packet_fingerprint"],
                "database_writes": 0,
                "cloud_calls": 0,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
