import hashlib
import logging
import math
import os
import uuid

from .errors import JobError


logger = logging.getLogger(__name__)


POINT_NAMESPACE = uuid.UUID("f3f4e35a-688d-4f79-99e0-91f9480a5827")

# Must stay aligned with apps/server/src/qdrant/vector-collections.ts.
# Python writes Qdrant points; TypeScript reads collections and hydrates metadata.
# 阶段 2 后只保留三个向量集合：图片、视频帧、Caption 文本；video_segment_vectors 已删除。
VECTOR_CONFIGS = {
    "image_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "image_embedding",
        "distance": "Cosine",
    },
    "video_frame_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "frame_embedding",
        "distance": "Cosine",
    },
    "caption_text_vectors": {
        "vector_dim": 384,
        "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
        "vector_kind": "vlm_caption_text_embedding",
        "distance": "Cosine",
    },
}

# 场景与抽帧配置（阶段 2 最终值）。
# SCENE_MIN_SECONDS 从旧的 3.0 降到 0.5：保留 >=0.5s 的短场景，更短的噪声边界并入相邻场景。
SCENE_MIN_SECONDS = 0.5
SCENE_MAX_SECONDS = 30.0
SCENE_MAX_COUNT = 2000
SCENE_DETECT_THRESHOLD = 27.0
# 唯一抽帧间隔；旧的 KEYFRAME_DENSITY 密度补帧已删除，所有场景统一按 2.5 秒区间中点抽帧。
VIDEO_FRAME_INTERVAL_SECONDS = 2.5
VIDEO_INDEX_LAYOUT_VERSION = "scene-frames-v3"

# 场景检测结构化错误码（与计划一致）。
SCENE_DETECTOR_UNAVAILABLE = "SCENE_DETECTOR_UNAVAILABLE"
VIDEO_DECODE_FAILED = "VIDEO_DECODE_FAILED"
INVALID_SCENE_BOUNDARIES = "INVALID_SCENE_BOUNDARIES"
SCENE_COUNT_EXCEEDED = "SCENE_COUNT_EXCEEDED"
VIDEO_DURATION_MISSING = "VIDEO_DURATION_MISSING"


def env_flag(name, default="false"):
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def deterministic_point_id(*, asset_id, collection_name, model_name, model_version, vector_kind, content_hash):
    # UUIDv5 makes Qdrant upserts idempotent across retries and across TS/Python implementations.
    joined = "|".join([asset_id, collection_name, model_name, model_version, vector_kind, content_hash])
    return str(uuid.uuid5(POINT_NAMESPACE, joined))


def file_content_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detect_scenes_pyscenedetect(path, *, threshold=SCENE_DETECT_THRESHOLD, min_scene_seconds=SCENE_MIN_SECONDS):
    try:
        from scenedetect import ContentDetector, detect
    except ImportError as error:
        # 检测器不可用属于环境问题，必须失败并通知用户，不回退到固定窗口。
        raise JobError(
            SCENE_DETECTOR_UNAVAILABLE,
            "PySceneDetect is not installed",
            {"reason": str(error)},
        ) from error

    # PySceneDetect 返回 timecode 对象；worker 其余部分统一存秒数，保证 media_assets、
    # Qdrant payload 和 FFmpeg 抽帧使用同一时间口径。视频解码错误以原始异常抛出，
    # 由 IndexMediaHandler._detect_scenes 统一转成 VIDEO_DECODE_FAILED。
    detector = ContentDetector(threshold=threshold, min_scene_len=f"{float(min_scene_seconds)}s")
    scenes = detect(path, detector)
    return [(start.get_seconds(), end.get_seconds()) for start, end in scenes]


def merge_short_scenes(scenes, *, min_seconds=SCENE_MIN_SECONDS):
    """合并 < min_seconds 的噪声场景到相邻场景。

    规则确定性、可测试：先把短场景并入前一个已合并场景（延伸其结束时间）；
    若是第一个场景且有后继，则与后继合并；否则单独保留。最后压实可能的重叠。
    """
    normalized = [(float(start), float(end)) for start, end in scenes if float(end) > float(start)]
    if not normalized:
        return []

    merged = []
    for start, end in normalized:
        duration = end - start
        if duration < min_seconds:
            if merged:
                previous_start, _previous_end = merged[-1]
                merged[-1] = (previous_start, end)
            elif len(normalized) > 1:
                next_start, next_end = normalized[1]
                merged.append((start, max(end, next_end)))
            else:
                merged.append((start, end))
            continue
        merged.append((start, end))

    compacted = []
    for start, end in merged:
        if compacted and start < compacted[-1][1]:
            previous_start, previous_end = compacted[-1]
            compacted[-1] = (previous_start, max(previous_end, end))
        else:
            compacted.append((start, end))
    return compacted


