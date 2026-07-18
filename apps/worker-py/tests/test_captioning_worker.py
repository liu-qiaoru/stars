import tempfile
import unittest
from pathlib import Path

from media_agent_worker.captioning import GenerateCaptionHandler, select_uniform_frames


class FakeCaptionRepository:
    """内存版 repository，模拟阶段 2 后基于 video_scenes.id 的 Caption 来源。"""

    def __init__(self):
        self.source_assets = {}
        self.scenes = {}
        self.scene_frames = {}
        self.assets = []
        self.vector_refs = []

    def add_source_asset(self, asset):
        self.source_assets[asset["id"]] = asset

    def add_scene(self, scene):
        self.scenes[scene["id"]] = scene

    def add_scene_frame(self, frame):
        self.scene_frames.setdefault(frame["scene_id"], []).append(frame)

    def get_caption_source_asset(self, asset_id):
        return self.source_assets[asset_id]

    def get_video_scene(self, scene_id):
        return self.scenes[scene_id]

    def list_scene_frames(self, scene_id):
        return sorted(
            self.scene_frames.get(scene_id, []),
            key=lambda asset: asset["frame_time_seconds"],
        )

    def upsert_media_asset(self, **asset):
        stored = {"id": f"caption-{len(self.assets) + 1}", **asset}
        self.assets.append(stored)
        return stored

    def upsert_vector_ref(self, **vector_ref):
        self.vector_refs.append(vector_ref)
        return "created"


class FakeVlmClient:
    def __init__(self, caption="一只猫坐在窗边"):
        self.caption_text = caption
        self.calls = []

    def caption(self, *, image_paths, frame_times_seconds, prompt_version, model_name, model_version):
        self.calls.append({
            "image_paths": image_paths,
            "frame_times_seconds": frame_times_seconds,
            "prompt_version": prompt_version,
            "model_name": model_name,
            "model_version": model_version,
        })
        return {
            "model_name": model_name,
            "model_version": model_version,
            "prompt_version": prompt_version,
            "caption": self.caption_text,
        }


SCENE_ID = "scene-uuid-1"


def _image_source():
    return {
        "id": "image-1",
        "file_id": "file-1",
        "library_id": "library-1",
        "asset_type": "image",
        "path": "/media/cat.jpg",
        "start_time_seconds": None,
        "end_time_seconds": None,
        "frame_time_seconds": None,
        "content_hash": "image-hash",
        "metadata_json": {},
    }


def _scene():
    return {
        "id": SCENE_ID,
        "file_id": "file-1",
        "scene_key": "scene-0001",
        "start_time_seconds": 0.0,
        "end_time_seconds": 30.0,
        "index_generation": 0,
        "library_id": "library-1",
        "path": "/media/clip.mp4",
    }


