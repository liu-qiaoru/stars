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


def select_uniform_frames(frames, max_frames):
    """从按时间排序的帧列表中稳定均匀选择最多 max_frames 帧（含首尾）。

    帧数 <= max_frames 时全部使用；超过时按等间距取 max_frames 帧，保证首尾被选中、结果稳定，
    让同一场景重复 Caption 不会因帧序变化产生不同输入。
    """
    if not frames:
        return []
    if len(frames) <= max_frames:
        return list(frames)
    if max_frames <= 1:
        # 只取一帧时选中点帧，避免总用首帧偏向场景开头。
        return [frames[len(frames) // 2]]
    # 等间距取 max_frames 个下标（含 0 与 n-1），去重保序。
    n = len(frames)
    indices = []
    for i in range(max_frames):
        index = round(i * (n - 1) / (max_frames - 1))
        if index not in indices:
            indices.append(index)
    return [frames[index] for index in indices]


class GenerateCaptionHandler:
    """生成图片或视频场景的 VLM Caption，并创建 caption_text_vectors pending 引用。

    阶段 2 起：
    - caption-v1 用于图片，输入 source_asset_ids（图片 asset）。
    - scene-caption-v2 用于视频场景，输入正式 video_scenes.id（scene_id）；Worker 通过该 UUID
      取按时间排序的场景帧，最多选 6 帧，调用现有 VLM；不再接受 video_segment 来源。
    成功写引用同 scene_id 的 caption asset 与 pending vector ref；失败/超时/异常都清理临时图片。
    """

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
        prompt_version = job_input.get("prompt_version", "caption-v1")
        file_id = job_input["file_id"]
        model_name = job_input.get("model_name")
        model_version = job_input.get("model_version")

        # 收集 VLM 输入（图片路径 + 帧时间）与回写所需的来源元数据。两条路径都保证临时图片在
        # 成功/失败/异常后被清理。
        if prompt_version == "caption-v1":
            source_asset_ids = job_input.get("source_asset_ids") or []
            if len(source_asset_ids) != 1:
                raise ValueError("caption-v1 requires exactly one image source_asset_id")
            source = self.repository.get_caption_source_asset(source_asset_ids[0])
            if source["asset_type"] != "image":
                raise ValueError(f"caption-v1 only supports image sources: {source['id']}")
            sources = [source]
            caption_sources, frame_times_seconds = self._image_caption_input(source)
            scene = None
        elif prompt_version == "scene-caption-v2":
            scene_id = job_input.get("scene_id")
            if not scene_id:
                raise ValueError("scene-caption-v2 requires a scene_id")
            scene = self.repository.get_video_scene(scene_id)
            frames = self.repository.list_scene_frames(scene_id)
            if not frames:
                raise ValueError(f"No video_frame assets for scene_id={scene_id}")
            max_frames = int(os.environ.get("SCENE_CAPTION_MAX_FRAMES", "6"))
            if max_frames < 1 or max_frames > 12:
                raise ValueError("SCENE_CAPTION_MAX_FRAMES must be between 1 and 12")
            selected = select_uniform_frames(frames, max_frames)
            caption_sources, frame_times_seconds = self._scene_caption_input(selected, scene)
            sources = selected
        else:
            raise ValueError(f"Unsupported prompt_version: {prompt_version}")

        extracted_paths = []
        image_paths = []
        try:
            for caption_source in caption_sources:
                image_path, extracted_path = self._image_path_for_source(caption_source)
                image_paths.append(image_path)
                if extracted_path is not None:
                    extracted_paths.append(extracted_path)
            try:
                response = self.vlm_client.caption(
                    image_paths=image_paths,
                    frame_times_seconds=frame_times_seconds,
                    prompt_version=prompt_version,
                    model_name=model_name,
                    model_version=model_version,
                )
            except Exception as error:
                logger.exception(
                    "caption_index_failed file_id=%s scene_id=%s prompt_version=%s error_class=%s",
                    file_id,
                    scene["id"] if scene else None,
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
        if vlm_model_name != model_name:
            raise ValueError(f"VLM returned model_name={vlm_model_name}, expected {model_name}")
        if vlm_model_version != model_version:
            raise ValueError(f"VLM returned model_version={vlm_model_version}, expected {model_version}")

        content_hash = self._caption_content_hash(
            sources=sources,
            frame_times_seconds=frame_times_seconds,
            prompt_version=prompt_version,
            vlm_model_version=vlm_model_version,
            caption=caption,
        )
        if scene is not None:
            # 视频场景 Caption：scene_id 外键 + 场景权威边界；library_id 来自场景所属文件。
            asset_file_id = scene["file_id"]
            library_id = scene["library_id"]
            scene_id = scene["id"]
            start_time_seconds = scene["start_time_seconds"]
            end_time_seconds = scene["end_time_seconds"]
            frame_time_seconds = None
            source_label = "vlm_scene_caption"
        else:
            asset_file_id = file_id
            library_id = source["library_id"]
            scene_id = None
            start_time_seconds = source.get("start_time_seconds")
            end_time_seconds = source.get("end_time_seconds")
            frame_time_seconds = source.get("frame_time_seconds")
            source_label = "vlm_caption"

        caption_asset = self.repository.upsert_media_asset(
            file_id=asset_file_id,
            asset_type="caption",
            scene_id=scene_id,
            path=None,
            start_time_seconds=start_time_seconds,
            end_time_seconds=end_time_seconds,
            frame_time_seconds=frame_time_seconds,
            content_hash=content_hash,
            text_content=caption,
            metadata_json={
                "source": source_label,
                "prompt_version": prompt_version,
                "vlm_model_name": vlm_model_name,
                "vlm_model_version": vlm_model_version,
                "frame_times_seconds": frame_times_seconds,
                "scene_id": scene_id,
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
            file_id=asset_file_id,
            library_id=library_id,
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
            "caption_index file_id=%s scene_id=%s prompt_version=%s model=%s/%s frames=%s",
            asset_file_id,
            scene_id,
            prompt_version,
            vlm_model_name,
            vlm_model_version,
            len(frame_times_seconds),
        )
        return {
            "caption_asset_id": caption_asset["id"],
            "source_assets": [caption_source["id"] for caption_source in caption_sources],
            "text_written": 1,
            "vector_ref_created": vector_outcome == "created",
        }

    def _image_caption_input(self, source):
        # caption-v1 是单图输入；帧时间为 None（VLM 只看图片本身）。
        return [source], [None]

    def _scene_caption_input(self, selected_frames, scene):
        # 视频场景按所选帧抽取临时图片；帧时间为绝对场景时间，按时间升序。
        caption_sources = []
        frame_times = []
        for frame in selected_frames:
            frame_time = frame.get("frame_time_seconds")
            if frame_time is None:
                raise ValueError(f"video_frame is missing frame_time_seconds: {frame['id']}")
            caption_sources.append(frame)
            frame_times.append(float(frame_time))
        return caption_sources, frame_times

    def _image_path_for_source(self, source):
        if not source.get("path"):
            raise ValueError(f"Caption source has no local path: {source['id']}")
        if source["asset_type"] == "image":
            return source["path"], None
        if source["asset_type"] == "video_frame":
            # 视频帧需要用 FFmpeg 抽到临时图片再送给 VLM；调用方负责清理临时文件。
            frame_time_seconds = self._required_frame_time(source)
            extracted_path = self.frame_extractor(source["path"], frame_time_seconds)
            return extracted_path, extracted_path
        raise ValueError(f"Unsupported caption source asset_type: {source['asset_type']}")

    def _required_frame_time(self, source):
        frame_time = source.get("frame_time_seconds")
        if frame_time is None:
            raise ValueError(f"video_frame is missing frame_time_seconds: {source['id']}")
        return float(frame_time)

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
            *[("" if frame_time is None else f"{frame_time:g}") for frame_time in frame_times_seconds],
            prompt_version,
            vlm_model_version,
            caption,
        ]
        digest.update("|".join(parts).encode("utf-8"))
        return digest.hexdigest()
