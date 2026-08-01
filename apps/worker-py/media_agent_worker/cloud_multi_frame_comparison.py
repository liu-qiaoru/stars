"""Compare domestic cloud vision models on the frozen Phase 9A video cases.

This is an isolated evaluation command, not a production Worker job. It reads the
same immutable Phase 8 candidates as the local Ollama experiment, extracts resized
JPEG frames into a private temporary directory, and synchronously uploads only those
frames, the Chinese query, and frame timestamps to explicitly selected providers.
It never writes PostgreSQL or Qdrant, never changes search ranking, and removes every
temporary frame on success or failure.

The caller must pass ``--confirm-external-upload`` on every run. API keys are read
from environment variables and are never accepted as command-line values, written to
the report, or included in error messages.
"""

import argparse
import base64
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import time
from urllib import error as urllib_error
from urllib import request as urllib_request

from .env import load_project_env
from .multi_frame_vlm_feasibility import (
    MultiFrameSampler,
    Phase8SnapshotResolver,
    build_verification_prompt,
    sampling_fingerprint,
    validate_phase9a_manifest,
)
from .repository import connect_from_env
from .video_vlm_feasibility import parse_verification_response


REPORT_SCHEMA_VERSION = "phase9a-cloud-comparison-v1"
MAX_PRICED_INPUT_TOKENS = 32_000
MAX_OUTPUT_TOKENS = 500
DEFAULT_BUDGET_CNY = 2.0
FROZEN_MANIFEST_SHA256 = "a074c5329c005c4efc478cbd189fcc15c8be0e100d535fff87ab224f0992c108"


@dataclass(frozen=True)
class ProviderSpec:
    """Freeze one provider endpoint, model snapshot, and known price tier.

    Prices are Chinese yuan per one million tokens. ``max_input_tokens`` is not the
    model context limit; it is the upper edge of the price tier verified for this
    experiment. The runner refuses larger calls because silently applying an unknown
    rate would make the budget report misleading.
    """

    provider_id: str
    display_name: str
    endpoint: str
    api_key_env: str
    model: str
    input_cny_per_million: float
    output_cny_per_million: float
    max_input_tokens: int = MAX_PRICED_INPUT_TOKENS
    max_output_tokens: int = MAX_OUTPUT_TOKENS
    output_limit_parameter: str = "max_tokens"
    thinking_control: str | None = None

    @property
    def maximum_request_cost_cny(self):
        """Return the highest price of one request inside the frozen token limits."""
        return (
            self.max_input_tokens * self.input_cny_per_million
            + self.max_output_tokens * self.output_cny_per_million
        ) / 1_000_000


# Exact Qwen snapshots prevent an alias update from changing a later rerun. 智谱当前
# public API exposes GLM-4.6V-Flash through this stable model name but no dated snapshot,
# so the report records that limitation instead of pretending the alias is immutable.
PROVIDERS = {
    "glm-4.6v-flash": ProviderSpec(
        provider_id="glm-4.6v-flash",
        display_name="智谱 GLM-4.6V-Flash",
        endpoint="https://open.bigmodel.cn/api/paas/v4/chat/completions",
        api_key_env="ZHIPU_API_KEY",
        model="glm-4.6v-flash",
        input_cny_per_million=0.0,
        output_cny_per_million=0.0,
        thinking_control="glm",
    ),
    "qwen3-vl-plus": ProviderSpec(
        provider_id="qwen3-vl-plus",
        display_name="阿里云 Qwen3-VL-Plus",
        endpoint="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        api_key_env="DASHSCOPE_API_KEY",
        model="qwen3-vl-plus-2025-12-19",
        input_cny_per_million=1.0,
        output_cny_per_million=10.0,
        output_limit_parameter="max_completion_tokens",
        thinking_control="qwen",
    ),
    "qwen3-vl-flash": ProviderSpec(
        provider_id="qwen3-vl-flash",
        display_name="阿里云 Qwen3-VL-Flash",
        endpoint="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        api_key_env="DASHSCOPE_API_KEY",
        model="qwen3-vl-flash-2026-01-22",
        input_cny_per_million=0.15,
        output_cny_per_million=1.5,
        output_limit_parameter="max_completion_tokens",
        thinking_control="qwen",
    ),
}


