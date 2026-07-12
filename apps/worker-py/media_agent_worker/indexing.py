import hashlib
import logging
import math
import os
import uuid


logger = logging.getLogger(__name__)


POINT_NAMESPACE = uuid.UUID("f3f4e35a-688d-4f79-99e0-91f9480a5827")

# Must stay aligned with apps/server/src/qdrant/vector-collections.ts.
# Python writes Qdrant points; TypeScript reads collections and hydrates metadata.
VECTOR_CONFIGS = {
    "image_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "image_embedding",
        "distance": "Cosine",
    },
    "video_segment_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "representative_frame_embedding",
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

SCENE_MIN_SECONDS = 3.0
SCENE_MAX_SECONDS = 30.0
SCENE_MAX_COUNT = 2000
SCENE_DETECT_THRESHOLD = 27.0
KEYFRAME_DENSITIES = {"light", "balanced", "dense"}
KEYFRAME_DENSITY = "dense"
VIDEO_INDEX_LAYOUT_VERSION = "scene-frames-v2"


def env_flag(name, default="false"):
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def deterministic_point_id(*, asset_id, collection_name, model_name, model_version, vector_kind, content_hash):
    # UUIDv5 makes Qdrant upserts idempotent across retries and across TS/Python implementations.
    joined = "|".join([asset_id, collection_name, model_name, model_version, vector_kind, content_hash])
    return str(uuid.uuid5(POINT_NAMESPACE, joined))


def fixed_30s_segments(duration_seconds):
    if duration_seconds is None:
        return []
    start = 0.0
    segments = []
    while start < duration_seconds:
        end = min(start + 30.0, duration_seconds)
        segments.append((start, end))
        start = end
    return segments


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
        raise RuntimeError("PySceneDetect is not installed. Install scenedetect to enable scene detection.") from error

    # PySceneDetect returns timecode objects; the rest of the worker stores plain
    # seconds so media_assets, vector payloads, and FFmpeg frame extraction agree.
    detector = ContentDetector(threshold=threshold, min_scene_len=f"{float(min_scene_seconds)}s")
    scenes = detect(path, detector)
    return [(start.get_seconds(), end.get_seconds()) for start, end in scenes]


def merge_short_scenes(scenes, *, min_seconds=SCENE_MIN_SECONDS):
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


def extra_keyframe_times(start, end, density=KEYFRAME_DENSITY):
    duration = end - start
    if density == "dense":
        if duration <= 8.0:
            return distributed_keyframe_times(start, end, 1)
        if duration <= 30.0:
            return distributed_keyframe_times(start, end, 2)
        if duration <= 90.0:
            return distributed_keyframe_times(start, end, min(6, max(3, math.ceil(duration / 12.0))))
        return distributed_keyframe_times(start, end, min(10, max(6, math.ceil(duration / 15.0))))
    if density == "balanced":
        if duration <= 8.0:
            return distributed_keyframe_times(start, end, 1)
        if duration <= 30.0:
            return distributed_keyframe_times(start, end, 2)
        if duration <= 90.0:
            return distributed_keyframe_times(start, end, min(4, max(2, math.ceil(duration / 18.0))))
        return distributed_keyframe_times(start, end, min(6, max(4, math.ceil(duration / 24.0))))
    if duration <= 15.0:
        return []
    if duration <= 45.0:
        return [start + duration / 3.0]
    return [start + duration / 3.0, start + (duration * 2.0) / 3.0]


def distributed_keyframe_times(start, end, count):
    if count <= 0:
        return []
    duration = end - start
    candidate_count = count + 1
    fractions = [
        (index + 1) / (candidate_count + 1)
        for index in range(candidate_count)
    ]
    selected = [fraction for fraction in fractions if abs(fraction - 0.5) > 0.001][:count]
    return [start + duration * fraction for fraction in selected]


def normalize_keyframe_density(value):
    density = (value or KEYFRAME_DENSITY).strip().lower()
    if density not in KEYFRAME_DENSITIES:
        return KEYFRAME_DENSITY
    return density


