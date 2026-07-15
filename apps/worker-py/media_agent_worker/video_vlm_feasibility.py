"""Run the isolated Qwen2.5-VL full-video feasibility gate.

This module is invoked manually with ``python -m media_agent_worker.video_vlm_feasibility``.
It does not claim PostgreSQL jobs or write Qdrant points. It clips read-only source videos
into a temporary directory, loads the official Transformers checkpoint in one process,
measures cold/hot inference and memory, and writes a JSON report for human review.
"""

import argparse
from contextlib import contextmanager
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path


DEFAULT_MODEL_NAME = "Qwen/Qwen2.5-VL-7B-Instruct"
TARGET_DURATIONS_SECONDS = {5.0, 15.0, 30.0}
TARGET_FPS_VALUES = [1.0, 2.0]
REQUIRED_COVERAGE_TAGS = {
    "transient_action",
    "person_relationship",
    "environment_constraint",
    "single_hand_peace_sign",
}
SAFE_CASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
GIBIBYTE = 1024**3
# Swap is disk-backed emergency memory. A benchmark that adds more than 4 GiB at
# peak, or leaves more than 1 GiB allocated at exit, would noticeably degrade this
# 32 GiB development Mac even if model generation happened to finish in time.
MAX_PEAK_SWAP_GROWTH_BYTES = 4 * GIBIBYTE
MAX_END_SWAP_GROWTH_BYTES = 1 * GIBIBYTE
STRICT_RESPONSE_KEYS = {
    "relevance",
    "matched_constraints",
    "missing_constraints",
    "reason",
}
VIDEO_VERIFY_PROMPT = """你是本地视频检索校验器。请观看完整视频片段，只依据画面判断用户查询是否成立。

用户查询：{query}

relevance 只能是：
- 2：人物、物体、动作、关系和环境约束都明确匹配；
- 1：只匹配一部分，或关键约束不够明确；
- 0：关键约束缺失或冲突。

只输出一个 JSON 对象，不要使用 Markdown 代码块，不要添加 JSON 之外的文字：
{{"relevance": 0, "matched_constraints": ["已匹配条件"], "missing_constraints": ["缺失或冲突条件"], "reason": "简短中文理由"}}"""


class InferenceTimeoutError(TimeoutError):
    """Raised when one model generation exceeds the product's 60-second ceiling."""


