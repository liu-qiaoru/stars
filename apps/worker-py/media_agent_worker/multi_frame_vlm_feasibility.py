"""Run the isolated Phase 9A multi-frame Ollama feasibility gate.

This command reads one frozen experiment manifest and the immutable Phase 8 snapshot
from PostgreSQL, extracts query-related frames from source videos into a temporary
directory, and calls the local Ollama Qwen2.5-VL model. It never claims Worker jobs,
writes Qdrant, changes production ranking, or stores temporary images in the media
library. Every success and failure path exits the temporary-directory context so frame
files are removed before the report is returned.

The module deliberately remains separate from the Phase 9B production job handler.
Phase 9A must first prove correctness, stability, latency, and memory limits; a failed
spike must not accidentally expose an unfinished production capability.
"""

import argparse
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from urllib import error as urllib_error
from urllib import request as urllib_request

from PIL import Image

from .env import load_project_env
from .repository import connect_from_env
from .video_vlm_feasibility import parse_verification_response


PHASE8_FORMAL_RUN_ID = "6298b745-d9d3-44bf-86a0-2d0a0b46360c"
MANIFEST_SCHEMA_VERSION = "phase9a-multi-frame-v1"
HUMAN_REVIEW_SCHEMA_VERSION = "phase9a-human-review-v1"
PROMPT_VERSION = "frame-verify-v1"
MAX_FRAMES = 12
UNIFORM_FRAME_LIMIT = 5
LOCAL_FRAME_LIMIT = 5
MOTION_PEAK_LIMIT = 2
LOCAL_STEP_SECONDS = 0.5
MOTION_STEP_SECONDS = 0.5
MAX_SINGLE_30_SECOND_INFERENCE_SECONDS = 60.0
MAX_TOP3_30_SECOND_TOTAL_SECONDS = 180.0
GIBIBYTE = 1024**3
MAX_PEAK_SWAP_GROWTH_BYTES = 4 * GIBIBYTE
MAX_END_SWAP_GROWTH_BYTES = 1 * GIBIBYTE
RESOURCE_CLEANUP_COOLDOWN_SECONDS = 10.0
SAFE_CASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
STRICT_OLLAMA_FORMAT = {
    "type": "object",
    "properties": {
        "relevance": {"type": "integer", "enum": [0, 1, 2]},
        "matched_constraints": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
        },
        "missing_constraints": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
        },
        "reason": {"type": "string", "minLength": 1},
    },
    "required": [
        "relevance",
        "matched_constraints",
        "missing_constraints",
        "reason",
    ],
    "additionalProperties": False,
}


def validate_phase9a_manifest(data):
    """Validate the experiment definition before any model output is observed.

    The manifest freezes candidate identities, human relevance labels, runtime model
    digest, repeat count, and the Caption-only comparison rule. Requiring both source
    groups and three 30-second cases prevents a convenient post-hoc sample from being
    substituted after latency or quality results are known.
    """
    if not isinstance(data, dict):
        raise ValueError("Phase 9A manifest must be a JSON object")
    if data.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {MANIFEST_SCHEMA_VERSION}")
    if data.get("phase8_run_id") != PHASE8_FORMAL_RUN_ID:
        raise ValueError(f"phase8_run_id must be the formal run {PHASE8_FORMAL_RUN_ID}")
    model = data.get("ollama_model")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("ollama_model must be a non-empty string")
    digest = data.get("ollama_digest")
    if not isinstance(digest, str) or not HEX_DIGEST.fullmatch(digest):
        raise ValueError("ollama_digest must be a 64-character lowercase SHA-256 digest")
    if data.get("prompt_version") != PROMPT_VERSION:
        raise ValueError(f"prompt_version must be {PROMPT_VERSION}")
    if data.get("repeat_count") != 3:
        raise ValueError("repeat_count must be exactly 3")

    group_gate = data.get("source_group_gate")
    if not isinstance(group_gate, dict):
        raise ValueError("source_group_gate must be an object")
    minimum_cases = group_gate.get("minimum_cases_per_group")
    maximum_gap = group_gate.get("maximum_caption_only_accuracy_gap")
    if type(minimum_cases) is not int or minimum_cases < 3:
        raise ValueError("minimum_cases_per_group must be an integer of at least 3")
    if not _is_finite_number(maximum_gap) or not 0 <= float(maximum_gap) <= 1:
        raise ValueError("maximum_caption_only_accuracy_gap must be between 0 and 1")

    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or len(raw_cases) < 12:
        raise ValueError("Phase 9A manifest must contain at least 12 frozen cases")
    cases = []
    seen_ids = set()
    seen_pairs = set()
    group_counts = {"caption_only": 0, "siglip_visual": 0}
    thirty_second_count = 0
    short_scene_count = 0
    relevance_values = set()
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict):
            raise ValueError(f"cases[{index}] must be an object")
        case_id = raw_case.get("id")
        if not isinstance(case_id, str) or not SAFE_CASE_ID.fullmatch(case_id):
            raise ValueError(f"cases[{index}].id must be a safe filename component")
        if case_id in seen_ids:
            raise ValueError(f"Duplicate case id: {case_id}")
        seen_ids.add(case_id)
        query_id = raw_case.get("query_id")
        candidate_key = raw_case.get("candidate_key")
        if not isinstance(query_id, str) or not UUID_PATTERN.fullmatch(query_id):
            raise ValueError(f"{case_id}.query_id must be a UUID")
        if not isinstance(candidate_key, str) or not UUID_PATTERN.fullmatch(candidate_key):
            raise ValueError(f"{case_id}.candidate_key must be a video scene UUID")
        pair = (query_id, candidate_key)
        if pair in seen_pairs:
            raise ValueError(f"Duplicate query/candidate pair: {case_id}")
        seen_pairs.add(pair)
        relevance = raw_case.get("expected_relevance")
        if type(relevance) is not int or relevance not in (0, 1, 2):
            raise ValueError(f"{case_id}.expected_relevance must be 0, 1, or 2")
        relevance_values.add(relevance)
        tags = raw_case.get("coverage_tags")
        if not isinstance(tags, list) or any(
            not isinstance(tag, str) or not tag.strip() for tag in tags
        ):
            raise ValueError(f"{case_id}.coverage_tags must be non-empty strings")
        normalized_tags = sorted(set(tags))
        source_groups = set(normalized_tags) & set(group_counts)
        if len(source_groups) != 1:
            raise ValueError(
                f"{case_id} must declare exactly one of caption_only or siglip_visual"
            )
        group_counts[next(iter(source_groups))] += 1
        thirty_second_count += int("thirty_second" in normalized_tags)
        short_scene_count += int("short_scene" in normalized_tags)
        cases.append(
            {
                "id": case_id,
                "query_id": query_id.lower(),
                "candidate_key": candidate_key.lower(),
                "expected_relevance": relevance,
                "coverage_tags": normalized_tags,
            }
        )

    for source_group, count in group_counts.items():
        if count < minimum_cases:
            raise ValueError(
                f"Manifest requires at least {minimum_cases} {source_group} cases, got {count}"
            )
    if thirty_second_count < 3:
        raise ValueError("Manifest must contain at least three thirty_second cases")
    if short_scene_count < 3:
        raise ValueError("Manifest must contain at least three short_scene cases")
    if relevance_values != {0, 1, 2}:
        raise ValueError("Manifest must cover expected relevance levels 0, 1, and 2")

    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "phase8_run_id": PHASE8_FORMAL_RUN_ID,
        "ollama_model": model.strip(),
        "ollama_digest": digest,
        "prompt_version": PROMPT_VERSION,
        "repeat_count": 3,
        "source_group_gate": {
            "minimum_cases_per_group": minimum_cases,
            "maximum_caption_only_accuracy_gap": float(maximum_gap),
        },
        "cases": cases,
    }