class BudgetLedger:
    """Stop paid calls before their worst-case price can cross the user budget."""

    def __init__(self, *, max_budget_cny):
        if not isinstance(max_budget_cny, (int, float)) or not math.isfinite(max_budget_cny):
            raise ValueError("max_budget_cny must be a finite number")
        if max_budget_cny < 0:
            raise ValueError("max_budget_cny must be non-negative")
        self.max_budget_cny = float(max_budget_cny)
        self.spent_cny = 0.0
        self.reserved_cny = 0.0
        self.unpriced_failed_request_count = 0

    def reserve(self, provider):
        """Reserve one maximum request cost before any bytes leave the machine."""
        amount = provider.maximum_request_cost_cny
        if self.spent_cny + self.reserved_cny + amount > self.max_budget_cny + 1e-12:
            raise RuntimeError(
                "CLOUD_BUDGET_EXHAUSTED: the next request could exceed the configured budget"
            )
        self.reserved_cny += amount
        return {"provider": provider, "reserved_cny": amount, "active": True}

    def cancel(self, reservation):
        """Release a reservation when the HTTP request failed before usage was known."""
        if reservation["active"]:
            self.reserved_cny -= reservation["reserved_cny"]
            reservation["active"] = False

    def commit(self, reservation, *, input_tokens, output_tokens):
        """Replace a worst-case reservation with the provider-reported actual cost."""
        provider = reservation["provider"]
        if type(input_tokens) is not int or input_tokens < 0:
            raise RuntimeError("CLOUD_USAGE_INVALID: input token count is missing or invalid")
        if type(output_tokens) is not int or output_tokens < 0:
            raise RuntimeError("CLOUD_USAGE_INVALID: output token count is missing or invalid")
        if input_tokens > provider.max_input_tokens:
            raise RuntimeError(
                "CLOUD_INPUT_TOKEN_LIMIT_EXCEEDED: request left the frozen price tier"
            )
        if output_tokens > provider.max_output_tokens:
            raise RuntimeError(
                "CLOUD_OUTPUT_TOKEN_LIMIT_EXCEEDED: response exceeded the reserved output limit"
            )
        self.cancel(reservation)
        cost = (
            input_tokens * provider.input_cny_per_million
            + output_tokens * provider.output_cny_per_million
        ) / 1_000_000
        self.spent_cny += cost
        if self.spent_cny > self.max_budget_cny + 1e-12:
            # This should be impossible because reserve() used a cost ceiling. Keeping
            # the assertion makes a stale price constant fail loudly instead of hiding
            # an accounting defect.
            raise RuntimeError("CLOUD_BUDGET_ACCOUNTING_BROKEN")
        return cost

    def record_unpriced_failed_request(self):
        """Record a sent request whose provider did not return billable usage."""
        self.unpriced_failed_request_count += 1


