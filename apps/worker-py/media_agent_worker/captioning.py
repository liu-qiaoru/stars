import hashlib
import json
import logging
import os
import urllib.request

from .embedding_worker import extract_video_frame
from .indexing import VECTOR_CONFIGS, deterministic_point_id


logger = logging.getLogger(__name__)


CAPTION_TEXT_VECTOR_CONFIG = {
    "collection_name": "caption_text_vectors",
    **VECTOR_CONFIGS["caption_text_vectors"],
}


class VlmCaptionClient:
    def __init__(self, base_url=None, timeout_seconds=120):
        self.base_url = (base_url or os.environ.get("LOCAL_VLM_SERVICE_URL") or "http://127.0.0.1:4030").rstrip("/")
        self.timeout_seconds = timeout_seconds

    def caption(self, *, image_paths, frame_times_seconds, prompt_version, model_name, model_version):
        payload = json.dumps({
            "image_paths": image_paths,
            "frame_times_seconds": frame_times_seconds,
            "prompt_version": prompt_version,
            "model_name": model_name,
            "model_version": model_version,
        }).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/caption",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"VLM /caption failed with HTTP {response.status}")
            return json.loads(response.read().decode("utf-8"))


class GenerateCaptionHandler:
    def __init__(
        self,
        repository,
        *,
        vlm_client=None,
        frame_extractor=extract_video_frame,
        index_profile=None,
    ):
        self.repository = repository
        self.vlm_client = vlm_client or VlmCaptionClient()
        self.frame_extractor = frame_extractor
        self.index_profile = index_profile or os.environ.get("CAPTION_INDEX_PROFILE", "balanced")

    def handle(self, job_input):
        source_asset_ids = job_input["source_asset_ids"]
        if len(source_asset_ids) != 1:
            raise ValueError("generate_caption currently supports exactly one source asset")
        prompt_version = job_input.get("prompt_version", "caption-v1")
        source = self.repository.get_caption_source_asset(source_asset_ids[0])
        image_paths = []
        extracted_paths = []
        try:
            caption_sources, frame_times_seconds = self._caption_sources(source, prompt_version)
            for caption_source in caption_sources:
                image_path, extracted_path = self._image_path_for_source(caption_source)
                image_paths.append(image_path)
                if extracted_path is not None:
                    extracted_paths.append(extracted_path)
            response = self.vlm_client.caption(
                image_paths=image_paths,
                frame_times_seconds=frame_times_seconds,
                prompt_version=prompt_version,
                model_name=job_input["model_name"],
                model_version=job_input["model_version"],
            )
        except Exception as error:
            logger.exception(
                "caption_index_failed file_id=%s source_asset_id=%s prompt_version=%s error_class=%s",
                job_input.get("file_id"),
                source_asset_ids[0],
                prompt_version,
                type(error).__name__,
            )
            raise
        finally:
            for extracted_path in extracted_paths:
                try:
                    os.unlink(extracted_path)
                except FileNotFoundError:
                    pass

        caption = response.get("caption")
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError("VLM returned empty caption")
        caption = caption.strip()
        vlm_model_name = response.get("model_name")
        vlm_model_version = response.get("model_version")
        if vlm_model_name != job_input["model_name"]:
            raise ValueError(f"VLM returned model_name={vlm_model_name}, expected {job_input['model_name']}")
        if vlm_model_version != job_input["model_version"]:
            raise ValueError(
                f"VLM returned model_version={vlm_model_version}, expected {job_input['model_version']}"
            )

        content_hash = self._caption_content_hash(
            sources=caption_sources,
            frame_times_seconds=frame_times_seconds,
            prompt_version=prompt_version,
            vlm_model_version=vlm_model_version,
            caption=caption,
        )
        caption_asset = self.repository.upsert_media_asset(
            file_id=job_input["file_id"],
            asset_type="caption",
            path=None,
            start_time_seconds=source.get("start_time_seconds"),
            end_time_seconds=source.get("end_time_seconds"),
            frame_time_seconds=source.get("frame_time_seconds"),
            content_hash=content_hash,
            text_content=caption,
            metadata_json={
                "source": "vlm_scene_caption" if prompt_version == "scene-caption-v2" else "vlm_caption",
                "scene_id": source.get("metadata_json", {}).get("scene_id"),
                "prompt_version": prompt_version,
                "vlm_model_name": vlm_model_name,
                "vlm_model_version": vlm_model_version,
                "source_asset_ids": [caption_source["id"] for caption_source in caption_sources],
                "frame_times_seconds": frame_times_seconds,
                "source_asset_type": source["asset_type"],
            },
        )
        config = CAPTION_TEXT_VECTOR_CONFIG
        point_id = deterministic_point_id(
            asset_id=caption_asset["id"],
            collection_name=config["collection_name"],
            model_name=config["model_name"],
            model_version=config["model_version"],
            vector_kind=config["vector_kind"],
            content_hash=content_hash,
        )
        vector_outcome = self.repository.upsert_vector_ref(
            asset_id=caption_asset["id"],
            file_id=job_input["file_id"],
            library_id=source["library_id"],
            collection_name=config["collection_name"],
            point_id=point_id,
            model_name=config["model_name"],
            model_version=config["model_version"],
            vector_kind=config["vector_kind"],
            vector_dim=config["vector_dim"],
            distance=config["distance"],
            content_hash=content_hash,
            index_profile=self.index_profile,
        )
        logger.info(
            "caption_index file_id=%s scene_id=%s prompt_version=%s model=%s/%s "
            "source_asset_ids=%s frame_times_seconds=%s",
            job_input["file_id"],
            source.get("metadata_json", {}).get("scene_id"),
            prompt_version,
            vlm_model_name,
            vlm_model_version,
            [caption_source["id"] for caption_source in caption_sources],
            frame_times_seconds,
        )
        return {
            "caption_asset_id": caption_asset["id"],
            "source_assets": [caption_source["id"] for caption_source in caption_sources],
            "text_written": 1,
            "vector_ref_created": vector_outcome == "created",
        }

    def _image_path_for_source(self, source):
        if not source.get("path"):
            raise ValueError(f"Caption source has no local path: {source['id']}")
        if source["asset_type"] == "image":
            return source["path"], None
        if source["asset_type"] in ("video_segment", "video_frame"):
            frame_time_seconds = self._representative_frame_time(source)
            extracted_path = self.frame_extractor(source["path"], frame_time_seconds)
            return extracted_path, extracted_path
        raise ValueError(f"Unsupported caption source asset_type: {source['asset_type']}")

    def _caption_sources(self, source, prompt_version):
        if prompt_version == "caption-v1":
            return [source], [self._optional_frame_time(source)]
        if prompt_version != "scene-caption-v2":
            raise ValueError(f"Unsupported prompt_version: {prompt_version}")
        if source["asset_type"] != "video_segment":
            raise ValueError("scene-caption-v2 requires a video_segment source")
        scene_id = source.get("metadata_json", {}).get("scene_id")
        if not isinstance(scene_id, str) or not scene_id:
            raise ValueError(f"video_segment is missing scene_id: {source['id']}")
        frames = self.repository.list_scene_caption_frames(source["file_id"], scene_id)
        max_frames = int(os.environ.get("SCENE_CAPTION_MAX_FRAMES", "6"))
        if max_frames < 1 or max_frames > 12:
            raise ValueError("SCENE_CAPTION_MAX_FRAMES must be between 1 and 12")
        if not frames:
            raise ValueError(f"No video_frame assets for file_id={source['file_id']} scene_id={scene_id}")
        if len(frames) > max_frames:
            raise ValueError(
                f"Scene frame count exceeds SCENE_CAPTION_MAX_FRAMES: "
                f"file_id={source['file_id']} scene_id={scene_id} frames={len(frames)} max={max_frames}"
            )
        frame_times = [self._required_frame_time(frame) for frame in frames]
        return frames, frame_times

    def _optional_frame_time(self, source):
        if source["asset_type"] == "image":
            return None
        return self._representative_frame_time(source)

    def _required_frame_time(self, source):
        frame_time = source.get("frame_time_seconds")
        if frame_time is None:
            raise ValueError(f"video_frame is missing frame_time_seconds: {source['id']}")
        return float(frame_time)

    def _representative_frame_time(self, source):
        metadata = source.get("metadata_json", {})
        if metadata.get("representative_frame_time_seconds") is not None:
            return float(metadata["representative_frame_time_seconds"])
        if source.get("frame_time_seconds") is not None:
            return float(source["frame_time_seconds"])
        if source.get("start_time_seconds") is not None and source.get("end_time_seconds") is not None:
            return (float(source["start_time_seconds"]) + float(source["end_time_seconds"])) / 2.0
        return 0.0

    def _caption_content_hash(
        self,
        *,
        sources,
        frame_times_seconds,
        prompt_version,
        vlm_model_version,
        caption,
    ):
        digest = hashlib.sha256()
        parts = [
            *[source["id"] for source in sources],
            *[(source.get("content_hash") or "") for source in sources],
            *[("" if frame_time is None else f"{frame_time:g}") for frame_time in frame_times_seconds],
            prompt_version,
            vlm_model_version,
            caption,
        ]
        digest.update("|".join(parts).encode("utf-8"))
        return digest.hexdigest()
