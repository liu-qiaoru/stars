import hashlib
import math
import os
import uuid


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
}

SCENE_MIN_SECONDS = 3.0
SCENE_MAX_COUNT = 2000
SCENE_DETECT_THRESHOLD = 27.0
KEYFRAME_DENSITIES = {"light", "balanced", "dense"}
KEYFRAME_DENSITY = "dense"


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
    detector = ContentDetector(threshold=threshold, min_scene_len=max(1, int(min_scene_seconds)))
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
        scene_max_count=None,
        keyframe_density=None,
        job_repository=None,
    ):
        self.repository = repository
        self.job_repository = job_repository
        self.scene_detector = scene_detector
        self.scene_min_seconds = float(scene_min_seconds or os.environ.get("SCENE_MIN_SECONDS", SCENE_MIN_SECONDS))
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
            self.repository.invalidate_video_index_assets(file["id"], invalidation_strategy, self.keyframe_density)

        for asset_input in asset_inputs:
            # Create/refresh the PostgreSQL asset first, then derive a stable Qdrant point id from that asset.
            collection_name = asset_input.pop("collection_name")
            config = VECTOR_CONFIGS[collection_name]
            asset = self.repository.upsert_media_asset(**asset_input)
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
            if collection_name not in collections:
                collections.append(collection_name)

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

        return {
            "assets_created": assets_created,
            "vector_refs_created": vector_refs_created,
            "collections": collections,
            "segment_strategy": actual_strategy,
            "fallback": fallback,
            **({"fallback_reason": fallback_reason} if fallback_reason else {}),
            **({"scenes_detected": scenes_detected} if media_type == "video" else {}),
            **({"keyframes_selected": keyframes_selected} if media_type == "video" else {}),
            **({"keyframe_density": self.keyframe_density} if media_type == "video" else {}),
        }

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
        scenes = [] if fallback_reason else merge_short_scenes(detected, min_seconds=self.scene_min_seconds)
        if fallback_reason is None and not scenes:
            fallback_reason = "PySceneDetect returned no usable scenes"

        if fallback_reason:
            return self._fixed_30s_asset_inputs(file, "fixed_30s_fallback"), "fixed_30s", True, fallback_reason, 0, 0

        asset_inputs = []
        keyframes_selected = 0
        for index, (start, end) in enumerate(scenes, start=1):
            scene_id = f"scene-{index:04d}"
            midpoint = (start + end) / 2.0
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_segment",
                "start_time_seconds": start,
                "end_time_seconds": end,
                "content_hash": f"{file['id']}:scene:{scene_id}:{start:g}:{end:g}",
                "metadata_json": {
                    "scene_id": scene_id,
                    "keyframe_index": 0,
                    "segment_strategy": "scene_detection",
                    "keyframe_density": self.keyframe_density,
                    "representative_frame_time_seconds": midpoint,
                },
                "collection_name": "video_segment_vectors",
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
                        "scene_id": scene_id,
                        "keyframe_index": keyframe_index,
                        "segment_strategy": "scene_detection",
                        "keyframe_density": self.keyframe_density,
                    },
                    "collection_name": "video_frame_vectors",
                })
                keyframes_selected += 1

        return asset_inputs, "scene_detection", False, None, len(scenes), keyframes_selected

    def _fixed_30s_asset_inputs(self, file, segment_strategy):
        asset_inputs = []
        for start, end in fixed_30s_segments(file.get("duration_seconds")):
            asset_inputs.append({
                "file_id": file["id"],
                "asset_type": "video_segment",
                "start_time_seconds": start,
                "end_time_seconds": end,
                "content_hash": f"{file['id']}:segment:{start:g}:{end:g}",
                "metadata_json": {
                    "scene_id": None,
                    "keyframe_index": 0,
                    "segment_strategy": segment_strategy,
                    "keyframe_density": self.keyframe_density,
                },
                "collection_name": "video_segment_vectors",
            })
        return asset_inputs