def calculate_motion_peak_times(
    grayscale_frames,
    *,
    scene_start_seconds,
    step_seconds=MOTION_STEP_SECONDS,
    max_peaks=MOTION_PEAK_LIMIT,
):
    """Return deterministic local peaks from low-resolution grayscale frame bytes.

    Each score is the mean absolute byte difference from the previous 0.5-second
    sample. It is only an inexpensive way to choose visually changing moments; the
    score is not query relevance and must never be exposed as an action probability.
    """
    if len(grayscale_frames) < 2 or max_peaks < 1:
        return []
    scores = []
    for index in range(1, len(grayscale_frames)):
        previous = grayscale_frames[index - 1]
        current = grayscale_frames[index]
        if len(previous) != len(current) or not current:
            raise ValueError("Motion scan frames must have one non-empty fixed byte size")
        score = sum(abs(left - right) for left, right in zip(previous, current)) / len(current)
        scores.append((index, score))

    local_peaks = []
    for score_index, (frame_index, score) in enumerate(scores):
        previous_score = scores[score_index - 1][1] if score_index > 0 else -1.0
        next_score = scores[score_index + 1][1] if score_index + 1 < len(scores) else -1.0
        if score >= previous_score and score >= next_score and score > 0:
            local_peaks.append((frame_index, score))
    selected = sorted(local_peaks, key=lambda item: (-item[1], item[0]))[:max_peaks]
    return sorted(
        round(float(scene_start_seconds) + frame_index * float(step_seconds), 6)
        for frame_index, _score in selected
    )


def select_frame_times(
    *,
    scene_start_seconds,
    scene_end_seconds,
    best_frame_time_seconds,
    motion_peak_times_seconds,
):
    """Select at most 12 ordered in-bound times with auditable selection reasons.

    Uniform samples protect whole-scene coverage. A real SigLIP2 best-frame time adds
    five local samples at 0.5-second spacing; Caption-only candidates pass ``None`` and
    never invent a midpoint hit. Motion peaks add up to two query-independent changing
    moments. Equal times merge their reasons. The frozen limits add up to at most 12
    source times (5 + 5 + 2), so exceeding 12 indicates that the experiment constants
    changed without updating the contract and must fail explicitly.
    """
    start = _finite_number(scene_start_seconds, "scene_start_seconds")
    end = _finite_number(scene_end_seconds, "scene_end_seconds")
    if start < 0 or end <= start:
        raise ValueError("Scene bounds must satisfy 0 <= start < end in seconds")
    duration = end - start
    # Keep a representable margin before the exclusive end. Using nextafter alone is
    # unsafe because the report rounds to six decimals and could display the next scene's
    # exact boundary even though the internal float was infinitesimally smaller.
    upper = end - min(0.001, duration / 1000.0)
    selected = {}

    def add(time_seconds, reason):
        bounded = min(max(float(time_seconds), start), upper)
        key = round(bounded, 6)
        selected.setdefault(key, set()).add(reason)

    uniform_count = min(UNIFORM_FRAME_LIMIT, max(1, math.ceil(duration / 6.0) + 1))
    if uniform_count == 1:
        add(start + duration / 2, "uniform_coverage")
    else:
        for index in range(uniform_count):
            add(start + (duration * index / (uniform_count - 1)), "uniform_coverage")

    if best_frame_time_seconds is not None:
        best = _finite_number(best_frame_time_seconds, "best_frame_time_seconds")
        if best < start or best >= end:
            raise ValueError("best_frame_time_seconds must be inside the scene boundary")
        local_offsets = (-1.0, -0.5, 0.0, 0.5, 1.0)[:LOCAL_FRAME_LIMIT]
        for offset in local_offsets:
            add(best + offset, "siglip_best" if offset == 0 else "siglip_best_neighbor")

    for motion_time in list(motion_peak_times_seconds)[:MOTION_PEAK_LIMIT]:
        motion = _finite_number(motion_time, "motion_peak_time_seconds")
        if start <= motion < end:
            add(motion, "motion_peak")

    rows = [
        {"time_seconds": time_seconds, "selection_reasons": sorted(reasons)}
        for time_seconds, reasons in sorted(selected.items())
    ]
    if len(rows) > MAX_FRAMES:
        raise RuntimeError("Frame selection constants exceeded the 12-frame contract")
    return rows


