"""Build deterministic local evidence artifacts for frozen video candidates.

NestJS creates ``build_candidate_evidence`` jobs with stable IDs only. This handler re-reads
PostgreSQL media facts, materializes the exact indexed frame timestamps, and publishes local
artifacts. It deliberately has no Provider, Rerank, or VLM dependency.
"""

import hashlib
import io
import json
import math
import os
import shutil
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION

from .embedding_worker import extract_video_frame
from .errors import JobError


PROTOCOL_VERSION = "candidate-evidence-v1"
CANVAS_SIZE = (1600, 900)
BACKGROUND_COLOR = "#111827"
CELL_PADDING_PIXELS = 8
PNG_COMPRESSION_LEVEL = 9
EXPECTED_PILLOW_VERSION = "11.3.0"

# 固定 5x7 像素字形避免依赖操作系统字体或 Pillow/FreeType 的字体光栅化结果。
# contact_sheet_v1 只会绘制下列时间戳字符；新增字符必须升级协议版本。
TIMESTAMP_GLYPHS = {
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    ":": ("00000", "00100", "00100", "00000", "00100", "00100", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
}
TIMESTAMP_GLYPH_SCALE = 4


def _canonical_json_bytes(value):
    """Freeze UTF-8 JSON encoding, field order and whitespace for reproducible SHA-256 hashes."""

    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def _sha256(value):
    return hashlib.sha256(value).hexdigest()


def _frame_png_bytes(image):
    output = io.BytesIO()
    image.convert("RGB").save(output, format="PNG", compress_level=PNG_COMPRESSION_LEVEL, optimize=False)
    return output.getvalue()


def _layout(frame_count):
    # 帧不足时扩大单格，而不是保留固定 4x3 的大片空白。该映射属于协议参数，修改时必须
    # 升级 protocol_version，否则同一输入会产生不可审计的不同拼图。
    if frame_count == 1:
        return 1, 1
    if frame_count == 2:
        return 1, 2
    if frame_count <= 4:
        return 2, 2
    if frame_count <= 6:
        return 2, 3
    if frame_count <= 9:
        return 3, 3
    return 3, 4


def _timestamp(frame_time_seconds):
    milliseconds = int(round(frame_time_seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"T+{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def _protocol_parameters(strategy, frame_count):
    rows, columns = _layout(frame_count)
    common = {
        "frame_order": "frame_time_seconds_asset_id",
        "frame_time_number_format": "ieee754_binary64_roundtrip_17g",
        "pillow_version": EXPECTED_PILLOW_VERSION,
        "normalized_frame_format": "png_rgb",
        "normalized_frame_png_compression_level": PNG_COMPRESSION_LEVEL,
    }
    if strategy == "all_indexed_frames_v1":
        return {**common, "bundle_manifest_encoding": "canonical_json_utf8_lf"}
    return {
        **common,
        "canvas_width": CANVAS_SIZE[0],
        "canvas_height": CANVAS_SIZE[1],
        "rows": rows,
        "columns": columns,
        "cell_padding_pixels": CELL_PADDING_PIXELS,
        "resize_mode": "contain_with_padding",
        "background_color": BACKGROUND_COLOR,
        "timestamp_font": "candidate_evidence_5x7_scale4_v1",
        "timestamp_position": "bottom_left",
        "timestamp_format": "T+HH:MM:SS.mmm",
        "output_format": "png_rgb",
        "output_png_compression_level": PNG_COMPRESSION_LEVEL,
    }


def _default_frame_loader(source_path, frame_time_seconds):
    extracted_path = extract_video_frame(source_path, frame_time_seconds)
    try:
        with Image.open(extracted_path) as image:
            return image.convert("RGB").copy()
    finally:
        Path(extracted_path).unlink(missing_ok=True)


def _draw_timestamp(draw, position, label):
    """用仓库内冻结的像素字形绘制时间戳，返回标签的像素宽高。"""
    x, y = position
    glyph_width = 5 * TIMESTAMP_GLYPH_SCALE
    gap = TIMESTAMP_GLYPH_SCALE
    for character_index, character in enumerate(label):
        glyph = TIMESTAMP_GLYPHS[character]
        glyph_x = x + character_index * (glyph_width + gap)
        for row_index, row in enumerate(glyph):
            for column_index, value in enumerate(row):
                if value == "1":
                    left = glyph_x + column_index * TIMESTAMP_GLYPH_SCALE
                    top = y + row_index * TIMESTAMP_GLYPH_SCALE
                    draw.rectangle(
                        (
                            left,
                            top,
                            left + TIMESTAMP_GLYPH_SCALE - 1,
                            top + TIMESTAMP_GLYPH_SCALE - 1,
                        ),
                        fill="#ffffff",
                    )
    return len(label) * (glyph_width + gap) - gap, 7 * TIMESTAMP_GLYPH_SCALE


class CandidateEvidenceHandler:
    """Validate one frozen candidate and atomically publish its requested evidence strategies."""

    def __init__(
        self,
        repository,
        *,
        artifacts_root=Path(".media-agent/evidence"),
        frame_loader=_default_frame_loader,
        cancellation_checker=lambda _job_id: False,
        source_exists=lambda path: Path(path).is_file(),
    ):
        self.repository = repository
        # Worker 与 Server 可能从不同 cwd 启动；数据库只在私有列保存绝对路径，
        # 普通 API 始终只暴露受控 artifact URL。
        self.artifacts_root = Path(artifacts_root).resolve()
        self.frame_loader = frame_loader
        self.cancellation_checker = cancellation_checker
        self.source_exists = source_exists

    def handle(self, job_input, *, job_id):
        if PILLOW_VERSION != EXPECTED_PILLOW_VERSION:
            raise JobError(
                "EVIDENCE_RENDERER_VERSION_MISMATCH",
                "候选证据渲染器版本与冻结协议不一致",
                {
                    "stage": "protocol_validation",
                    "expected_pillow_version": EXPECTED_PILLOW_VERSION,
                    "actual_pillow_version": PILLOW_VERSION,
                },
            )
        context = self.repository.load_candidate_evidence_context(job_input)
        frames = self._validate_context(job_input, context)
        evidence_by_strategy = {
            row["strategy"]: row for row in self.repository.get_candidate_evidence_for_job(job_id)
        }
        requested = sorted(job_input["strategies"])
        if set(evidence_by_strategy) != set(requested):
            raise JobError(
                "EVIDENCE_RECORD_MISMATCH",
                "证据记录与 Job 策略不一致",
                {"stage": "evidence_identity", "strategy_count": len(evidence_by_strategy)},
            )

        self.artifacts_root.mkdir(parents=True, exist_ok=True)
        normalized_frames = []
        for frame in frames:
            self._raise_if_cancelled(job_id)
            try:
                image = self.frame_loader(context["file"]["path"], frame["frame_time_seconds"])
            except JobError:
                raise
            except Exception as error:
                raise JobError(
                    "FRAME_EXTRACTION_FAILED",
                    "无法读取已索引视频帧",
                    {
                        "stage": "frame_extraction",
                        "exception_type": type(error).__name__,
                        "frame_asset_id": frame["asset_id"],
                    },
                ) from error
            png_bytes = _frame_png_bytes(image)
            normalized_frames.append(
                {
                    **frame,
                    "image": image,
                    "png_bytes": png_bytes,
                    "frame_sha256": _sha256(png_bytes),
                    "width": image.width,
                    "height": image.height,
                }
            )

        input_payload = {
            "protocol_version": PROTOCOL_VERSION,
            "candidate_key": job_input["candidate_key"],
            "file_id": job_input["file_id"],
            "file_generation": job_input["file_generation"],
            "asset_id": job_input["asset_id"],
            "scene_id": job_input["scene_id"],
            "frames": [
                {
                    "asset_id": frame["asset_id"],
                    "frame_time_seconds": format(float(frame["frame_time_seconds"]), ".17g"),
                    "frame_sha256": frame["frame_sha256"],
                }
                for frame in normalized_frames
            ],
        }
        outputs = []
        created_paths = []
        try:
            for strategy in requested:
                self._raise_if_cancelled(job_id)
                evidence = evidence_by_strategy[strategy]
                if evidence["protocol_version"] != PROTOCOL_VERSION:
                    raise JobError(
                        "EVIDENCE_PROTOCOL_MISMATCH",
                        "证据协议版本不匹配",
                        {"stage": "protocol_validation"},
                    )
                protocol_parameters = _protocol_parameters(strategy, len(normalized_frames))
                # strategy 与全部布局/编码参数也是输入事实。即使帧完全相同，协议参数
                # 或 generation 变化也必须得到不同 input_sha256，避免错误复用旧产物。
                input_sha256 = _sha256(
                    _canonical_json_bytes(
                        {
                            **input_payload,
                            "strategy": strategy,
                            "protocol_parameters": protocol_parameters,
                        }
                    )
                )
                if strategy == "contact_sheet_v1":
                    output, created = self._build_contact_sheet(
                        evidence["id"], job_input, normalized_frames, input_sha256
                    )
                elif strategy == "all_indexed_frames_v1":
                    output, created = self._build_frame_bundle(
                        evidence["id"], job_input, normalized_frames, input_sha256
                    )
                else:
                    raise JobError(
                        "UNKNOWN_EVIDENCE_STRATEGY",
                        "未知候选证据策略",
                        {"stage": "protocol_validation"},
                    )
                outputs.append(output)
                if created:
                    created_paths.append(Path(output["published_root"]))

            self._raise_if_cancelled(job_id)
            result = {
                "evidence_ids": [output["evidence_id"] for output in outputs],
                "manifests": [output["manifest"] for output in outputs],
            }
            # PostgreSQL 提交会在同一事务中更新 evidence 事实与 Job succeeded。若提交失败，
            # 只删除本次新发布且尚未被数据库引用的产物；复用的既有文件绝不能误删。
            self.repository.complete_candidate_evidence_job(job_id, outputs, result)
            return result
        except Exception:
            for path in reversed(created_paths):
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            raise

    def _validate_context(self, job_input, context):
        file = context.get("file")
        if not file or file.get("id") != job_input["file_id"] or file.get("media_type") != "video":
            raise JobError("INVALID_EVIDENCE_FILE", "候选文件不存在或不是视频", {"stage": "file_validation"})
        if file.get("deleted") or file.get("index_generation") != job_input["file_generation"]:
            raise JobError(
                "STALE_FILE_GENERATION",
                "候选文件 generation 已变化",
                {
                    "stage": "generation_validation",
                    "expected_generation": job_input["file_generation"],
                    "current_generation": file.get("index_generation"),
                },
            )
        if not self.source_exists(file["path"]):
            raise JobError("SOURCE_FILE_MISSING", "候选源视频不存在", {"stage": "source_validation"})

        scene = context.get("scene")
        if (
            not scene
            or scene.get("id") != job_input["scene_id"]
            or scene.get("file_id") != job_input["file_id"]
            or scene.get("index_generation") != job_input["file_generation"]
        ):
            raise JobError("SCENE_IDENTITY_MISMATCH", "候选场景与文件 generation 不一致", {"stage": "scene_validation"})
        candidate_asset = context.get("candidate_asset")
        if (
            not candidate_asset
            or candidate_asset.get("id") != job_input["asset_id"]
            or candidate_asset.get("file_id") != job_input["file_id"]
            or candidate_asset.get("scene_id") != job_input["scene_id"]
            or candidate_asset.get("asset_type") != "video_frame"
            or candidate_asset.get("stale")
        ):
            raise JobError("CANDIDATE_ASSET_MISMATCH", "候选 Asset 与场景不一致", {"stage": "asset_validation"})

        frames = sorted(
            context.get("frames") or [],
            key=lambda frame: (frame.get("frame_time_seconds", math.inf), frame.get("asset_id", "")),
        )
        if not 1 <= len(frames) <= 12:
            raise JobError(
                "INVALID_EVIDENCE_FRAME_COUNT",
                "有效已索引视频帧数量必须为 1 至 12",
                {"stage": "frame_validation", "frame_count": len(frames)},
            )
        ids = set()
        times = set()
        start = scene.get("start_time_seconds")
        end = scene.get("end_time_seconds")
        for frame in frames:
            frame_time = frame.get("frame_time_seconds")
            frame_id = frame.get("asset_id")
            if (
                frame.get("file_id") != job_input["file_id"]
                or frame.get("scene_id") != job_input["scene_id"]
                or frame.get("asset_type") != "video_frame"
                or frame.get("stale")
                or not frame.get("indexed")
            ):
                raise JobError("INVALID_EVIDENCE_FRAME", "存在无效或未索引的视频帧", {"stage": "frame_validation"})
            if not isinstance(frame_time, (int, float)) or not math.isfinite(frame_time) or frame_time < 0:
                raise JobError("INVALID_FRAME_TIME", "视频帧时间必须是有限非负数", {"stage": "frame_validation"})
            if start is None or end is None or frame_time < start or frame_time > end:
                raise JobError("FRAME_OUTSIDE_SCENE", "视频帧时间超出场景范围", {"stage": "frame_validation"})
            if frame_id in ids or frame_time in times:
                raise JobError("DUPLICATE_EVIDENCE_FRAME", "视频帧 ID 或时间重复", {"stage": "frame_validation"})
            ids.add(frame_id)
            times.add(frame_time)
        if job_input["asset_id"] not in ids:
            raise JobError(
                "CANDIDATE_ASSET_NOT_INDEXED",
                "候选代表帧不在当前场景的已索引帧集合中",
                {"stage": "frame_validation"},
            )
        return frames

    def _build_contact_sheet(self, evidence_id, job_input, frames, input_sha256):
        protocol = _protocol_parameters("contact_sheet_v1", len(frames))
        canvas = Image.new("RGB", CANVAS_SIZE, BACKGROUND_COLOR)
        draw = ImageDraw.Draw(canvas)
        rows, columns = protocol["rows"], protocol["columns"]
        for index, frame in enumerate(frames):
            row, column = divmod(index, columns)
            left = column * CANVAS_SIZE[0] // columns
            right = (column + 1) * CANVAS_SIZE[0] // columns
            top = row * CANVAS_SIZE[1] // rows
            bottom = (row + 1) * CANVAS_SIZE[1] // rows
            available = (right - left - 2 * CELL_PADDING_PIXELS, bottom - top - 2 * CELL_PADDING_PIXELS)
            image = frame["image"].copy()
            image.thumbnail(available, Image.Resampling.LANCZOS)
            x = left + (right - left - image.width) // 2
            y = top + (bottom - top - image.height) // 2
            canvas.paste(image, (x, y))
            label = _timestamp(frame["frame_time_seconds"])
            label_width = len(label) * (5 * TIMESTAMP_GLYPH_SCALE + TIMESTAMP_GLYPH_SCALE) - TIMESTAMP_GLYPH_SCALE
            label_height = 7 * TIMESTAMP_GLYPH_SCALE
            label_x = left + 16
            label_y = bottom - label_height - 20
            draw.rectangle((label_x - 6, label_y - 4, label_x + label_width + 6, label_y + label_height + 4), fill="#000000")
            _draw_timestamp(draw, (label_x, label_y), label)

        output = io.BytesIO()
        canvas.save(output, format="PNG", compress_level=PNG_COMPRESSION_LEVEL, optimize=False)
        artifact_bytes = output.getvalue()
        artifact_sha256 = _sha256(artifact_bytes)
        target = self.artifacts_root / f"{evidence_id}.png"
        created = self._publish_file(target, artifact_bytes, artifact_sha256)
        manifest = self._manifest(
            evidence_id, job_input, frames, "contact_sheet_v1", input_sha256, artifact_sha256,
            protocol, "png", CANVAS_SIZE[0], CANVAS_SIZE[1], len(artifact_bytes),
        )
        return {
            "evidence_id": evidence_id,
            "manifest": manifest,
            "artifact_path": str(target),
            "published_root": str(target),
            "artifact_mime_type": "image/png",
        }, created

    def _build_frame_bundle(self, evidence_id, job_input, frames, input_sha256):
        protocol = _protocol_parameters("all_indexed_frames_v1", len(frames))
        bundle = self.artifacts_root / f"{evidence_id}.bundle"
        partial = self.artifacts_root / f".{evidence_id}.{uuid4().hex}.partial"
        frame_entries = []
        try:
            partial.mkdir()
            frames_dir = partial / "frames"
            frames_dir.mkdir()
            for index, frame in enumerate(frames, start=1):
                filename = f"{index:02d}-{frame['asset_id']}.png"
                (frames_dir / filename).write_bytes(frame["png_bytes"])
                frame_entries.append(
                    {
                        "asset_id": frame["asset_id"],
                        "frame_time_seconds": frame["frame_time_seconds"],
                        "frame_sha256": frame["frame_sha256"],
                        "artifact_id": f"candidate-evidence/{evidence_id}/frames/{frame['asset_id']}",
                        "relative_path": f"frames/{filename}",
                        "format": "png",
                        "width": frame["width"],
                        "height": frame["height"],
                        "byte_size": len(frame["png_bytes"]),
                    }
                )
            artifact_payload = {
                "candidate_key": job_input["candidate_key"],
                "file_id": job_input["file_id"],
                "file_generation": job_input["file_generation"],
                "asset_id": job_input["asset_id"],
                "scene_id": job_input["scene_id"],
                "strategy": "all_indexed_frames_v1",
                "protocol_version": PROTOCOL_VERSION,
                "input_sha256": input_sha256,
                "protocol_parameters": protocol,
                "frames": frame_entries,
            }
            artifact_bytes = _canonical_json_bytes(artifact_payload)
            artifact_sha256 = _sha256(artifact_bytes)
            (partial / "manifest.json").write_bytes(artifact_bytes)
            created = self._publish_bundle(partial, bundle, artifact_sha256)
        finally:
            if partial.exists():
                shutil.rmtree(partial, ignore_errors=True)
        manifest = self._manifest(
            evidence_id, job_input, frames, "all_indexed_frames_v1", input_sha256,
            artifact_sha256, protocol, "json", None, None, len(artifact_bytes),
        )
        return {
            "evidence_id": evidence_id,
            "manifest": manifest,
            "artifact_path": str(bundle / "manifest.json"),
            "published_root": str(bundle),
            "artifact_mime_type": "application/json",
        }, created

    def _manifest(self, evidence_id, job_input, frames, strategy, input_sha256, artifact_sha256,
                  protocol, format_name, width, height, byte_size):
        return {
            "candidate_key": job_input["candidate_key"],
            "file_id": job_input["file_id"],
            "file_generation": job_input["file_generation"],
            "asset_id": job_input["asset_id"],
            "scene_id": job_input["scene_id"],
            "frame_asset_ids": [frame["asset_id"] for frame in frames],
            "frame_time_seconds": [frame["frame_time_seconds"] for frame in frames],
            "strategy": strategy,
            "protocol_version": PROTOCOL_VERSION,
            "frame_count": len(frames),
            "input_sha256": input_sha256,
            "artifact_sha256": artifact_sha256,
            "artifact_id": f"candidate-evidence/{evidence_id}/artifact",
            "protocol_parameters": protocol,
            "format": format_name,
            "width": width,
            "height": height,
            "byte_size": byte_size,
        }

    def _publish_file(self, target, content, expected_sha256):
        # 普通 os.rename 在 POSIX 上会覆盖既有文件，违反证据不可覆盖规则。这里使用
        # 同一文件系统的硬链接作为原子 no-replace 发布：目标名要么一次出现，要么保持不存在；
        # 随后删除唯一 partial 名称。产物字节不经过第二次复制。
        if target.exists():
            if _sha256(target.read_bytes()) != expected_sha256:
                raise JobError(
                    "EVIDENCE_ARTIFACT_CONFLICT",
                    "已存在的候选证据文件指纹不匹配",
                    {"stage": "artifact_publish"},
                )
            return False
        partial = target.with_name(f".{target.name}.{uuid4().hex}.partial")
        published = False
        try:
            partial.write_bytes(content)
            try:
                os.link(partial, target)
                published = True
            except FileExistsError:
                if _sha256(target.read_bytes()) != expected_sha256:
                    raise JobError(
                        "EVIDENCE_ARTIFACT_CONFLICT",
                        "并发发布的候选证据文件指纹不匹配",
                        {"stage": "artifact_publish"},
                    )
                return False
            return True
        finally:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                # 目标硬链接已经完整可见时，partial 名称清理失败不能反过来把成功
                # 证据标为 failed。遗留 partial 不被数据库引用，也不会由 artifact API 暴露。
                if not published:
                    raise

    def _publish_bundle(self, partial, target, expected_sha256):
        if target.exists():
            if not self._verify_existing_bundle(target, expected_sha256):
                raise JobError(
                    "EVIDENCE_ARTIFACT_CONFLICT",
                    "已存在的候选证据清单指纹不匹配",
                    {"stage": "artifact_publish"},
                )
            return False
        try:
            os.rename(partial, target)
            return True
        except OSError:
            if not target.exists():
                raise
            if not self._verify_existing_bundle(target, expected_sha256):
                raise JobError(
                    "EVIDENCE_ARTIFACT_CONFLICT",
                    "并发发布的候选证据清单指纹不匹配",
                    {"stage": "artifact_publish"},
                )
            return False

    def _verify_existing_bundle(self, target, expected_sha256):
        """复用 bundle 前逐帧验证 manifest、相对路径和 PNG 内容指纹。"""
        manifest_path = target / "manifest.json"
        if not manifest_path.is_file():
            return False
        manifest_bytes = manifest_path.read_bytes()
        if _sha256(manifest_bytes) != expected_sha256:
            return False
        try:
            payload = json.loads(manifest_bytes)
            expected_paths = set()
            for frame in payload["frames"]:
                relative_path = Path(frame["relative_path"])
                if relative_path.is_absolute() or ".." in relative_path.parts:
                    return False
                expected_paths.add(relative_path.as_posix())
                frame_path = target / relative_path
                if (
                    frame_path.is_symlink()
                    or not frame_path.is_file()
                    or _sha256(frame_path.read_bytes()) != frame["frame_sha256"]
                ):
                    return False
            actual_paths = {
                path.relative_to(target).as_posix()
                for path in (target / "frames").rglob("*")
                if path.is_file()
            }
            if actual_paths != expected_paths:
                return False
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False
        return True

    def _raise_if_cancelled(self, job_id):
        if self.cancellation_checker(job_id):
            from .errors import JobCancelled

            raise JobCancelled("候选证据构建已取消")