class CaptioningWorkerTest(unittest.TestCase):
    def test_select_uniform_frames_keeps_all_when_at_or_below_max(self):
        frames = [{"id": f"f{i}"} for i in range(4)]
        self.assertEqual(select_uniform_frames(frames, 6), frames)

    def test_select_uniform_frames_picks_six_including_first_and_last(self):
        frames = [{"id": f"f{i}"} for i in range(12)]
        selected = select_uniform_frames(frames, 6)
        self.assertEqual(len(selected), 6)
        self.assertEqual(selected[0]["id"], "f0")
        self.assertEqual(selected[-1]["id"], "f11")

    def test_generate_caption_creates_caption_asset_and_pending_text_vector_ref(self):
        repository = FakeCaptionRepository()
        repository.add_source_asset(_image_source())
        vlm_client = FakeVlmClient()
        handler = GenerateCaptionHandler(repository, vlm_client=vlm_client)

        result = handler.handle({
            "file_id": "file-1",
            "source_asset_ids": ["image-1"],
            "prompt_version": "caption-v1",
            "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
            "model_version": "qwen2.5-vl-7b-instruct",
        })

        self.assertEqual(result["caption_asset_id"], "caption-1")
        self.assertEqual(result["text_written"], 1)
        caption_asset = repository.assets[0]
        self.assertEqual(caption_asset["asset_type"], "caption")
        self.assertIsNone(caption_asset["scene_id"])
        self.assertEqual(caption_asset["text_content"], "一只猫坐在窗边")
        self.assertEqual(caption_asset["metadata_json"]["source"], "vlm_caption")
        self.assertEqual(repository.vector_refs[0]["collection_name"], "caption_text_vectors")
        self.assertEqual(vlm_client.calls[0]["image_paths"], ["/media/cat.jpg"])

    def test_generate_caption_rejects_empty_vlm_caption(self):
        repository = FakeCaptionRepository()
        repository.add_source_asset(_image_source())
        handler = GenerateCaptionHandler(repository, vlm_client=FakeVlmClient(caption=" "))

        with self.assertRaisesRegex(ValueError, "empty caption"):
            handler.handle({
                "file_id": "file-1",
                "source_asset_ids": ["image-1"],
                "prompt_version": "caption-v1",
                "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                "model_version": "qwen2.5-vl-7b-instruct",
            })

        self.assertEqual(repository.assets, [])
        self.assertEqual(repository.vector_refs, [])

    def test_generate_scene_caption_uses_ordered_scene_frames_and_records_provenance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repository = FakeCaptionRepository()
            repository.add_scene(_scene())
            # 故意乱序加入，验证按时间排序后送 VLM。
            for asset_id, frame_time in [("frame-3", 25.0), ("frame-1", 5.0), ("frame-2", 15.0)]:
                repository.add_scene_frame({
                    "id": asset_id,
                    "file_id": "file-1",
                    "asset_type": "video_frame",
                    "scene_id": SCENE_ID,
                    "path": "/media/clip.mp4",
                    "frame_time_seconds": frame_time,
                    "content_hash": f"hash-{asset_id}",
                    "metadata_json": {},
                })
            extracted = []

            def frame_extractor(_source_path, frame_time_seconds):
                path = Path(tmp_dir) / f"frame-{frame_time_seconds:g}.jpg"
                path.write_bytes(b"frame")
                extracted.append(str(path))
                return str(path)

            vlm_client = FakeVlmClient(caption="歌手在舞台上持续演唱")
            handler = GenerateCaptionHandler(
                repository,
                vlm_client=vlm_client,
                frame_extractor=frame_extractor,
            )

            result = handler.handle({
                "file_id": "file-1",
                "scene_id": SCENE_ID,
                "prompt_version": "scene-caption-v2",
                "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                "model_version": "qwen2.5-vl-7b-instruct",
            })

            self.assertEqual(vlm_client.calls[0]["frame_times_seconds"], [5.0, 15.0, 25.0])
            self.assertEqual(vlm_client.calls[0]["image_paths"], extracted)
            self.assertTrue(all(not Path(path).exists() for path in extracted))
            caption_asset = repository.assets[0]
            self.assertEqual(caption_asset["asset_type"], "caption")
            # 视频 Caption 引用正式 scene_id 并使用场景权威边界。
            self.assertEqual(caption_asset["scene_id"], SCENE_ID)
            self.assertEqual(caption_asset["start_time_seconds"], 0.0)
            self.assertEqual(caption_asset["end_time_seconds"], 30.0)
            metadata = caption_asset["metadata_json"]
            self.assertEqual(metadata["source"], "vlm_scene_caption")
            self.assertEqual(metadata["scene_id"], SCENE_ID)
            self.assertEqual(metadata["frame_times_seconds"], [5.0, 15.0, 25.0])
            self.assertEqual(result["source_assets"], ["frame-1", "frame-2", "frame-3"])

    def test_generate_scene_caption_cleans_extracted_frames_when_vlm_fails(self):
        class FailingVlmClient(FakeVlmClient):
            def caption(self, **_kwargs):
                raise RuntimeError("VLM unavailable")

        with tempfile.TemporaryDirectory() as tmp_dir:
            repository = FakeCaptionRepository()
            repository.add_scene(_scene())
            for index, frame_time in enumerate((5.0, 15.0), start=1):
                repository.add_scene_frame({
                    "id": f"frame-{index}",
                    "file_id": "file-1",
                    "asset_type": "video_frame",
                    "scene_id": SCENE_ID,
                    "path": "/media/clip.mp4",
                    "frame_time_seconds": frame_time,
                    "content_hash": f"hash-{index}",
                    "metadata_json": {},
                })
            extracted = []

            def frame_extractor(_source_path, frame_time_seconds):
                path = Path(tmp_dir) / f"frame-{frame_time_seconds:g}.jpg"
                path.write_bytes(b"frame")
                extracted.append(str(path))
                return str(path)

            handler = GenerateCaptionHandler(repository, vlm_client=FailingVlmClient(), frame_extractor=frame_extractor)

            with self.assertRaisesRegex(RuntimeError, "VLM unavailable"):
                handler.handle({
                    "file_id": "file-1",
                    "scene_id": SCENE_ID,
                    "prompt_version": "scene-caption-v2",
                    "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                    "model_version": "qwen2.5-vl-7b-instruct",
                })

            # 失败路径也必须清理临时图片，且不写 caption 资产。
            self.assertTrue(all(not Path(path).exists() for path in extracted))
            self.assertEqual(repository.assets, [])


if __name__ == "__main__":
    unittest.main()