class CloudVlmClient:
    """Synchronously call one OpenAI-compatible cloud multimodal chat endpoint."""

    def __init__(self, *, provider, api_key, timeout_seconds=90, urlopen=None):
        if not api_key:
            raise RuntimeError(f"Missing required environment variable: {provider.api_key_env}")
        self.provider = provider
        self._api_key = api_key
        self.timeout_seconds = float(timeout_seconds)
        self.urlopen = urlopen or urllib_request.urlopen

    def verify(self, image_paths, prompt):
        """Upload temporary JPEGs plus the prompt and return strict parsed evidence."""
        content = []
        for image_path in image_paths:
            with open(image_path, "rb") as image_file:
                encoded = base64.b64encode(image_file.read()).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
                }
            )
        content.append({"type": "text", "text": prompt})
        payload = {
            "model": self.provider.model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        # Alibaba's current OpenAI-compatible API deprecates max_tokens in favor of
        # max_completion_tokens; 智谱's documented endpoint still uses max_tokens.
        # Both remain capped at 500 so the pre-call budget reservation is a real bound.
        payload[self.provider.output_limit_parameter] = self.provider.max_output_tokens
        if self.provider.thinking_control == "glm":
            # Reasoning is disabled so every provider is timed on the same task and
            # returns only the short verification JSON, not hidden variable work.
            payload["thinking"] = {"type": "disabled"}
        elif self.provider.thinking_control == "qwen":
            payload["enable_thinking"] = False
        request = urllib_request.Request(
            self.provider.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "authorization": f"Bearer {self._api_key}",
                "content-type": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with self.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
        except urllib_error.HTTPError as error:
            # Do not echo the response body: some gateways include parts of the input
            # in validation errors, which could leak the local query into ordinary
            # terminal logs. The status plus provider request ID is enough to diagnose
            # the failure in that provider's console.
            request_id = error.headers.get("x-request-id") if error.headers else None
            raise RuntimeError(
                f"CLOUD_HTTP_ERROR: {self.provider.provider_id} returned HTTP {error.code}"
                + (f" (request_id={request_id})" if request_id else "")
            ) from error
        except urllib_error.URLError as error:
            raise RuntimeError(
                f"CLOUD_NETWORK_ERROR: cannot reach {self.provider.provider_id}: {error.reason}"
            ) from error
        wall_seconds = time.perf_counter() - started
        try:
            response_payload = json.loads(body)
            raw_text = response_payload["choices"][0]["message"]["content"]
            parsed = parse_verification_response(raw_text)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(
                f"CLOUD_INVALID_RESPONSE: {self.provider.provider_id} did not return strict JSON"
            ) from error
        usage = response_payload.get("usage") or {}
        input_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
        output_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
        if type(input_tokens) is not int or type(output_tokens) is not int:
            raise RuntimeError(
                f"CLOUD_USAGE_INVALID: {self.provider.provider_id} omitted token usage"
            )
        return {
            **parsed,
            "raw_response": raw_text,
            "inference_seconds": round(wall_seconds, 3),
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": usage.get("total_tokens", input_tokens + output_tokens),
            },
        }


class CloudMultiFrameRunner:
    """Extract each case once, then compare selected providers on identical evidence."""

    def __init__(self, *, cases, clients, repeat_count, sampler=None, budget):
        if repeat_count != 3:
            raise ValueError("Cloud comparison repeat_count must remain exactly 3")
        if not clients:
            raise ValueError("At least one cloud provider must be selected")
        self.cases = cases
        self.clients = clients
        self.repeat_count = repeat_count
        self.sampler = sampler or MultiFrameSampler()
        self.budget = budget

    def run(self):
        started_wall = time.time()
        started = time.perf_counter()
        results = []
        aborted = None
        # The temporary directory owns every extracted frame. No base64 image or local
        # source path is copied into the report, and leaving this context cleans files
        # after success, provider failure, budget stop, or Ctrl-C cancellation.
        with tempfile.TemporaryDirectory(prefix="phase9a-cloud-compare-") as temp_root:
            for case in self.cases:
                if aborted is not None:
                    break
                case_directory = Path(temp_root) / case["id"]
                case_directory.mkdir()
                try:
                    evidence = self.sampler.prepare(case, case_directory)
                except Exception as error:
                    aborted = {
                        "stage": "frame_extraction",
                        "case_id": case["id"],
                        "failure_type": type(error).__name__,
                        "error_message": str(error),
                    }
                    break
                public_evidence = [
                    {key: value for key, value in row.items() if key != "path"}
                    for row in evidence
                ]
                prompt = build_verification_prompt(case["query"], public_evidence)
                image_paths = [row["path"] for row in evidence]
                for provider_id, client in self.clients.items():
                    if aborted is not None:
                        break
                    provider = PROVIDERS[provider_id]
                    for repeat_index in range(1, self.repeat_count + 1):
                        reservation = None
                        request_sent = False
                        try:
                            reservation = self.budget.reserve(provider)
                            request_sent = True
                            response = client.verify(image_paths, prompt)
                            usage = response["usage"]
                            cost = self.budget.commit(
                                reservation,
                                input_tokens=usage["input_tokens"],
                                output_tokens=usage["output_tokens"],
                            )
                            results.append(
                                {
                                    **_result_identity(case, provider, repeat_index),
                                    "frame_count": len(public_evidence),
                                    "frame_evidence": public_evidence,
                                    "failure_type": None,
                                    "estimated_cost_cny": round(cost, 8),
                                    **response,
                                }
                            )
                        except Exception as error:
                            if reservation is not None:
                                self.budget.cancel(reservation)
                            if request_sent:
                                # A timeout or malformed success response may still be
                                # billable. Stop the whole experiment after one unknown
                                # charge so the local budget cannot falsely authorize a
                                # long sequence of additional requests.
                                self.budget.record_unpriced_failed_request()
                            results.append(
                                {
                                    **_result_identity(case, provider, repeat_index),
                                    "frame_count": len(public_evidence),
                                    "frame_evidence": public_evidence,
                                    "failure_type": type(error).__name__,
                                    "error_message": str(error),
                                    "estimated_cost_cny": None,
                                }
                            )
                            aborted = {
                                "stage": "provider_call",
                                "provider_id": provider_id,
                                "case_id": case["id"],
                                "repeat_index": repeat_index,
                                "failure_type": type(error).__name__,
                                "error_message": str(error),
                            }
                            break
        providers = {
            provider_id: summarize_provider_results(
                [row for row in results if row["provider_id"] == provider_id],
                expected_case_count=len(self.cases),
                repeat_count=self.repeat_count,
            )
            for provider_id in self.clients
        }
        return {
            "schema_version": REPORT_SCHEMA_VERSION,
            "experiment_scope": "frozen_phase9a_regression_only",
            "started_at_unix_seconds": round(started_wall, 3),
            "total_duration_seconds": round(time.perf_counter() - started, 3),
            "sampling_fingerprint": sampling_fingerprint(),
            "external_data_boundary": {
                "uploaded": ["resized_temporary_jpeg_frames", "query", "frame_timestamps"],
                "not_uploaded": [
                    "complete_video",
                    "local_source_path",
                    "caption",
                    "transcript",
                    "postgresql_rows",
                    "qdrant_vectors",
                ],
            },
            "temporary_frames_retained": False,
            "repeat_count": self.repeat_count,
            "case_count": len(self.cases),
            "budget": {
                "maximum_cny": self.budget.max_budget_cny,
                "estimated_spent_cny": round(self.budget.spent_cny, 8),
                "unpriced_failed_request_count": self.budget.unpriced_failed_request_count,
            },
            "provider_runtime": {
                provider_id: _public_provider_spec(PROVIDERS[provider_id])
                for provider_id in self.clients
            },
            "results": results,
            "providers": providers,
            # A model can consistently produce the expected integer while inventing
            # its explanation. A person must review reasons before this evidence can
            # justify a new production Phase 9 gate.
            "aborted": aborted,
            "decision": (
                "incomplete_due_to_failure"
                if aborted is not None
                else "pending_human_reason_review"
            ),
        }


def summarize_provider_results(rows, *, expected_case_count, repeat_count):
    """Summarize success, repeat stability, exact labels, latency, and known cost."""
    expected_calls = expected_case_count * repeat_count
    successful = [row for row in rows if row.get("failure_type") is None]
    by_case = {}
    for row in successful:
        by_case.setdefault(row["case_id"], []).append(row)
    stable_case_count = 0
    exact_case_match_count = 0
    for case_rows in by_case.values():
        labels = [row["relevance"] for row in case_rows]
        if len(labels) == repeat_count and len(set(labels)) == 1:
            stable_case_count += 1
            if labels[0] == case_rows[0]["expected_relevance"]:
                exact_case_match_count += 1
    latencies = sorted(float(row["inference_seconds"]) for row in successful)
    return {
        "expected_call_count": expected_calls,
        "successful_call_count": len(successful),
        "success_rate": round(len(successful) / expected_calls, 6) if expected_calls else 0.0,
        "stable_case_count": stable_case_count,
        "stability_rate": (
            round(stable_case_count / expected_case_count, 6) if expected_case_count else 0.0
        ),
        "exact_case_match_count": exact_case_match_count,
        "exact_case_accuracy": (
            round(exact_case_match_count / expected_case_count, 6)
            if expected_case_count
            else 0.0
        ),
        "mean_inference_seconds": (
            round(sum(latencies) / len(latencies), 3) if latencies else None
        ),
        "p95_inference_seconds": _percentile(latencies, 0.95),
        "estimated_cost_cny": round(
            sum(row.get("estimated_cost_cny") or 0.0 for row in successful), 8
        ),
        "reason_review": "pending_human_review",
    }


def _percentile(values, quantile):
    if not values:
        return None
    index = max(0, math.ceil(len(values) * quantile) - 1)
    return round(values[index], 3)


def validate_cloud_manifest_bytes(raw_manifest):
    """Accept only the exact 12-case manifest used by the failed local 9A run.

    The generic Phase 9A validator intentionally accepts future manifests with at
    least 12 rows. This regression experiment is narrower: changing whitespace, case
    IDs, labels, or ordering changes the SHA-256 digest and aborts before database or
    network access, so cloud results cannot be compared against a convenient new set.
    """
    digest = hashlib.sha256(raw_manifest).hexdigest()
    if digest != FROZEN_MANIFEST_SHA256:
        raise ValueError(
            "Cloud regression requires the original frozen Phase 9A manifest "
            f"sha256:{FROZEN_MANIFEST_SHA256}, got sha256:{digest}"
        )
    return validate_phase9a_manifest(json.loads(raw_manifest.decode("utf-8")))


def validate_selected_providers(provider_ids):
    """Require a complete three-model comparison, preserving documented order."""
    selected = list(dict.fromkeys(provider_ids))
    if set(selected) != set(PROVIDERS) or len(selected) != len(PROVIDERS):
        raise ValueError("Formal cloud comparison requires exactly all three --provider values")
    return selected


def _result_identity(case, provider, repeat_index):
    return {
        "provider_id": provider.provider_id,
        "model": provider.model,
        "case_id": case["id"],
        "query_id": case["query_id"],
        "candidate_key": case["candidate_key"],
        "repeat_index": repeat_index,
        "query": case["query"],
        "rrf_rank": case["rrf_rank"],
        "source_group": case["source_group"],
        "scene_start_seconds": round(case["scene_start_seconds"], 6),
        "scene_end_seconds": round(case["scene_end_seconds"], 6),
        "expected_relevance": case["expected_relevance"],
    }


def _public_provider_spec(provider):
    return {
        "display_name": provider.display_name,
        "endpoint_origin": provider.endpoint.split("/v1/")[0].split("/api/")[0],
        "model": provider.model,
        "model_snapshot_is_dated": any(character.isdigit() for character in provider.model[-10:])
        and provider.model[-10:].count("-") == 2,
        "api_key_environment_variable": provider.api_key_env,
        "input_cny_per_million_tokens": provider.input_cny_per_million,
        "output_cny_per_million_tokens": provider.output_cny_per_million,
        "priced_input_token_limit": provider.max_input_tokens,
        "output_token_limit": provider.max_output_tokens,
    }


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--provider",
        action="append",
        choices=sorted(PROVIDERS),
        required=True,
        help="Repeat this flag to compare more than one provider",
    )
    parser.add_argument("--max-budget-cny", type=float, default=DEFAULT_BUDGET_CNY)
    parser.add_argument("--timeout-seconds", type=float, default=90.0)
    parser.add_argument(
        "--confirm-external-upload",
        action="store_true",
        help="Confirm that minimized evaluation frames and queries may leave this machine",
    )
    return parser.parse_args(argv)