def validate_benchmark_manifest(data, *, path_exists=os.path.isfile):
    """Validate and normalize the real-video benchmark matrix.

    The input must describe at least ten distinct scenes, include 5/15/30-second
    clips plus one sub-second action, run both 1 and 2 frames per second (FPS), and
    cover the product questions listed in ``REQUIRED_COVERAGE_TAGS``. Source paths
    are checked read-only; the function never creates clips.
    """
    if not isinstance(data, dict):
        raise ValueError("Benchmark manifest must be a JSON object")

    raw_fps_values = data.get("fps_values")
    if not isinstance(raw_fps_values, list):
        raise ValueError("fps_values must be a list containing 1 and 2")
    try:
        fps_values = sorted(float(value) for value in raw_fps_values)
    except (TypeError, ValueError) as error:
        raise ValueError("fps_values must contain numeric values") from error
    if fps_values != TARGET_FPS_VALUES:
        raise ValueError("fps_values must contain exactly 1 and 2 FPS")

    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or len(raw_cases) < 10:
        raise ValueError("Benchmark manifest must contain at least 10 real scenes")

    normalized_cases = []
    seen_ids = set()
    seen_scene_keys = set()
    seen_durations = set()
    has_transient_action = False
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict):
            raise ValueError(f"cases[{index}] must be a JSON object")
        case_id = raw_case.get("id")
        if (
            not isinstance(case_id, str)
            or not SAFE_CASE_ID_PATTERN.fullmatch(case_id)
            or case_id in (".", "..")
        ):
            raise ValueError(
                f"cases[{index}].id must be a safe filename component using letters, "
                "numbers, dot, underscore, or hyphen"
            )
        if case_id in seen_ids:
            raise ValueError(f"Duplicate benchmark case id: {case_id}")
        seen_ids.add(case_id)

        source_path = raw_case.get("source_path")
        if not isinstance(source_path, str) or not path_exists(source_path):
            raise ValueError(f"Source video does not exist: {source_path}")

        start_seconds = _finite_non_negative_number(
            raw_case.get("start_seconds"), f"{case_id}.start_seconds"
        )
        duration_seconds = _finite_positive_number(
            raw_case.get("duration_seconds"), f"{case_id}.duration_seconds"
        )
        if duration_seconds > 30.0:
            raise ValueError(f"{case_id}.duration_seconds must not exceed 30 seconds")
        seen_durations.add(duration_seconds)

        query = raw_case.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError(f"{case_id}.query must be a non-empty string")
        expected_relevance = raw_case.get("expected_relevance")
        if type(expected_relevance) is not int or expected_relevance not in (0, 1, 2):
            raise ValueError(f"{case_id}.expected_relevance must be 0, 1, or 2")
        transient_action = raw_case.get("transient_action", False)
        if type(transient_action) is not bool:
            raise ValueError(f"{case_id}.transient_action must be a boolean")
        has_transient_action = has_transient_action or transient_action
        coverage_tags = raw_case.get("coverage_tags")
        if not isinstance(coverage_tags, list) or any(
            not isinstance(tag, str) or not tag.strip() for tag in coverage_tags
        ):
            raise ValueError(f"{case_id}.coverage_tags must be a list of non-empty strings")
        normalized_coverage_tags = sorted({tag.strip() for tag in coverage_tags})
        scene_key = (str(Path(source_path).resolve()), start_seconds, duration_seconds)
        if scene_key in seen_scene_keys:
            raise ValueError(f"Duplicate real scene boundary: {case_id}")
        seen_scene_keys.add(scene_key)

        normalized_cases.append(
            {
                "id": case_id,
                "source_path": str(Path(source_path).resolve()),
                "start_seconds": start_seconds,
                "duration_seconds": duration_seconds,
                "query": query.strip(),
                "expected_relevance": expected_relevance,
                "transient_action": transient_action,
                "coverage_tags": normalized_coverage_tags,
            }
        )

    if not TARGET_DURATIONS_SECONDS.issubset(seen_durations):
        raise ValueError("Benchmark cases must collectively cover 5, 15, and 30 seconds")
    if not has_transient_action:
        raise ValueError("Benchmark must include at least one transient_action case")
    if not any(case["duration_seconds"] < 1.0 for case in normalized_cases):
        raise ValueError(
            "Benchmark must include a sub-second action shorter than the 1 FPS sampling period"
        )
    present_coverage_tags = {
        tag for case in normalized_cases for tag in case["coverage_tags"]
    }
    missing_coverage_tags = REQUIRED_COVERAGE_TAGS - present_coverage_tags
    if missing_coverage_tags:
        raise ValueError(
            "Benchmark is missing required coverage tags: "
            + ", ".join(sorted(missing_coverage_tags))
        )

    return {
        "model_name": data.get("model_name", DEFAULT_MODEL_NAME),
        "model_revision": data.get("model_revision", "main"),
        "fps_values": fps_values,
        "cases": normalized_cases,
    }


def parse_verification_response(raw_text):
    """Parse the exact model contract and reject wrappers, extra keys, or loose types."""
    try:
        payload = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Model response must be strict JSON without Markdown wrappers") from error
    if not isinstance(payload, dict) or set(payload) != STRICT_RESPONSE_KEYS:
        raise ValueError(
            "Model response must contain exactly relevance, matched_constraints, "
            "missing_constraints, and reason"
        )
    if type(payload["relevance"]) is not int or payload["relevance"] not in (0, 1, 2):
        raise ValueError("Model response relevance must be 0, 1, or 2")
    for field_name in ("matched_constraints", "missing_constraints"):
        values = payload[field_name]
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise ValueError(f"Model response {field_name} must be a list of non-empty strings")
    if not isinstance(payload["reason"], str) or not payload["reason"].strip():
        raise ValueError("Model response reason must be a non-empty string")
    return payload