def build_verification_prompt(query, frame_evidence):
    """Build the fixed Chinese prompt that maps each image to an absolute scene time."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if not frame_evidence or len(frame_evidence) > MAX_FRAMES:
        raise ValueError(f"frame_evidence must contain 1 to {MAX_FRAMES} rows")
    mapping = "\n".join(
        f"- 图片 {row['frame_index']} = 场景绝对时间 {float(row['time_seconds']):.3f} 秒"
        for row in frame_evidence
    )
    return f"""你是本地视频检索的多帧复核器。以下图片来自同一视频场景，并已按时间从早到晚排列。

用户查询：{query.strip()}

时间对应：
{mapping}

只能依据这些图片中真实可见的证据判断，不得推断未采样瞬间或图片之间未展示的事件，
不得使用音频条件，也不得把 Caption 或常识当作画面事实。

relevance 只能是：
- 2：人物、物体、动作、关系和环境约束都明确匹配；
- 1：核心意图部分匹配，或关键约束证据不完整；
- 0：关键约束缺失或冲突。

只输出严格 JSON，字段只能是 relevance、matched_constraints、missing_constraints、reason。"""


def classify_source_group(source_ranks):
    """Separate real visual hits from candidates recalled only by Caption text.

    A candidate may appear in more than one Phase 8 channel. Any visual rank means a
    real SigLIP2 best-hit time may be used; Caption without visual evidence is the
    Caption-only group. Transcript-only or empty evidence is outside the frozen Phase
    9A experiment and must fail instead of being mislabeled as a visual candidate.
    """
    if not isinstance(source_ranks, dict):
        raise ValueError("Phase 8 source_ranks must be an object")
    if "visual" in source_ranks:
        return "siglip_visual"
    if "caption" in source_ranks:
        return "caption_only"
    raise ValueError("Phase 9A candidate must have visual or Caption source evidence")


def apply_phase9a_gate(manifest, results, resource_metrics):
    """Calculate the automatic Phase 9A decision without hiding partial failures.

    Latency is measured in seconds and lower is better. Accuracy and stability are
    proportions from 0 to 1 and higher is better. P95 is the nearest-rank 95th
    percentile over this small experiment; it detects slow calls but is not claimed as
    a population estimate.
    """
    expected_rows = len(manifest["cases"]) * manifest["repeat_count"]
    successful = [row for row in results if row.get("failure_type") is None]
    all_calls_succeeded = len(results) == expected_rows and len(successful) == expected_rows
    all_expected_relevance_matches = all(
        row.get("relevance") == row.get("expected_relevance") for row in successful
    ) and bool(successful)
    grouped_relevance = {}
    for row in successful:
        grouped_relevance.setdefault(row["case_id"], []).append(row["relevance"])
    all_repeats_stable = (
        len(grouped_relevance) == len(manifest["cases"])
        and all(len(values) == 3 and len(set(values)) == 1 for values in grouped_relevance.values())
    )
    frame_contract_passed = all(_has_valid_frame_contract(row) for row in successful) and bool(
        successful
    )

    thirty_second_rows = [
        row for row in successful if float(row.get("duration_seconds", 0)) >= 29.5
    ]
    all_30_within_60 = len({row["case_id"] for row in thirty_second_rows}) >= 3 and all(
        float(row["inference_seconds"]) <= MAX_SINGLE_30_SECOND_INFERENCE_SECONDS
        for row in thirty_second_rows
    )
    worst_latency_by_case = {}
    for row in thirty_second_rows:
        worst_latency_by_case[row["case_id"]] = max(
            worst_latency_by_case.get(row["case_id"], 0.0),
            float(row["inference_seconds"]),
        )
    worst_top3 = sum(sorted(worst_latency_by_case.values(), reverse=True)[:3])
    worst_top3_within_180 = (
        len(worst_latency_by_case) >= 3
        and worst_top3 <= MAX_TOP3_30_SECOND_TOTAL_SECONDS
    )

    ordered_latencies = [float(row["inference_seconds"]) for row in successful]
    latencies = sorted(ordered_latencies)
    p95 = latencies[max(0, math.ceil(0.95 * len(latencies)) - 1)] if latencies else None
    hot_latencies = ordered_latencies[1:]
    source_group_metrics = {}
    for source_group in ("caption_only", "siglip_visual"):
        group_rows = [row for row in successful if row.get("source_group") == source_group]
        case_count = len({row["case_id"] for row in group_rows})
        matches = sum(row["relevance"] == row["expected_relevance"] for row in group_rows)
        source_group_metrics[source_group] = {
            "case_count": case_count,
            "repeat_count": len(group_rows),
            "accuracy": matches / len(group_rows) if group_rows else None,
        }
    caption_accuracy = source_group_metrics["caption_only"]["accuracy"]
    visual_accuracy = source_group_metrics["siglip_visual"]["accuracy"]
    minimum_cases = manifest["source_group_gate"]["minimum_cases_per_group"]
    source_groups_have_minimum_samples = all(
        metrics["case_count"] >= minimum_cases for metrics in source_group_metrics.values()
    )
    accuracy_gap = (
        visual_accuracy - caption_accuracy
        if visual_accuracy is not None and caption_accuracy is not None
        else None
    )
    caption_only_significantly_worse = (
        source_groups_have_minimum_samples
        and accuracy_gap is not None
        and accuracy_gap
        > manifest["source_group_gate"]["maximum_caption_only_accuracy_gap"]
    )

    start_swap = int(resource_metrics["start_swap_used_bytes"])
    peak_swap_growth = max(0, int(resource_metrics["peak_swap_used_bytes"]) - start_swap)
    end_swap_growth = max(0, int(resource_metrics["end_swap_used_bytes"]) - start_swap)
    swap_pressure_within_limit = (
        resource_metrics.get("cold_start_prepared") is True
        and resource_metrics.get("ollama_unload_succeeded") is True
        and peak_swap_growth <= MAX_PEAK_SWAP_GROWTH_BYTES
        and end_swap_growth <= MAX_END_SWAP_GROWTH_BYTES
    )
    normalized_resources = {
        **resource_metrics,
        "peak_swap_growth_bytes": peak_swap_growth,
        "end_swap_growth_bytes": end_swap_growth,
        "max_peak_swap_growth_bytes": MAX_PEAK_SWAP_GROWTH_BYTES,
        "max_end_swap_growth_bytes": MAX_END_SWAP_GROWTH_BYTES,
    }
    gate = {
        "all_calls_succeeded": all_calls_succeeded,
        "all_expected_relevance_matches": all_expected_relevance_matches,
        "all_repeats_stable": all_repeats_stable,
        "strict_frame_contract_passed": frame_contract_passed,
        "all_30_second_inferences_within_60_seconds": all_30_within_60,
        "worst_top3_30_second_total_seconds": round(worst_top3, 3),
        "worst_top3_within_180_seconds": worst_top3_within_180,
        "swap_pressure_within_limit": swap_pressure_within_limit,
        "cold_start_prepared": resource_metrics.get("cold_start_prepared") is True,
        "latency_summary_seconds": {
            "count": len(latencies),
            # The first actual invocation is the cold call. Using the minimum latency
            # would understate model-load cost and make reruns incomparable.
            "cold": round(ordered_latencies[0], 3) if ordered_latencies else None,
            "hot_mean": (
                round(sum(hot_latencies) / len(hot_latencies), 3)
                if hot_latencies
                else None
            ),
            "mean": round(sum(latencies) / len(latencies), 3) if latencies else None,
            "p95": round(p95, 3) if p95 is not None else None,
            "maximum": round(max(latencies), 3) if latencies else None,
        },
        "source_group_metrics": source_group_metrics,
        "source_groups_have_minimum_samples": source_groups_have_minimum_samples,
        "caption_only_accuracy_gap": accuracy_gap,
        "caption_only_significantly_worse": caption_only_significantly_worse,
        "resource_metrics": normalized_resources,
    }
    gate["automatic_gate_passed"] = all(
        (
            all_calls_succeeded,
            all_expected_relevance_matches,
            all_repeats_stable,
            frame_contract_passed,
            all_30_within_60,
            worst_top3_within_180,
            swap_pressure_within_limit,
            source_groups_have_minimum_samples,
        )
    )
    # Free-text reasons still require a person to compare them with visible frames.
    # Automatic success is necessary but never silently converted into final approval.
    gate["human_reason_review"] = "pending"
    gate["final_gate_passed"] = False
    return gate


def _has_valid_frame_contract(result):
    """Validate the evidence shape and absolute scene boundary for one model call."""
    frame_count = result.get("frame_count")
    evidence = result.get("frame_evidence")
    if (
        type(frame_count) is not int
        or not 1 <= frame_count <= MAX_FRAMES
        or not isinstance(evidence, list)
        or len(evidence) != frame_count
    ):
        return False
    try:
        start = _finite_number(result.get("scene_start_seconds"), "scene_start_seconds")
        end = _finite_number(result.get("scene_end_seconds"), "scene_end_seconds")
    except ValueError:
        return False
    if start < 0 or end <= start:
        return False

    times = []
    for expected_index, row in enumerate(evidence, start=1):
        if not isinstance(row, dict) or row.get("frame_index") != expected_index:
            return False
        try:
            frame_time = _finite_number(row.get("time_seconds"), "time_seconds")
        except ValueError:
            return False
        reasons = row.get("selection_reasons")
        content_hash = row.get("content_hash")
        if not start <= frame_time < end:
            return False
        if not isinstance(reasons, list) or not reasons or any(
            not isinstance(reason, str) or not reason for reason in reasons
        ):
            return False
        if not isinstance(content_hash, str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", content_hash
        ):
            return False
        if type(row.get("width")) is not int or row["width"] <= 0:
            return False
        if type(row.get("height")) is not int or row["height"] <= 0:
            return False
        times.append(frame_time)
    return times == sorted(set(times))


def report_review_fingerprint(report):
    """Bind a human review to one exact automatic report without circular fields.

    Human fields and ``final_gate_passed`` are excluded because they are the values the
    reviewer adds. Model outputs, frame hashes, runtime identity, timings, and every
    automatic gate input remain covered by SHA-256, so a review cannot silently move to
    a different experiment result.
    """
    if not isinstance(report, dict) or not isinstance(report.get("gate"), dict):
        raise ValueError("Phase 9A report must contain a gate object")
    reviewable = copy.deepcopy(report)
    for field in (
        "human_reason_review",
        "human_reason_review_summary",
        "final_gate_passed",
    ):
        reviewable["gate"].pop(field, None)
    encoded = json.dumps(
        reviewable,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def apply_human_review(report, review):
    """Finalize a report only after every case reason was inspected by a person."""
    if not isinstance(review, dict) or review.get("schema_version") != HUMAN_REVIEW_SCHEMA_VERSION:
        raise ValueError(f"Human review schema_version must be {HUMAN_REVIEW_SCHEMA_VERSION}")
    expected_fingerprint = report_review_fingerprint(report)
    if review.get("report_fingerprint") != expected_fingerprint:
        raise ValueError("Human review fingerprint does not match the automatic report")
    decision = review.get("decision")
    if decision not in ("passed", "failed"):
        raise ValueError("Human review decision must be passed or failed")

    case_ids = sorted({row.get("case_id") for row in report.get("results", []) if row.get("case_id")})
    reviewed_case_ids = review.get("reviewed_case_ids")
    if (
        not isinstance(reviewed_case_ids, list)
        or len(reviewed_case_ids) != len(set(reviewed_case_ids))
        or sorted(reviewed_case_ids) != case_ids
    ):
        raise ValueError("Human review must cover every report case exactly once")
    issue_case_ids = review.get("reason_issue_case_ids")
    ambiguous_case_ids = review.get("ambiguous_frozen_label_case_ids")
    for field_name, values in (
        ("reason_issue_case_ids", issue_case_ids),
        ("ambiguous_frozen_label_case_ids", ambiguous_case_ids),
    ):
        if not isinstance(values, list) or len(values) != len(set(values)):
            raise ValueError(f"{field_name} must be a unique case-id list")
        if not set(values).issubset(case_ids):
            raise ValueError(f"{field_name} contains a case outside this report")
    if decision == "passed" and issue_case_ids:
        raise ValueError("Human review cannot pass while reason issues remain")
    notes = review.get("notes")
    if not isinstance(notes, str) or not notes.strip():
        raise ValueError("Human review notes must be non-empty")

    finalized = copy.deepcopy(report)
    finalized["gate"]["human_reason_review"] = decision
    finalized["gate"]["human_reason_review_summary"] = {
        "reviewed_case_count": len(reviewed_case_ids),
        "reason_issue_case_count": len(issue_case_ids),
        "reason_issue_case_ids": issue_case_ids,
        "ambiguous_frozen_label_case_ids": ambiguous_case_ids,
        "notes": notes.strip(),
        "report_fingerprint": expected_fingerprint,
    }
    finalized["gate"]["final_gate_passed"] = bool(
        finalized["gate"].get("automatic_gate_passed") and decision == "passed"
    )
    return finalized


class Phase8SnapshotResolver:
    """Resolve frozen identities through PostgreSQL without changing evaluation data.

    The manifest stores only stable query/candidate UUIDs and expected labels. This
    read-only resolver joins the immutable Phase 8 candidate snapshot to its query,
    human judgment, and current media file so FFmpeg can receive a real source path.
    It returns scene bounds, source ranks, and the optional visual best-hit time; it
    never updates the evaluation run or media rows.

    A changed human label, deleted file, or mismatched file generation aborts the
    experiment. Continuing would compare the model against a different snapshot than
    the one frozen before outputs were observed and make the report irreproducible.
    """

    def __init__(self, connection):
        self.connection = connection

    def resolve(self, manifest):
        resolved = []
        with self.connection.cursor() as cursor:
            for case in manifest["cases"]:
                # evaluation_candidates is the frozen retrieval fact; the other joins
                # recover its query text, blind human label, and current file location.
                # Parameters remain separate from SQL so UUID values can never alter
                # the query structure. This statement performs no database writes.
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
                        j.relevance,
                        j.unjudgeable,
                        mf.path,
                        mf.index_generation,
                        mf.deleted_at
                    FROM evaluation_candidates c
                    JOIN evaluation_queries q ON q.id = c.query_id
                    JOIN evaluation_judgments j ON j.candidate_id = c.id
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
                    raise ValueError(f"Frozen Phase 8 candidate not found: {case['id']}")
                columns = [description.name for description in cursor.description]
                values = dict(zip(columns, row))
                if values["scene_id"] is None or str(values["scene_id"]) != case["candidate_key"]:
                    raise ValueError(f"{case['id']} is not a stable video scene candidate")
                if values["rrf_rank"] is None or not 1 <= int(values["rrf_rank"]) <= 3:
                    raise ValueError(f"{case['id']} must be an RRF Top-3 candidate")
                if values["unjudgeable"] or values["relevance"] != case["expected_relevance"]:
                    raise ValueError(f"{case['id']} human judgment changed from the manifest")
                if values["deleted_at"] is not None:
                    raise ValueError(f"{case['id']} source file is deleted")
                if values["file_generation"] != values["index_generation"]:
                    raise ValueError(f"{case['id']} search index generation changed")
                source_path = Path(values["path"]).resolve()
                if not source_path.is_file():
                    raise ValueError(f"{case['id']} source video does not exist: {source_path}")
                evidence = values["source_evidence_json"] or {}
                source_ranks = evidence.get("source_ranks") or {}
                source_group = classify_source_group(source_ranks)
                declared_group = (
                    "caption_only" if "caption_only" in case["coverage_tags"] else "siglip_visual"
                )
                if source_group != declared_group:
                    raise ValueError(f"{case['id']} source group changed from the manifest")
                best_frame = evidence.get("best_frame_time_seconds")
                if source_group == "caption_only" and best_frame is not None:
                    raise ValueError(f"{case['id']} Caption-only candidate invented a best frame")
                start = float(values["start_time_seconds"])
                end = float(values["end_time_seconds"])
                duration = end - start
                if "thirty_second" in case["coverage_tags"] and duration < 29.5:
                    raise ValueError(f"{case['id']} no longer represents a 30-second scene")
                if "short_scene" in case["coverage_tags"] and duration > 3.0:
                    raise ValueError(f"{case['id']} no longer represents a <=3-second scene")
                resolved.append(
                    {
                        **case,
                        "candidate_id": str(values["id"]),
                        "file_id": str(values["file_id"]),
                        "scene_id": str(values["scene_id"]),
                        "source_path": str(source_path),
                        "query": values["query_text"],
                        "rrf_rank": int(values["rrf_rank"]),
                        "scene_start_seconds": start,
                        "scene_end_seconds": end,
                        "duration_seconds": duration,
                        "best_frame_time_seconds": (
                            float(best_frame) if best_frame is not None else None
                        ),
                        "source_group": source_group,
                    }
                )
        return resolved


class OllamaMultiFrameClient:
    """Call local Ollama synchronously while locking the exact model digest."""

    def __init__(self, *, model, expected_digest, base_url=None, timeout_seconds=60):
        self.model = model
        self.expected_digest = expected_digest
        self.base_url = (base_url or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")
        self.timeout_seconds = float(timeout_seconds)

    def runtime_info(self):
        version = self._get_json("/api/version")
        tags = self._get_json("/api/tags")
        models = tags.get("models") if isinstance(tags, dict) else None
        match = next(
            (
                row
                for row in models or []
                if row.get("name") == self.model or row.get("model") == self.model
            ),
            None,
        )
        if not match:
            raise RuntimeError(f"Ollama model is not installed: {self.model}")
        digest = match.get("digest")
        if digest != self.expected_digest:
            raise RuntimeError(
                f"Ollama model digest mismatch: expected {self.expected_digest}, got {digest}"
            )
        return {
            "ollama_version": version.get("version"),
            "model": self.model,
            "digest": digest,
            "size_bytes": match.get("size"),
            "details": match.get("details"),
            "modified_at": match.get("modified_at"),
        }

    def verify(self, image_paths, prompt):
        encoded_images = []
        for image_path in image_paths:
            with open(image_path, "rb") as image_file:
                encoded_images.append(base64.b64encode(image_file.read()).decode("ascii"))
        payload = {
            "model": self.model,
            "prompt": prompt,
            "images": encoded_images,
            "stream": False,
            "format": STRICT_OLLAMA_FORMAT,
            "options": {"temperature": 0, "seed": 0},
        }
        started = time.perf_counter()
        response = self._request_json("/api/generate", payload, timeout=self.timeout_seconds)
        wall_seconds = time.perf_counter() - started
        raw_text = response.get("response")
        parsed = parse_verification_response(raw_text)
        return {
            **parsed,
            "raw_response": raw_text,
            "inference_seconds": round(wall_seconds, 3),
            "ollama_total_duration_seconds": _nanoseconds_to_seconds(response.get("total_duration")),
            "ollama_load_duration_seconds": _nanoseconds_to_seconds(response.get("load_duration")),
            "prompt_eval_count": response.get("prompt_eval_count"),
            "eval_count": response.get("eval_count"),
        }

    def unload(self):
        """Release this experiment's model before measuring residual memory.

        Ollama keeps recently used models resident for faster later calls. That normal
        cache is useful in production, but Phase 9A's end-memory gate asks what remains
        after the experiment. ``keep_alive: 0`` requests an immediate unload; failures
        are surfaced in the report and make the resource gate fail.
        """
        self._request_json(
            "/api/generate",
            {
                "model": self.model,
                "prompt": "",
                "stream": False,
                "keep_alive": 0,
            },
            timeout=self.timeout_seconds,
        )

    def _get_json(self, path):
        try:
            with urllib_request.urlopen(
                f"{self.base_url}{path}", timeout=self.timeout_seconds
            ) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib_error.URLError as error:
            raise RuntimeError(f"Cannot reach Ollama at {self.base_url}: {error.reason}") from error

    def _request_json(self, path, payload, *, timeout):
        request = urllib_request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
        except urllib_error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Ollama HTTP {error.code}: {body}") from error
        except urllib_error.URLError as error:
            raise RuntimeError(f"Cannot reach Ollama at {self.base_url}: {error.reason}") from error
        response_payload = json.loads(body or "{}")
        if response_payload.get("error"):
            raise RuntimeError(f"Ollama returned error: {response_payload['error']}")
        return response_payload


class SystemResourceMonitor:
    """Sample whole-system memory and swap because Ollama runs outside this process."""

    def __init__(self, interval_seconds=0.25):
        import psutil

        self.psutil = psutil
        self.interval_seconds = float(interval_seconds)
        self.samples = []
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None:
            raise RuntimeError("Resource monitor already started")
        self._record()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self.interval_seconds * 5))
        self._record()
        return {
            "start_swap_used_bytes": self.samples[0]["swap_used_bytes"],
            "peak_swap_used_bytes": max(row["swap_used_bytes"] for row in self.samples),
            "end_swap_used_bytes": self.samples[-1]["swap_used_bytes"],
            "peak_system_memory_used_bytes": max(
                row["system_memory_used_bytes"] for row in self.samples
            ),
            "sample_count": len(self.samples),
        }

    def _loop(self):
        while not self._stop.wait(self.interval_seconds):
            self._record()

    def _record(self):
        virtual = self.psutil.virtual_memory()
        swap = self.psutil.swap_memory()
        self.samples.append(
            {
                "system_memory_used_bytes": int(virtual.used),
                "swap_used_bytes": int(swap.used),
            }
        )


class MultiFrameSampler:
    """Use read-only FFmpeg commands to scan and extract temporary JPEG evidence."""

    def __init__(self, *, ffmpeg_runner=None):
        self.ffmpeg_runner = ffmpeg_runner or subprocess.run

    def prepare(self, case, case_directory):
        motion_frames = self._scan_motion(case)
        motion_times = calculate_motion_peak_times(
            motion_frames,
            scene_start_seconds=case["scene_start_seconds"],
        )
        selected = select_frame_times(
            scene_start_seconds=case["scene_start_seconds"],
            scene_end_seconds=case["scene_end_seconds"],
            best_frame_time_seconds=case["best_frame_time_seconds"],
            motion_peak_times_seconds=motion_times,
        )
        evidence = []
        seen_hashes = {}
        for index, selection in enumerate(selected, start=1):
            output_path = Path(case_directory) / f"frame-{index:02d}.jpg"
            self._extract_frame(case["source_path"], selection["time_seconds"], output_path)
            content_hash = _sha256_file(output_path)
            if content_hash in seen_hashes:
                existing = seen_hashes[content_hash]
                existing["selection_reasons"] = sorted(
                    set(existing["selection_reasons"]) | set(selection["selection_reasons"])
                )
                output_path.unlink()
                continue
            with Image.open(output_path) as image:
                width, height = image.size
                image.verify()
            row = {
                "frame_index": len(evidence) + 1,
                "time_seconds": selection["time_seconds"],
                "selection_reasons": selection["selection_reasons"],
                "content_hash": f"sha256:{content_hash}",
                "width": int(width),
                "height": int(height),
                "path": str(output_path),
            }
            evidence.append(row)
            seen_hashes[content_hash] = row
        if not evidence:
            raise RuntimeError("NO_VALID_FRAME_EVIDENCE")
        if len(evidence) > MAX_FRAMES:
            raise RuntimeError("Frame sampler exceeded the 12-frame contract")
        return evidence

    def _scan_motion(self, case):
        # -ss and -t are absolute scene start and duration in seconds. FFmpeg decodes
        # only that window, discards audio, then emits two 160x90 grayscale frames per
        # second as headerless bytes on stdout. A fixed 14,400-byte frame layout lets
        # Python calculate adjacent-frame change without saving the scan to disk.
        # Every argument is a separate list item, so a media path containing spaces or
        # shell characters is passed as data and cannot become a shell command.
        command = [
            "ffmpeg",
            "-loglevel",
            "error",
            "-ss",
            str(case["scene_start_seconds"]),
            "-i",
            case["source_path"],
            "-t",
            str(case["duration_seconds"]),
            "-an",
            "-vf",
            "fps=2,scale=160:90,format=gray",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ]
        completed = self.ffmpeg_runner(command, capture_output=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(
                _redacted_command_error(
                    "FFmpeg motion scan",
                    completed,
                    redacted_values=[case["source_path"]],
                )
            )
        frame_size = 160 * 90
        raw = completed.stdout
        return [
            raw[offset : offset + frame_size]
            for offset in range(0, len(raw) - frame_size + 1, frame_size)
        ]

    def _extract_frame(self, source_path, time_seconds, output_path):
        # -ss is the absolute source-video time in seconds. Exactly one decoded frame
        # is scaled to 640 pixels wide while preserving aspect ratio and written as a
        # temporary JPEG. The explicit argv list avoids shell interpolation; -y is safe
        # because output_path is created under this run's private temporary directory,
        # never in the source media directory.
        command = [
            "ffmpeg",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(time_seconds),
            "-i",
            source_path,
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "3",
            str(output_path),
        ]
        completed = self.ffmpeg_runner(command, capture_output=True, check=False)
        if (
            completed.returncode != 0
            or not output_path.is_file()
            or output_path.stat().st_size == 0
        ):
            raise RuntimeError(
                _redacted_command_error(
                    "FFmpeg frame extraction",
                    completed,
                    redacted_values=[source_path, str(output_path)],
                )
            )


class Phase9aRunner:
    """Execute every frozen case three times and retain failures in the report."""

    def __init__(self, manifest, cases, *, ollama_client, sampler=None):
        self.manifest = manifest
        self.cases = cases
        self.ollama_client = ollama_client
        self.sampler = sampler or MultiFrameSampler()

    def run(self):
        runtime = self.ollama_client.runtime_info()
        # The previous command may have left this model resident. Unload before the
        # baseline sample so the first inference is a real cold start and swap growth
        # is measured from an equivalent post-cleanup state.
        self.ollama_client.unload()
        time.sleep(RESOURCE_CLEANUP_COOLDOWN_SECONDS)
        monitor = SystemResourceMonitor()
        monitor.start()
        results = []
        started_wall = time.time()
        started = time.perf_counter()
        unload_error = None
        try:
            with tempfile.TemporaryDirectory(prefix="phase9a-multiframe-") as temp_root:
                for case in self.cases:
                    case_directory = Path(temp_root) / case["id"]
                    case_directory.mkdir()
                    try:
                        evidence = self.sampler.prepare(case, case_directory)
                        public_evidence = [
                            {key: value for key, value in row.items() if key != "path"}
                            for row in evidence
                        ]
                        prompt = build_verification_prompt(case["query"], public_evidence)
                        image_paths = [row["path"] for row in evidence]
                        for repeat_index in range(1, self.manifest["repeat_count"] + 1):
                            try:
                                response = self.ollama_client.verify(image_paths, prompt)
                                results.append(
                                    {
                                        **_result_identity(case, repeat_index),
                                        "frame_count": len(evidence),
                                        "frame_evidence": public_evidence,
                                        "failure_type": None,
                                        **response,
                                    }
                                )
                            except Exception as error:
                                results.append(
                                    _failed_result(case, repeat_index, error, len(evidence), public_evidence)
                                )
                    except Exception as error:
                        for repeat_index in range(1, self.manifest["repeat_count"] + 1):
                            results.append(_failed_result(case, repeat_index, error, 0, []))
        finally:
            # Ollama normally caches model weights after a request. Phase 9A measures
            # residual resource use only after explicitly releasing that cache and
            # allowing macOS a fixed interval to reclaim memory pages.
            try:
                self.ollama_client.unload()
            except Exception as error:
                unload_error = f"{type(error).__name__}: {error}"
            time.sleep(RESOURCE_CLEANUP_COOLDOWN_SECONDS)
            resource_metrics = monitor.stop()
            resource_metrics.update(
                {
                    "ollama_unload_succeeded": unload_error is None,
                    "cold_start_prepared": True,
                    "cleanup_cooldown_seconds": RESOURCE_CLEANUP_COOLDOWN_SECONDS,
                    "unload_error": unload_error,
                }
            )
        gate = apply_phase9a_gate(self.manifest, results, resource_metrics)
        return {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "phase8_run_id": self.manifest["phase8_run_id"],
            "prompt_version": self.manifest["prompt_version"],
            "sampling_fingerprint": sampling_fingerprint(),
            "runtime": runtime,
            "started_at_unix_seconds": round(started_wall, 3),
            "total_duration_seconds": round(time.perf_counter() - started, 3),
            "temporary_frames_retained": False,
            "results": results,
            "gate": gate,
        }


def sampling_fingerprint():
    """Return a stable digest of every Phase 9A sampling parameter."""
    settings = {
        "uniform_frame_limit": UNIFORM_FRAME_LIMIT,
        "local_frame_limit": LOCAL_FRAME_LIMIT,
        "local_step_seconds": LOCAL_STEP_SECONDS,
        "motion_peak_limit": MOTION_PEAK_LIMIT,
        "motion_step_seconds": MOTION_STEP_SECONDS,
        "motion_frame_size": [160, 90],
        "extracted_frame_width": 640,
        "max_frames": MAX_FRAMES,
        "deduplication": "exact_sha256",
    }
    encoded = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _result_identity(case, repeat_index):
    return {
        "case_id": case["id"],
        "query_id": case["query_id"],
        "candidate_key": case["candidate_key"],
        "repeat_index": repeat_index,
        "query": case["query"],
        "rrf_rank": case["rrf_rank"],
        "source_group": case["source_group"],
        # Absolute scene bounds travel with every repeated result so the gate can
        # independently verify that reported evidence did not cross into a neighbor.
        "scene_start_seconds": round(case["scene_start_seconds"], 6),
        "scene_end_seconds": round(case["scene_end_seconds"], 6),
        "duration_seconds": round(case["duration_seconds"], 6),
        "expected_relevance": case["expected_relevance"],
    }


def _failed_result(case, repeat_index, error, frame_count, frame_evidence):
    message = str(error)
    lowered = message.lower()
    if isinstance(error, TimeoutError) or "timed out" in lowered:
        failure_type = "VLM_TIMEOUT"
    elif "strict json" in lowered or "model response" in lowered:
        failure_type = "VLM_INVALID_RESPONSE"
    elif "ffmpeg" in lowered:
        failure_type = "FRAME_EXTRACTION_FAILED"
    elif "no_valid_frame_evidence" in lowered:
        failure_type = "NO_VALID_FRAME_EVIDENCE"
    elif "digest" in lowered:
        failure_type = "MODEL_VERSION_MISMATCH"
    else:
        failure_type = "VLM_BACKEND_UNAVAILABLE"
    return {
        **_result_identity(case, repeat_index),
        "frame_count": frame_count,
        "frame_evidence": frame_evidence,
        "failure_type": failure_type,
        "error_class": type(error).__name__,
        "error_message": message,
        "inference_seconds": 0.0,
    }


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _redacted_command_error(operation, completed, *, redacted_values):
    """Keep actionable FFmpeg diagnostics without exposing local media paths."""
    raw_stderr = getattr(completed, "stderr", b"") or b""
    if isinstance(raw_stderr, bytes):
        stderr = raw_stderr.decode("utf-8", errors="replace")
    else:
        stderr = str(raw_stderr)
    for value in redacted_values:
        if value:
            stderr = stderr.replace(str(value), "<local-path>")
    # One compact kilobyte is enough to retain codec/permission errors while keeping a
    # corrupt file from flooding the JSON report with unbounded third-party output.
    diagnostic = " ".join(stderr.split())[:1024] or "no stderr was returned"
    return (
        f"{operation} failed with exit code {getattr(completed, 'returncode', 'unknown')}: "
        f"{diagnostic}"
    )


def _nanoseconds_to_seconds(value):
    return round(float(value) / 1_000_000_000, 3) if _is_finite_number(value) else None


def _finite_number(value, field_name):
    if not _is_finite_number(value):
        raise ValueError(f"{field_name} must be a finite number")
    return float(value)


def _is_finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="Frozen Phase 9A manifest JSON")
    parser.add_argument("--output", required=True, help="Destination for the JSON report")
    parser.add_argument("--ollama-timeout-seconds", type=float, default=60.0)
    parser.add_argument(
        "--finalize-human-review",
        help=(
            "Finalize an existing --output report with a fingerprint-bound human "
            "review JSON; this mode does not call PostgreSQL, FFmpeg, or Ollama"
        ),
    )
    return parser.parse_args(argv)


def _write_json_report(output_path, report):
    """Atomically replace a report so an interrupted write cannot corrupt the file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output_file:
            temporary_path = Path(output_file.name)
            json.dump(report, output_file, ensure_ascii=False, indent=2)
            output_file.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _build_experiment_failure_report(*, manifest, stage, error, started_wall, started):
    """Preserve a reproducible setup/runtime failure instead of exiting silently."""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "phase8_run_id": manifest.get("phase8_run_id") if isinstance(manifest, dict) else None,
        "prompt_version": manifest.get("prompt_version") if isinstance(manifest, dict) else None,
        "sampling_fingerprint": sampling_fingerprint(),
        "runtime_requirement": {
            "model": manifest.get("ollama_model") if isinstance(manifest, dict) else None,
            "expected_digest": (
                manifest.get("ollama_digest") if isinstance(manifest, dict) else None
            ),
        },
        "started_at_unix_seconds": round(started_wall, 3),
        "total_duration_seconds": round(time.perf_counter() - started, 3),
        "temporary_frames_retained": False,
        "results": [],
        "failure": {
            "stage": stage,
            "error_class": type(error).__name__,
            "error_message": str(error),
        },
        "gate": {
            "automatic_gate_passed": False,
            "human_reason_review": "not_started",
            "final_gate_passed": False,
        },
    }