def split_long_scenes(scenes, *, max_seconds=SCENE_MAX_SECONDS):
    """把 > max_seconds 的场景拆成不重叠连续窗口。

    返回 (start, end, original_index, part_index, part_count) 五元组列表，
    保留原始场景编号，便于派生稳定的 scene_key。
    """
    if max_seconds <= 0:
        raise ValueError("SCENE_MAX_SECONDS must be positive")
    windows = []
    for original_index, (start, end) in enumerate(scenes, start=1):
        start = float(start)
        end = float(end)
        part_count = max(1, math.ceil((end - start) / max_seconds))
        part_start = start
        for part_index in range(1, part_count + 1):
            part_end = min(part_start + max_seconds, end)
            windows.append((part_start, part_end, original_index, part_index, part_count))
            part_start = part_end
    return windows


def sample_frame_times(start_seconds, end_seconds, interval_seconds=VIDEO_FRAME_INTERVAL_SECONDS):
    """把场景划分为最长 interval_seconds 的区间并取每段中点。

    - 30 秒场景得到 12 帧；最后不足一个区间也取中点。
    - 0.5 秒场景至少得到一帧（中点）。
    - 所有帧严格位于 [start, end) 内。
    """
    start_seconds = float(start_seconds)
    end_seconds = float(end_seconds)
    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be positive")
    if end_seconds <= start_seconds:
        return []
    times = []
    window_start = start_seconds
    while window_start < end_seconds:
        window_end = min(window_start + interval_seconds, end_seconds)
        midpoint = (window_start + window_end) / 2.0
        times.append(midpoint)
        window_start = window_end
    return times


def validate_scene_boundaries(scenes, *, duration_seconds):
    """校验场景边界有限、递增、不越过视频时长且无非法重叠。任一不满足都视为索引数据损坏。"""
    if duration_seconds is None:
        raise JobError(VIDEO_DURATION_MISSING, "Video duration is missing")
    previous_end = None
    for start, end in scenes:
        if not math.isfinite(start) or not math.isfinite(end):
            raise JobError(INVALID_SCENE_BOUNDARIES, "Scene boundary is not finite", {"start": start, "end": end})
        if end <= start:
            raise JobError(INVALID_SCENE_BOUNDARIES, "Scene end must be greater than start", {"start": start, "end": end})
        if start < 0 or end > float(duration_seconds) + 1e-6:
            raise JobError(INVALID_SCENE_BOUNDARIES, "Scene boundary exceeds video duration", {"start": start, "end": end, "duration": duration_seconds})
        if previous_end is not None and start < previous_end - 1e-6:
            raise JobError(INVALID_SCENE_BOUNDARIES, "Scenes overlap", {"start": start, "previous_end": previous_end})
        previous_end = end
    return True


def strategy_fingerprint(threshold, min_seconds, max_seconds, interval_seconds):
    """对场景检测与抽帧参数取稳定指纹，写入 video_scenes.strategy_fingerprint。

    参数变化意味着旧场景/帧图不再可比，重索引时据此失效旧派生数据。
    """
    digest = hashlib.sha256()
    digest.update(
        "|".join(
            [
                f"threshold={float(threshold):g}",
                f"min_seconds={float(min_seconds):g}",
                f"max_seconds={float(max_seconds):g}",
                f"interval_seconds={float(interval_seconds):g}",
                f"layout={VIDEO_INDEX_LAYOUT_VERSION}",
            ]
        ).encode("utf-8")
    )
    return digest.hexdigest()