def evaluate_feasibility_gate(results):
    """Evaluate automatic speed, stability, and short-action requirements.

    A 30-second inference must finish within 60 seconds. The sum of the three slowest
    30-second inferences approximates the product's worst Top-3 wait and must remain
    within 180 seconds. Expected relevance is labeled before the run and compared
    automatically. A human must still inspect each free-text reason against the visible
    video, because matching a numeric label alone cannot prove that the model used the
    correct evidence.
    """
    complete_results = [result for result in results if result.get("failure_type") is None]
    all_inferences_succeeded = len(complete_results) == len(results) and bool(results)
    all_expected_relevance_matches = all(
        result.get("relevance") == result.get("expected_relevance")
        for result in complete_results
    ) and bool(complete_results)

    thirty_second_latencies = [
        float(result["inference_seconds"])
        for result in complete_results
        if float(result["duration_seconds"]) == 30.0
    ]
    all_30_within_60 = bool(thirty_second_latencies) and all(
        latency <= 60.0 for latency in thirty_second_latencies
    )
    worst_top3_total = sum(sorted(thirty_second_latencies, reverse=True)[:3])
    worst_top3_within_180 = len(thirty_second_latencies) >= 3 and worst_top3_total <= 180.0

    transient_groups = {}
    for result in complete_results:
        if result.get("transient_action"):
            transient_groups.setdefault(result["case_id"], {})[float(result["fps"])] = result
    one_fps_preserves_transient_actions = bool(transient_groups)
    for fps_results in transient_groups.values():
        one_fps = fps_results.get(1.0)
        two_fps = fps_results.get(2.0)
        if not one_fps or not two_fps or one_fps.get("relevance", -1) < two_fps.get("relevance", -1):
            one_fps_preserves_transient_actions = False
            break

    gate = {
        "all_inferences_succeeded": all_inferences_succeeded,
        "all_expected_relevance_matches": all_expected_relevance_matches,
        "all_30_second_inferences_within_60_seconds": all_30_within_60,
        "worst_top3_30_second_total_seconds": round(worst_top3_total, 3),
        "worst_top3_within_180_seconds": worst_top3_within_180,
        "one_fps_preserves_transient_actions": one_fps_preserves_transient_actions,
    }
    gate["automatic_gate_passed"] = all(
        (
            gate["all_inferences_succeeded"],
            gate["all_expected_relevance_matches"],
            gate["all_30_second_inferences_within_60_seconds"],
            gate["worst_top3_within_180_seconds"],
            gate["one_fps_preserves_transient_actions"],
        )
    )
    return gate


def apply_resource_gate(gate, resource_metrics):
    """Add sustained swap-pressure checks to an existing automatic gate.

    Inputs and thresholds use bytes. The function mutates and returns ``gate`` so the
    final report has one authoritative pass/fail object rather than a separate memory
    decision that callers could accidentally ignore.
    """
    start_swap = int(resource_metrics["start_swap_used_bytes"])
    peak_swap_growth = max(0, int(resource_metrics["peak_swap_used_bytes"]) - start_swap)
    end_swap_growth = max(0, int(resource_metrics["end_swap_used_bytes"]) - start_swap)
    swap_pressure_within_limit = (
        peak_swap_growth <= MAX_PEAK_SWAP_GROWTH_BYTES
        and end_swap_growth <= MAX_END_SWAP_GROWTH_BYTES
    )
    gate.update(
        {
            "peak_swap_growth_bytes": peak_swap_growth,
            "end_swap_growth_bytes": end_swap_growth,
            "max_peak_swap_growth_bytes": MAX_PEAK_SWAP_GROWTH_BYTES,
            "max_end_swap_growth_bytes": MAX_END_SWAP_GROWTH_BYTES,
            "swap_pressure_within_limit": swap_pressure_within_limit,
        }
    )
    gate["automatic_gate_passed"] = bool(
        gate.get("automatic_gate_passed") and swap_pressure_within_limit
    )
    return gate