class IndexMediaHandler:
    """Create media_assets and pending vector_refs for image/video files.

    The handler does not run the model. It prepares deterministic assets and refs; embedding jobs do the heavy work.
    """

    def __init__(
        self,
        repository,
        *,
        scene_detector=detect_scenes_pyscenedetect,
        scene_min_seconds=None,
        scene_max_seconds=None,
        scene_max_count=None,
        keyframe_density=None,
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
        self.keyframe_density = normalize_keyframe_density(keyframe_density or os.environ.get("KEYFRAME_DENSITY"))

    def handle(self, job_input):
        file = self.repository.get_media_file(job_input["file_id"])
        media_type = file["media_type"]
        index_profile = job_input["index_profile"]
        requested_strategy = job_input.get("segment_strategy", "fixed_30s")
        actual_strategy = requested_strategy
        fallback = False
        fallback_reason = None
        scenes_detected = 0
        keyframes_selected = 0
        collections = []
        assets_created = 0
        vector_refs_created = 0
        ocr_asset_ids = []
        caption_source_asset_ids = []
        scene_caption_source_asset_ids = set()
        segment_assets_by_scene_id = {}
        newly_indexed_scene_ids = set()
        segment_vector_refs_staled = 0

        if media_type == "image":
            asset_inputs = [
                {
                    "file_id": file["id"],
                    "asset_type": "image",
                    "path": file["path"],
                    "content_hash": file_content_hash(file["path"]),
                    "collection_name": "image_vectors",
                }
            ]
        elif media_type == "video":
            asset_inputs, actual_strategy, fallback, fallback_reason, scenes_detected, keyframes_selected = self._video_asset_inputs(
                file,
                requested_strategy,
            )
        else:
            raise ValueError(f"Unsupported index media type: {media_type}")

        if media_type == "video" and hasattr(self.repository, "invalidate_video_index_assets"):
            invalidation_strategy = "scene_detection" if actual_strategy == "scene_detection" else (
                "fixed_30s_fallback" if fallback else "fixed_30s"
            )
            # Strategy changes can produce a different segment/frame graph. Mark
            # only the old graph stale before upserting the new deterministic assets.
            self.repository.invalidate_video_index_assets(
                file["id"],
                invalidation_strategy,
                self.keyframe_density,
                VIDEO_INDEX_LAYOUT_VERSION,
            )
        if media_type == "video" and hasattr(self.repository, "mark_video_segment_vector_refs_stale"):
            segment_vector_refs_staled = self.repository.mark_video_segment_vector_refs_stale(file["id"])

        for asset_input in asset_inputs:
            # Create/refresh the PostgreSQL asset first, then derive a stable Qdrant point id from that asset.
            collection_name = asset_input.pop("collection_name", None)
            asset = self.repository.upsert_media_asset(**asset_input)
            scene_id = asset_input.get("metadata_json", {}).get("scene_id")
            if asset["asset_type"] == "video_segment" and isinstance(scene_id, str):
                segment_assets_by_scene_id[scene_id] = asset
            if collection_name is None:
                continue
            config = VECTOR_CONFIGS[collection_name]
            content_hash = asset_input["content_hash"]
            point_id = deterministic_point_id(
                asset_id=asset["id"],
                collection_name=collection_name,
                model_name=config["model_name"],
                model_version=config["model_version"],
                vector_kind=config["vector_kind"],
                content_hash=content_hash,
            )
            outcome = self.repository.upsert_vector_ref(
                asset_id=asset["id"],
                file_id=file["id"],
                library_id=file["library_id"],
                collection_name=collection_name,
                point_id=point_id,
                model_name=config["model_name"],
                model_version=config["model_version"],
                vector_kind=config["vector_kind"],
                vector_dim=config["vector_dim"],
                distance=config["distance"],
                content_hash=content_hash,
                index_profile=index_profile,
            )
            if outcome == "created":
                assets_created += 1
                vector_refs_created += 1
                if asset["asset_type"] in ("image", "video_frame"):
                    ocr_asset_ids.append(asset["id"])
                if asset["asset_type"] == "video_frame" and isinstance(scene_id, str):
                    newly_indexed_scene_ids.add(scene_id)
                if (
                    self.job_repository is not None
                    and env_flag("CAPTION_INDEXING_ENABLED")
                    and env_flag("LOCAL_VLM_ENABLED")
                    and asset["asset_type"] in ("image", "video_segment")
                ):
                    caption_source_asset_ids.append(asset["id"])
            if collection_name not in collections:
                collections.append(collection_name)

        if (
            media_type == "video"
            and self.job_repository is not None
            and env_flag("CAPTION_INDEXING_ENABLED")
            and env_flag("LOCAL_VLM_ENABLED")
        ):
            for scene_id in sorted(newly_indexed_scene_ids):
                if scene_id not in segment_assets_by_scene_id:
                    continue
                source_asset_id = segment_assets_by_scene_id[scene_id]["id"]
                caption_source_asset_ids.append(source_asset_id)
                scene_caption_source_asset_ids.add(source_asset_id)

        if ocr_asset_ids and self.job_repository is not None:
            # OCR is asset-granular: image assets and selected video frames can be processed independently.
            self.job_repository.create_job(
                "run_ocr",
                {
                    "asset_ids": ocr_asset_ids,
                    "engine": os.environ.get("OCR_ENGINE", "paddleocr"),
                    "language": os.environ.get("OCR_LANGUAGE", "ch"),
                },
                timeout_seconds=7200,
            )

        if caption_source_asset_ids and self.job_repository is not None:
            for source_asset_id in caption_source_asset_ids:
                self.job_repository.create_job(
                    "generate_caption",
                    {
                        "file_id": file["id"],
                        "source_asset_ids": [source_asset_id],
                        "prompt_version": (
                            "scene-caption-v2"
                            if source_asset_id in scene_caption_source_asset_ids
                            else "caption-v1"
                        ),
                        "model_name": os.environ.get("LOCAL_VLM_MODEL_NAME", "Qwen/Qwen2.5-VL-7B-Instruct"),
                        "model_version": os.environ.get("LOCAL_VLM_MODEL_VERSION", "qwen2.5-vl-7b-instruct"),
                    },
                    timeout_seconds=7200,
                )

        outcome = {
            "assets_created": assets_created,
            "vector_refs_created": vector_refs_created,
            "collections": collections,
            "segment_strategy": actual_strategy,
            "fallback": fallback,
            **({"fallback_reason": fallback_reason} if fallback_reason else {}),
            **({"scenes_detected": scenes_detected} if media_type == "video" else {}),
            **({"keyframes_selected": keyframes_selected} if media_type == "video" else {}),
            **({"keyframe_density": self.keyframe_density} if media_type == "video" else {}),
            **({"segment_vector_refs_staled": segment_vector_refs_staled} if media_type == "video" else {}),
        }
        if media_type == "video":
            logger.info(
                "video_index file_id=%s strategy=%s fallback=%s scenes=%s keyframes=%s "
                "stale_segment_refs=%s fallback_reason=%s",
                file["id"],
                actual_strategy,
                fallback,
                scenes_detected,
                keyframes_selected,
                segment_vector_refs_staled,
                fallback_reason,
            )
        return outcome

    def _video_asset_inputs(self, file, requested_strategy):
        # scene_detection is best-effort. Any detector failure or unusable output falls back to fixed 30s segments.
        if requested_strategy != "scene_detection":
            return self._fixed_30s_asset_inputs(file, "fixed_30s"), "fixed_30s", False, None, 0, 0

        fallback_reason = None
        try:
            detected = self.scene_detector(file["path"])
        except Exception as error:
            fallback_reason = str(error)
            detected = []

        if fallback_reason is None and len(detected) > self.scene_max_count:
            fallback_reason = f"Scene count {len(detected)} exceeds max {self.scene_max_count}"
        # Keep scene_detection as a best-effort strategy: noisy/empty detector
        # output falls back to deterministic 30s segments instead of failing the job.
        merged_scenes = [] if fallback_reason else merge_short_scenes(detected, min_seconds=self.scene_min_seconds)
        if fallback_reason is None and not merged_scenes:
            fallback_reason = "PySceneDetect returned no usable scenes"

        if fallback_reason:
            return self._fixed_30s_asset_inputs(file, "fixed_30s_fallback"), "fixed_30s", True, fallback_reason, 0, 0

        scene_windows = split_long_scenes(merged_scenes, max_seconds=self.scene_max_seconds)
        asset_inputs = []
        keyframes_selected = 0
        for start, end, original_index, part_index, part_count in scene_windows:
            original_scene_id = f"scene-{original_index:04d}"
            scene_id = (
                original_scene_id
                if part_count == 1
                else f"{original_scene_id}-part-{part_index:03d}"
            )
            midpoint = (start + end) / 2.0
            shared_metadata = {
                "scene_id": scene_id,
                "original_scene_id": original_scene_id,
                "scene_part_index": part_index,
                "scene_part_count": part_count,
                "scene_max_seconds": self.scene_max_seconds,
                "segment_strategy": "scene_detection",
                "keyframe_density": self.keyframe_density,
                "index_layout_version": VIDEO_INDEX_LAYOUT_VERSION,
                "stale": False,
                "stale_reason": None,
            }
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_segment",
                "start_time_seconds": start,
                "end_time_seconds": end,
                "content_hash": f"{file['id']}:scene:{scene_id}:{start:g}:{end:g}",
                "metadata_json": {
                    **shared_metadata,
                    "keyframe_index": 0,
                    "representative_frame_time_seconds": midpoint,
                },
            })
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_frame",
                "frame_time_seconds": midpoint,
                "content_hash": f"{file['id']}:scene:{scene_id}:representative:{midpoint:g}",
                "metadata_json": {
                    **shared_metadata,
                    "keyframe_index": 0,
                    "is_scene_representative": True,
                },
                "collection_name": "video_frame_vectors",
            })
            for keyframe_index, frame_time in enumerate(extra_keyframe_times(start, end, self.keyframe_density), start=1):
                if abs(frame_time - midpoint) < 0.001:
                    continue
                asset_inputs.append({
                    "file_id": file["id"],
                    "asset_type": "video_frame",
                    "frame_time_seconds": frame_time,
                    "content_hash": f"{file['id']}:scene:{scene_id}:keyframe:{keyframe_index}:{frame_time:g}",
                    "metadata_json": {
                        **shared_metadata,
                        "keyframe_index": keyframe_index,
                        "is_scene_representative": False,
                    },
                    "collection_name": "video_frame_vectors",
                })
                keyframes_selected += 1

        return asset_inputs, "scene_detection", False, None, len(scene_windows), keyframes_selected

    def _fixed_30s_asset_inputs(self, file, segment_strategy):
        asset_inputs = []
        for segment_index, (start, end) in enumerate(fixed_30s_segments(file.get("duration_seconds")), start=1):
            scene_id = f"segment-{segment_index:04d}"
            midpoint = (start + end) / 2.0
            shared_metadata = {
                "scene_id": scene_id,
                "scene_part_index": 1,
                "scene_part_count": 1,
                "scene_max_seconds": self.scene_max_seconds,
                "segment_strategy": segment_strategy,
                "keyframe_density": self.keyframe_density,
                "index_layout_version": VIDEO_INDEX_LAYOUT_VERSION,
                "stale": False,
                "stale_reason": None,
            }
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_segment",
                "start_time_seconds": start,
                "end_time_seconds": end,
                "content_hash": f"{file['id']}:segment:{start:g}:{end:g}",
                "metadata_json": {
                    **shared_metadata,
                    "keyframe_index": 0,
                    "representative_frame_time_seconds": midpoint,
                },
            })
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_frame",
                "frame_time_seconds": midpoint,
                "content_hash": f"{file['id']}:segment:{scene_id}:representative:{midpoint:g}",
                "metadata_json": {
                    **shared_metadata,
                    "keyframe_index": 0,
                    "is_scene_representative": True,
                },
                "collection_name": "video_frame_vectors",
            })
        return asset_inputs