def _write_report(output_path, report):
    """Atomically replace only the requested JSON report, never a source media file."""
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


def main(argv=None):
    """Resolve the frozen snapshot, validate all credentials, then make cloud calls."""
    args = _parse_args(argv)
    if not args.confirm_external_upload:
        raise RuntimeError("External upload requires --confirm-external-upload")
    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    if output_path.suffix.lower() != ".json" or output_path == manifest_path:
        raise ValueError("Output must be a separate .json report path")
    load_project_env()
    manifest = validate_cloud_manifest_bytes(manifest_path.read_bytes())
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFmpeg is required for cloud comparison frame extraction")
    selected_ids = validate_selected_providers(args.provider)
    # Validate every requested credential before the first provider call. Otherwise a
    # typo in the second key could spend money on a partial, incomparable experiment.
    clients = {}
    for provider_id in selected_ids:
        provider = PROVIDERS[provider_id]
        clients[provider_id] = CloudVlmClient(
            provider=provider,
            api_key=os.environ.get(provider.api_key_env),
            timeout_seconds=args.timeout_seconds,
        )
    connection = connect_from_env()
    try:
        cases = Phase8SnapshotResolver(connection).resolve(manifest)
    finally:
        connection.close()
    if output_path in {Path(case["source_path"]).resolve() for case in cases}:
        raise ValueError("Report path must not overwrite a source video")
    report = CloudMultiFrameRunner(
        cases=cases,
        clients=clients,
        repeat_count=manifest["repeat_count"],
        budget=BudgetLedger(max_budget_cny=args.max_budget_cny),
    ).run()
    _write_report(output_path, report)
    summary = {"providers": report["providers"], "budget": report["budget"]}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    complete = all(
        summary["successful_call_count"] == summary["expected_call_count"]
        for summary in report["providers"].values()
    )
    return 0 if complete else 2


if __name__ == "__main__":
    raise SystemExit(main())