def validate_output_path(source_paths, output_path):
    """Reject a report destination that resolves to any read-only source video.

    ``Path.resolve`` follows an existing symbolic link. This matters because opening a
    symlink with write mode would truncate its target before JSON serialization starts.
    """
    resolved_output = Path(output_path).resolve()
    resolved_sources = {Path(source_path).resolve() for source_path in source_paths}
    if resolved_output in resolved_sources:
        raise ValueError("Benchmark output path must not resolve to a source video")
    return resolved_output


class ResourceMonitor:
    """Sample process memory and system swap while model loading/inference runs.

    RSS (Resident Set Size，常驻内存) is the process memory currently held in physical
    memory. Swap is disk space used as emergency memory; a large increase indicates the
    32 GB machine is under pressure. MPS metrics describe Apple GPU allocations.
    """

    def __init__(self, *, torch_module, interval_seconds=0.1):
        import psutil

        self.psutil = psutil
        self.torch = torch_module
        self.interval_seconds = float(interval_seconds)
        self.process = psutil.Process()
        self._stop_event = threading.Event()
        self._thread = None
        self.samples = []

    def start(self):
        """Start the daemon sampler; callers must always pair this with ``stop``."""
        if self._thread is not None:
            raise RuntimeError("ResourceMonitor has already started")
        self._thread = threading.Thread(target=self._sample_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop sampling and return peak byte counts plus start/end swap usage."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self.interval_seconds * 5))
        if not self.samples:
            self._record_sample()
        return {
            "peak_rss_bytes": max(sample["rss_bytes"] for sample in self.samples),
            "peak_swap_used_bytes": max(sample["swap_used_bytes"] for sample in self.samples),
            "start_swap_used_bytes": self.samples[0]["swap_used_bytes"],
            "end_swap_used_bytes": self.samples[-1]["swap_used_bytes"],
            "peak_mps_allocated_bytes": max(
                sample["mps_allocated_bytes"] for sample in self.samples
            ),
            "peak_mps_driver_bytes": max(sample["mps_driver_bytes"] for sample in self.samples),
        }

    def _sample_loop(self):
        while not self._stop_event.is_set():
            self._record_sample()
            self._stop_event.wait(self.interval_seconds)
        self._record_sample()

    def _record_sample(self):
        mps_allocated_bytes = 0
        mps_driver_bytes = 0
        if hasattr(self.torch.backends, "mps") and self.torch.backends.mps.is_available():
            mps_allocated_bytes = int(self.torch.mps.current_allocated_memory())
            mps_driver_bytes = int(self.torch.mps.driver_allocated_memory())
        self.samples.append(
            {
                "rss_bytes": int(self.process.memory_info().rss),
                "swap_used_bytes": int(self.psutil.swap_memory().used),
                "mps_allocated_bytes": mps_allocated_bytes,
                "mps_driver_bytes": mps_driver_bytes,
            }
        )


class QwenVideoFeasibilityRunner:
    """Load one official checkpoint and synchronously benchmark every manifest case."""

    def __init__(
        self,
        manifest,
        *,
        device="auto",
        max_new_tokens=192,
        max_pixels=360 * 420,
        inference_timeout_seconds=60,
    ):
        self.manifest = manifest
        self.requested_device = device
        self.max_new_tokens = int(max_new_tokens)
        self.max_pixels = int(max_pixels)
        self.inference_timeout_seconds = float(inference_timeout_seconds)
        if self.max_new_tokens < 1:
            raise ValueError("max_new_tokens must be at least 1")
        if self.max_pixels < 28 * 28:
            raise ValueError("max_pixels must allow at least one 28x28 visual patch")
        if self.inference_timeout_seconds <= 0:
            raise ValueError("inference_timeout_seconds must be greater than 0")
        self.torch = None
        self.model = None
        self.processor = None
        self.device = None

    def run(self):
        """Run model load and the full case/FPS matrix, returning a serializable report."""
        import psutil
        import torch
        import transformers
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        self.torch = torch
        self.device = _select_torch_device(self.requested_device, torch)
        cache_root = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
        cache_bytes_before = _directory_size_bytes(cache_root)
        monitor = ResourceMonitor(torch_module=torch)
        monitor.start()
        started_at = time.perf_counter()
        results = []
        load_seconds = None
        resolved_model_revision = None
        fatal_failure = None
        benchmark_stop_reason = None

        try:
            load_started_at = time.perf_counter()
            dtype = torch.float16 if self.device in ("mps", "cuda") else torch.float32
            self.processor = AutoProcessor.from_pretrained(
                self.manifest["model_name"],
                revision=self.manifest["model_revision"],
                max_pixels=self.max_pixels,
                use_fast=False,
            )
            # A direct device map avoids holding a complete CPU copy while another copy is
            # moved to Apple MPS. That transient duplication could exhaust 32 GB memory.
            self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                self.manifest["model_name"],
                revision=self.manifest["model_revision"],
                dtype=dtype,
                low_cpu_mem_usage=True,
                device_map={"": self.device},
            )
            self.model.eval()
            load_seconds = time.perf_counter() - load_started_at
            resolved_model_revision = getattr(self.model.config, "_commit_hash", None)

            with tempfile.TemporaryDirectory(prefix="video-vlm-feasibility-") as temp_dir:
                for case in self.manifest["cases"]:
                    clip_path = Path(temp_dir) / f"{case['id']}.mp4"
                    try:
                        _clip_video(case, clip_path, temp_root=Path(temp_dir))
                    except Exception as error:
                        for fps in self.manifest["fps_values"]:
                            results.append(_failed_result(case, fps, error))
                        continue
                    for fps in self.manifest["fps_values"]:
                        result = self._run_inference(case, clip_path, fps)
                        results.append(result)
                        print(
                            f"case={case['id']} fps={fps:g} "
                            f"seconds={result['inference_seconds']:.3f} "
                            f"status={result.get('failure_type') or 'ok'}",
                            flush=True,
                        )
                        if result.get("failure_type") in (
                            "OUT_OF_MEMORY",
                            "VLM_TIMEOUT",
                            "INTERRUPTED",
                        ):
                            benchmark_stop_reason = result
                            break
                    if benchmark_stop_reason is not None:
                        break
        except Exception as error:
            # Model download/load failures are first-class feasibility results. Returning a
            # report lets the caller distinguish memory pressure from dependency or network
            # failures instead of losing all measurements in a traceback.
            fatal_failure = {
                "failure_type": _classify_failure(error),
                "error_class": type(error).__name__,
                "error_message": str(error),
            }
        finally:
            resource_metrics = monitor.stop()

        successful_latencies = [
            result["inference_seconds"]
            for result in results
            if result.get("failure_type") is None
        ]
        gate = evaluate_feasibility_gate(results)
        expected_result_count = len(self.manifest["cases"]) * len(self.manifest["fps_values"])
        gate["benchmark_matrix_complete"] = len(results) == expected_result_count
        gate["fatal_failure_absent"] = fatal_failure is None
        gate["automatic_gate_passed"] = bool(
            gate["automatic_gate_passed"]
            and gate["benchmark_matrix_complete"]
            and gate["fatal_failure_absent"]
        )
        apply_resource_gate(gate, resource_metrics)
        report = {
            "model": {
                "name": self.manifest["model_name"],
                "requested_revision": self.manifest["model_revision"],
                "resolved_revision": resolved_model_revision,
                "device": self.device,
                "dtype": str(next(self.model.parameters()).dtype) if self.model is not None else None,
                "transformers_version": transformers.__version__,
                "torch_version": torch.__version__,
                "max_pixels_per_frame": self.max_pixels,
                "max_new_tokens": self.max_new_tokens,
                "processor_use_fast": False,
                "inference_timeout_seconds": self.inference_timeout_seconds,
            },
            "machine": {
                "platform": platform.platform(),
                "machine": platform.machine(),
                "physical_memory_bytes": int(psutil.virtual_memory().total),
            },
            "timing": {
                "model_load_seconds": round(load_seconds, 3) if load_seconds is not None else None,
                "first_inference_seconds": round(successful_latencies[0], 3)
                if successful_latencies
                else None,
                "hot_inference_mean_seconds": round(
                    sum(successful_latencies[1:]) / len(successful_latencies[1:]), 3
                )
                if len(successful_latencies) > 1
                else None,
                "total_run_seconds": round(time.perf_counter() - started_at, 3),
            },
            "storage": {
                "huggingface_cache_bytes_before": cache_bytes_before,
                "huggingface_cache_bytes_after": _directory_size_bytes(cache_root),
            },
            "resources": resource_metrics,
            "fatal_failure": fatal_failure,
            "benchmark_stop_reason": benchmark_stop_reason,
            "results": results,
            "gate": gate,
            "manual_review_required": [
                "Confirm relevance reasons match the visible video evidence.",
                "Confirm swap growth is not sustained or operationally disruptive.",
                "Choose the lowest FPS only if transient-action accuracy is not visibly worse.",
            ],
        }
        report["storage"]["downloaded_bytes_during_run"] = max(
            0,
            report["storage"]["huggingface_cache_bytes_after"]
            - report["storage"]["huggingface_cache_bytes_before"],
        )
        return report

    def _run_inference(self, case, clip_path, fps):
        """Run one synchronous video inference and preserve failures as report rows."""
        started_at = time.perf_counter()
        inference_started_at = None
        completed_inference_seconds = None
        try:
            conversation = [
                {
                    "role": "user",
                    "content": [
                        {"type": "video", "path": str(clip_path)},
                        {"type": "text", "text": VIDEO_VERIFY_PROMPT.format(query=case["query"])},
                    ],
                }
            ]
            inputs = self.processor.apply_chat_template(
                conversation,
                fps=float(fps),
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            )
            # Some decoder/processor combinations can return a text-only batch without
            # raising. Treat that as a hard decode failure instead of benchmarking a query
            # that never contained the source video's frames.
            _assert_non_empty_video_inputs(inputs)
            inputs = inputs.to(self.device)
            _synchronize_device(self.device, self.torch)
            inference_started_at = time.perf_counter()
            with _inference_timeout(self.inference_timeout_seconds):
                with self.torch.inference_mode():
                    output_ids = self.model.generate(**inputs, max_new_tokens=self.max_new_tokens)
            _synchronize_device(self.device, self.torch)
            inference_seconds = time.perf_counter() - inference_started_at
            # Freeze the model-generation measurement before text decoding and JSON
            # validation. If either post-processing step fails, the failure row must use
            # this same latency boundary as a successful row.
            completed_inference_seconds = inference_seconds
            trimmed_ids = [
                output[len(input_ids):]
                for input_ids, output in zip(inputs.input_ids, output_ids)
            ]
            raw_text = self.processor.batch_decode(
                trimmed_ids,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )[0].strip()
            response = parse_verification_response(raw_text)
            return {
                "case_id": case["id"],
                "source_path": case["source_path"],
                "start_seconds": case["start_seconds"],
                "duration_seconds": case["duration_seconds"],
                "fps": float(fps),
                "query": case["query"],
                "expected_relevance": case["expected_relevance"],
                "transient_action": case["transient_action"],
                "inference_seconds": round(inference_seconds, 3),
                "total_case_seconds": round(time.perf_counter() - started_at, 3),
                "failure_type": None,
                "raw_response": raw_text,
                **response,
            }
        except Exception as error:  # The spike must retain the exact failing case and continue.
            return _failed_result(
                case,
                fps,
                error,
                inference_seconds=(
                    completed_inference_seconds
                    if completed_inference_seconds is not None
                    else time.perf_counter() - inference_started_at
                    if inference_started_at is not None
                    else 0.0
                ),
                total_case_seconds=time.perf_counter() - started_at,
            )
        except KeyboardInterrupt as error:
            return _failed_result(
                case,
                fps,
                error,
                inference_seconds=(
                    completed_inference_seconds
                    if completed_inference_seconds is not None
                    else time.perf_counter() - inference_started_at
                    if inference_started_at is not None
                    else 0.0
                ),
                total_case_seconds=time.perf_counter() - started_at,
            )