def _finalize_existing_report(*, manifest_path, output_path, review_path):
    """Apply a human decision to the exact automatic report it reviewed."""
    if review_path == output_path or manifest_path == output_path:
        raise ValueError("Manifest, human review, and report must use different files")
    with manifest_path.open("r", encoding="utf-8") as input_file:
        manifest = validate_phase9a_manifest(json.load(input_file))
    with output_path.open("r", encoding="utf-8") as input_file:
        report = json.load(input_file)
    with review_path.open("r", encoding="utf-8") as input_file:
        review = json.load(input_file)
    if (
        report.get("schema_version") != MANIFEST_SCHEMA_VERSION
        or report.get("phase8_run_id") != manifest["phase8_run_id"]
        or report.get("prompt_version") != manifest["prompt_version"]
        or (report.get("runtime") or {}).get("digest") != manifest["ollama_digest"]
    ):
        raise ValueError("Existing report identity does not match the frozen manifest")
    finalized = apply_human_review(report, review)
    _write_json_report(output_path, finalized)
    print(json.dumps(finalized["gate"], ensure_ascii=False, indent=2))
    return 0 if finalized["gate"]["final_gate_passed"] else 2


def main(argv=None):
    """Run or finalize Phase 9A and return zero only after both gates pass."""
    args = _parse_args(argv)
    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    if output_path.suffix.lower() != ".json":
        raise ValueError("Phase 9A report output must use a .json filename")
    if output_path == manifest_path:
        raise ValueError("Report path must not overwrite the frozen manifest")
    if args.finalize_human_review:
        return _finalize_existing_report(
            manifest_path=manifest_path,
            output_path=output_path,
            review_path=Path(args.finalize_human_review).resolve(),
        )

    manifest = None
    started_wall = time.time()
    started = time.perf_counter()
    stage = "load_environment"
    try:
        load_project_env()
        stage = "load_manifest"
        with manifest_path.open("r", encoding="utf-8") as input_file:
            manifest = validate_phase9a_manifest(json.load(input_file))
        stage = "check_ffmpeg"
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("FFmpeg is required for Phase 9A frame extraction")
        stage = "resolve_snapshot"
        connection = connect_from_env()
        try:
            cases = Phase8SnapshotResolver(connection).resolve(manifest)
        finally:
            connection.close()
        source_paths = {Path(case["source_path"]).resolve() for case in cases}
        if output_path in source_paths:
            raise ValueError("Report path must not overwrite a source video")
        stage = "run_experiment"
        client = OllamaMultiFrameClient(
            model=manifest["ollama_model"],
            expected_digest=manifest["ollama_digest"],
            timeout_seconds=args.ollama_timeout_seconds,
        )
        report = Phase9aRunner(manifest, cases, ollama_client=client).run()
    except Exception as error:
        report = _build_experiment_failure_report(
            manifest=manifest,
            stage=stage,
            error=error,
            started_wall=started_wall,
            started=started,
        )
    _write_json_report(output_path, report)
    print(json.dumps(report["gate"], ensure_ascii=False, indent=2))
    return 0 if report["gate"]["final_gate_passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