class IndexMediaHandler:
    """Create video_scenes / media_assets / pending vector_refs for image/video files.

    Handler 只准备确定性场景、资产与引用；真正的模型推理由 embed_* 和 generate_caption 任务完成。
    阶段 2 起：视频只走 PySceneDetect 场景检测，写 video_scenes 行，再为每个场景按 2.5 秒抽帧
    创建引用场景 UUID 的 video_frame asset；不再有 fixed_30s 回退、video_segment 资产或 OCR 任务。
    """

    def __init__(
        self,
        repository,
        *,
        scene_detector=detect_scenes_pyscenedetect,
        scene_min_seconds=None,
        scene_max_seconds=None,
        scene_max_count=None,
        frame_interval_seconds=None,
        job_repository=None,
    ):
        self.repository = repository
        self.job_repository = job_repository
        self.scene_detector = scene_detector
        self.scene_min_seconds = float(scene_min_seconds or os.environ.get("SCENE_MIN_SECONDS", SCENE_MIN_SECONDS))
        self.scene_max_seconds = float(scene_max_seconds or os.environ.get("SCENE_MAX_SECONDS", SCENE_MAX_SECONDS))
        if self.scene_max_seconds <= 0:
            raise ValueError("SCENE_MAX_SECONDS must be positive")
        self.scene_max_count = int(scene_max_count or os.environ.get("SCENE_MAX_COUNT", SCENE_MAX_COUNT))
        self.frame_interval_seconds = float(
            frame_interval_seconds or os.environ.get("VIDEO_FRAME_INTERVAL_SECONDS", VIDEO_FRAME_INTERVAL_SECONDS)
        )
        if self.frame_interval_seconds <= 0:
            raise ValueError("VIDEO_FRAME_INTERVAL_SECONDS must be positive")

    def handle(self, job_input):
        file = self.repository.get_media_file(job_input["file_id"])
        media_type = file["media_type"]
        index_profile = job_input["index_profile"]

        if media_type == "image":
            collections, assets_created, vector_refs_created = self._index_image(file, index_profile)
            outcome = {
                "assets_created": assets_created,
                "vector_refs_created": vector_refs_created,
                "collections": collections,
            }
            self._maybe_create_caption_jobs(file, image_asset_created=assets_created > 0)
            return outcome

        if media_type == "video":
            return self._index_video(file, index_profile)

        raise ValueError(f"Unsupported index media type: {media_type}")

    def _index_image(self, file, index_profile):
        asset_input = {
            "file_id": file["id"],
            "asset_type": "image",
            "path": file["path"],
            "content_hash": file_content_hash(file["path"]),
        }
        asset = self.repository.upsert_media_asset(**asset_input)
        created = asset.get("_created", False)
        config = VECTOR_CONFIGS["image_vectors"]
        point_id = deterministic_point_id(
            asset_id=asset["id"],
            collection_name="image_vectors",
            model_name=config["model_name"],
            model_version=config["model_version"],
            vector_kind=config["vector_kind"],
            content_hash=asset_input["content_hash"],
        )
        outcome = self.repository.upsert_vector_ref(
            asset_id=asset["id"],
            file_id=file["id"],
            library_id=file["library_id"],
            collection_name="image_vectors",
            point_id=point_id,
            model_name=config["model_name"],
            model_version=config["model_version"],
            vector_kind=config["vector_kind"],
            vector_dim=config["vector_dim"],
            distance=config["distance"],
            content_hash=asset_input["content_hash"],
            index_profile=index_profile,
        )
        assets_created = 1 if created else 0
        vector_refs_created = 1 if outcome == "created" else 0
        self._image_asset_id = asset["id"]
        return ["image_vectors"], assets_created, vector_refs_created

    def _index_video(self, file, index_profile):
        # 失效上一轮派生数据：阶段 2 用 video_scenes/index_generation 表达场景身份，
        # 旧的 invalidate_video_index_assets（基于 segment_strategy/keyframe_density）已删除。
        if hasattr(self.repository, "invalidate_video_scenes"):
            self.repository.invalidate_video_scenes(file["id"], file.get("index_generation", 0))

        scenes = self._detect_scenes(file)
        scene_windows = split_long_scenes(scenes, max_seconds=self.scene_max_seconds)
        fingerprint = strategy_fingerprint(
            SCENE_DETECT_THRESHOLD, self.scene_min_seconds, self.scene_max_seconds, self.frame_interval_seconds
        )
        index_generation = file.get("index_generation", 0)

        collections = []
        assets_created = 0
        vector_refs_created = 0
        frames_created = 0
        created_scene_ids = []
        for start, end, original_index, part_index, part_count in scene_windows:
            scene_key = (
                f"scene-{original_index:04d}"
                if part_count == 1
                else f"scene-{original_index:04d}-part-{part_index:03d}"
            )
            scene = self.repository.upsert_video_scene(
                file_id=file["id"],
                scene_key=scene_key,
                start_time_seconds=start,
                end_time_seconds=end,
                detection_strategy="scene_detection",
                strategy_fingerprint=fingerprint,
                index_generation=index_generation,
            )
            scene_id = scene["id"]
            created_scene_ids.append(scene_id)
            for frame_index, frame_time in enumerate(
                sample_frame_times(start, end, self.frame_interval_seconds), start=1
            ):
                frame_hash = f"{file['id']}:scene:{scene_key}:{frame_time:g}"
                asset = self.repository.upsert_media_asset(
                    file_id=file["id"],
                    asset_type="video_frame",
                    scene_id=scene_id,
                    frame_time_seconds=frame_time,
                    content_hash=frame_hash,
                    metadata_json={
                        "scene_key": scene_key,
                        "frame_index": frame_index,
                        "is_scene_representative": frame_index == 1,
                        "index_layout_version": VIDEO_INDEX_LAYOUT_VERSION,
                        "stale": False,
                    },
                )
                if asset.get("_created"):
                    assets_created += 1
                config = VECTOR_CONFIGS["video_frame_vectors"]
                point_id = deterministic_point_id(
                    asset_id=asset["id"],
                    collection_name="video_frame_vectors",
                    model_name=config["model_name"],
                    model_version=config["model_version"],
                    vector_kind=config["vector_kind"],
                    content_hash=frame_hash,
                )
                ref_outcome = self.repository.upsert_vector_ref(
                    asset_id=asset["id"],
                    file_id=file["id"],
                    library_id=file["library_id"],
                    collection_name="video_frame_vectors",
                    point_id=point_id,
                    model_name=config["model_name"],
                    model_version=config["model_version"],
                    vector_kind=config["vector_kind"],
                    vector_dim=config["vector_dim"],
                    distance=config["distance"],
                    content_hash=frame_hash,
                    index_profile=index_profile,
                )
                if ref_outcome == "created":
                    vector_refs_created += 1
                frames_created += 1
            if "video_frame_vectors" not in collections:
                collections.append("video_frame_vectors")

        logger.info(
            "video_index file_id=%s scenes=%s frames=%s generation=%s",
            file["id"],
            len(scene_windows),
            frames_created,
            index_generation,
        )

        self._maybe_create_caption_jobs(file, scene_ids=created_scene_ids)

        return {
            "assets_created": assets_created,
            "vector_refs_created": vector_refs_created,
            "collections": collections,
            "scenes_detected": len(scene_windows),
            "frames_created": frames_created,
        }

    def _detect_scenes(self, file):
        duration_seconds = file.get("duration_seconds")
        if duration_seconds is None:
            raise JobError(VIDEO_DURATION_MISSING, "Video duration is missing; run probe_media first")
        try:
            detected = self.scene_detector(file["path"])
        except JobError:
            # 检测器自身抛出的结构化错误（如 SCENE_DETECTOR_UNAVAILABLE）直接向上传播。
            raise
        except Exception as error:
            # 视频解码失败（损坏文件、缺少解码器）是确定性失败，不回退到固定窗口。
            raise JobError(
                VIDEO_DECODE_FAILED,
                "Video decode failed during scene detection",
                {"reason": str(error)},
            ) from error
        # PySceneDetect 成功但没有镜头转换时，整个视频是一个原始场景。
        if not detected:
            detected = [(0.0, float(duration_seconds))]
        merged = merge_short_scenes(detected, min_seconds=self.scene_min_seconds)
        if not merged:
            raise JobError(INVALID_SCENE_BOUNDARIES, "Scene detection produced no usable scenes")
        validate_scene_boundaries(merged, duration_seconds=duration_seconds)
        if len(merged) > self.scene_max_count:
            raise JobError(
                SCENE_COUNT_EXCEEDED,
                f"Scene count {len(merged)} exceeds max {self.scene_max_count}",
                {"count": len(merged), "max": self.scene_max_count},
            )
        return merged

    def _maybe_create_caption_jobs(self, file, *, image_asset_created=False, scene_ids=None):
        if self.job_repository is None:
            return
        if not (env_flag("CAPTION_INDEXING_ENABLED") and env_flag("LOCAL_VLM_ENABLED")):
            return
        model_name = os.environ.get("LOCAL_VLM_MODEL_NAME", "Qwen/Qwen2.5-VL-7B-Instruct")
        model_version = os.environ.get("LOCAL_VLM_MODEL_VERSION", "qwen2.5-vl-7b-instruct")
        # 图片 Caption 用 caption-v1 单图输入；视频场景 Caption 用 scene-caption-v2 + 正式 scene_id。
        if image_asset_created and getattr(self, "_image_asset_id", None):
            self.job_repository.create_job(
                "generate_caption",
                {
                    "file_id": file["id"],
                    "prompt_version": "caption-v1",
                    "source_asset_ids": [self._image_asset_id],
                    "model_name": model_name,
                    "model_version": model_version,
                },
                timeout_seconds=7200,
            )
        for scene_id in scene_ids or []:
            self.job_repository.create_job(
                "generate_caption",
                {
                    "file_id": file["id"],
                    "prompt_version": "scene-caption-v2",
                    "scene_id": scene_id,
                    "model_name": model_name,
                    "model_version": model_version,
                },
                timeout_seconds=7200,
            )