def _clip_video(case, destination, *, temp_root):
    """Create an exact temporary H.264 MP4; source media remains read-only."""
    resolved_destination = Path(destination).resolve()
    resolved_temp_root = Path(temp_root).resolve()
    if resolved_destination.parent != resolved_temp_root:
        raise ValueError("Temporary clip destination escaped the benchmark directory")
    command = [
        "ffmpeg",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(case["start_seconds"]),
        "-i",
        case["source_path"],
        "-t",
        str(case["duration_seconds"]),
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(resolved_destination),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if (
        completed.returncode != 0
        or not resolved_destination.is_file()
        or resolved_destination.stat().st_size == 0
    ):
        raise RuntimeError(
            f"FFmpeg failed to create {case['id']}: {completed.stderr.strip() or completed.returncode}"
        )


def _select_torch_device(requested_device, torch_module):
    """Select Apple MPS first on this Mac, then CUDA, then the much slower CPU path."""
    normalized = str(requested_device).strip().lower()
    if normalized != "auto":
        if normalized == "mps" and not torch_module.backends.mps.is_available():
            raise RuntimeError("MPS was requested but is unavailable")
        if normalized == "cuda" and not torch_module.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        if normalized not in ("mps", "cuda", "cpu"):
            raise ValueError("device must be auto, mps, cuda, or cpu")
        return normalized
    if hasattr(torch_module.backends, "mps") and torch_module.backends.mps.is_available():
        return "mps"
    if torch_module.cuda.is_available():
        return "cuda"
    return "cpu"


def _synchronize_device(device, torch_module):
    """Wait for asynchronous GPU work so measured seconds include actual computation."""
    if device == "mps":
        torch_module.mps.synchronize()
    elif device == "cuda":
        torch_module.cuda.synchronize()


def _classify_failure(error):
    """Map exceptions to stable report categories using strict precedence.

    Typed timeout, interruption, and memory errors take priority. Text matching is only
    a fallback for third-party libraries that expose no common exception type; therefore
    an unknown message remains ``INFERENCE_FAILED`` instead of being over-classified.
    """
    message = str(error).lower()
    if isinstance(error, InferenceTimeoutError):
        return "VLM_TIMEOUT"
    if isinstance(error, KeyboardInterrupt):
        return "INTERRUPTED"
    if isinstance(error, MemoryError) or "out of memory" in message:
        return "OUT_OF_MEMORY"
    if isinstance(error, ValueError) and (
        "strict json" in message or "model response" in message
    ):
        return "INVALID_STRUCTURED_OUTPUT"
    if "video" in message or "ffmpeg" in message or "decode" in message:
        return "VIDEO_DECODE_FAILED"
    return "INFERENCE_FAILED"


@contextmanager
def _inference_timeout(timeout_seconds):
    """Interrupt main-thread model generation when it exceeds the limit in seconds.

    ``setitimer`` is available on macOS and raises from the active generation call. The
    previous signal handler/timer are restored so this isolated benchmark does not leak
    timeout behavior into model cleanup or later cases.
    """

    def handle_timeout(_signum, _frame):
        raise InferenceTimeoutError(
            f"Video inference exceeded {float(timeout_seconds):g} seconds"
        )

    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, handle_timeout)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, float(timeout_seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


def _failed_result(
    case,
    fps,
    error,
    *,
    inference_seconds=0.0,
    total_case_seconds=None,
):
    """Build one stable failure row so every planned case/FPS pair remains auditable."""
    return {
        "case_id": case["id"],
        "source_path": case["source_path"],
        "start_seconds": case["start_seconds"],
        "duration_seconds": case["duration_seconds"],
        "fps": float(fps),
        "query": case["query"],
        "expected_relevance": case["expected_relevance"],
        "transient_action": case["transient_action"],
        "inference_seconds": round(inference_seconds, 3),
        "total_case_seconds": round(
            inference_seconds if total_case_seconds is None else total_case_seconds,
            3,
        ),
        "failure_type": _classify_failure(error),
        "error_class": type(error).__name__,
        "error_message": str(error),
    }


def _assert_non_empty_video_inputs(inputs):
    """Require at least one decoded video value before expensive model generation.

    Qwen's Processor stores decoded frames in ``pixel_values_videos``. A missing or
    empty tensor means the request is effectively text-only, so any speed or relevance
    result would not measure full-video understanding.
    """
    video_values = inputs.get("pixel_values_videos")
    if video_values is None or video_values.numel() == 0:
        raise ValueError("Processor produced no video frames")


def _directory_size_bytes(path):
    """Return physical file bytes without counting snapshot symbolic links twice."""
    if not path.exists():
        return 0
    total = 0
    for root, _directories, files in os.walk(path):
        for filename in files:
            file_path = Path(root) / filename
            if not file_path.is_symlink():
                try:
                    total += file_path.stat().st_size
                except FileNotFoundError:
                    continue
    return total


def _finite_non_negative_number(value, field_name):
    number = _finite_number(value, field_name)
    if number < 0:
        raise ValueError(f"{field_name} must be at least 0 seconds")
    return number


def _finite_positive_number(value, field_name):
    number = _finite_number(value, field_name)
    if number <= 0:
        raise ValueError(f"{field_name} must be greater than 0 seconds")
    return number


def _finite_number(value, field_name):
    import math

    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be a finite number") from error
    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be a finite number")
    return number


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="Path to the real-scene JSON manifest")
    parser.add_argument("--output", required=True, help="Path for the JSON benchmark report")
    parser.add_argument("--device", default="auto", choices=("auto", "mps", "cuda", "cpu"))
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--max-pixels", type=int, default=360 * 420)
    parser.add_argument("--inference-timeout-seconds", type=float, default=60)
    return parser.parse_args(argv)


def main(argv=None):
    """CLI entrypoint; it writes a report and exits nonzero when the automatic gate fails."""
    args = _parse_args(argv)
    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    with manifest_path.open("r", encoding="utf-8") as input_file:
        manifest = validate_benchmark_manifest(json.load(input_file))
    output_path = validate_output_path(
        [case["source_path"] for case in manifest["cases"]],
        output_path,
    )

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFmpeg is required to create isolated benchmark clips")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    runner = QwenVideoFeasibilityRunner(
        manifest,
        device=args.device,
        max_new_tokens=args.max_new_tokens,
        max_pixels=args.max_pixels,
        inference_timeout_seconds=args.inference_timeout_seconds,
    )
    report = runner.run()
    with output_path.open("w", encoding="utf-8") as output_file:
        json.dump(report, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")
    print(json.dumps(report["gate"], ensure_ascii=False, indent=2))
    return 0 if report["gate"]["automatic_gate_passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
