import tempfile
import unittest
from pathlib import Path

from media_agent_worker.captioning import GenerateCaptionHandler


class FakeCaptionRepository:
    def __init__(self):
        self.source_assets = {}
        self.assets = []
        self.vector_refs = []

    def add_source_asset(self, asset):
        self.source_assets[asset["id"]] = asset

    def get_caption_source_asset(self, asset_id):
        return self.source_assets[asset_id]

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

    def caption(self, *, image_path, prompt_version, model_name, model_version):
        self.calls.append({
            "image_path": image_path,
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


class CaptioningWorkerTest(unittest.TestCase):
    def test_generate_caption_creates_caption_asset_and_pending_text_vector_ref(self):
        repository = FakeCaptionRepository()
        repository.add_source_asset({
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
        })
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
        self.assertEqual(repository.assets[0]["asset_type"], "caption")
        self.assertEqual(repository.assets[0]["text_content"], "一只猫坐在窗边")
        self.assertEqual(repository.assets[0]["metadata_json"]["source"], "vlm_caption")
        self.assertEqual(repository.vector_refs[0]["collection_name"], "caption_text_vectors")
        self.assertEqual(repository.vector_refs[0]["asset_id"], "caption-1")
        self.assertEqual(vlm_client.calls[0]["image_path"], "/media/cat.jpg")

    def test_generate_video_caption_deletes_temporary_frame_after_success(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            frame_path = Path(tmp_dir) / "frame.jpg"
            repository = FakeCaptionRepository()
            repository.add_source_asset({
                "id": "segment-1",
                "file_id": "file-1",
                "library_id": "library-1",
                "asset_type": "video_segment",
                "path": "/media/clip.mp4",
                "start_time_seconds": 10.0,
                "end_time_seconds": 20.0,
                "frame_time_seconds": None,
                "content_hash": "segment-hash",
                "metadata_json": {},
            })

            def frame_extractor(source_path, frame_time_seconds):
                self.assertEqual(source_path, "/media/clip.mp4")
                self.assertEqual(frame_time_seconds, 15.0)
                frame_path.write_bytes(b"frame")
                return str(frame_path)

            handler = GenerateCaptionHandler(
                repository,
                vlm_client=FakeVlmClient(),
                frame_extractor=frame_extractor,
            )

            handler.handle({
                "file_id": "file-1",
                "source_asset_ids": ["segment-1"],
                "prompt_version": "caption-v1",
                "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                "model_version": "qwen2.5-vl-7b-instruct",
            })

            self.assertFalse(frame_path.exists())

    def test_generate_caption_rejects_empty_vlm_caption(self):
        repository = FakeCaptionRepository()
        repository.add_source_asset({
            "id": "image-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "asset_type": "image",
            "path": "/media/cat.jpg",
            "content_hash": "image-hash",
            "metadata_json": {},
        })
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


if __name__ == "__main__":
    unittest.main()
