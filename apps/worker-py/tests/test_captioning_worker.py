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

    def list_scene_caption_frames(self, file_id, scene_id):
        return sorted(
            [
                asset
                for asset in self.source_assets.values()
                if asset["file_id"] == file_id
                and asset["asset_type"] == "video_frame"
                and asset.get("metadata_json", {}).get("scene_id") == scene_id
            ],
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
        self.assertEqual(vlm_client.calls[0]["image_paths"], ["/media/cat.jpg"])

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

    def test_generate_scene_caption_uses_all_ordered_frames_and_records_provenance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repository = FakeCaptionRepository()
            repository.add_source_asset({
                "id": "segment-1",
                "file_id": "file-1",
                "library_id": "library-1",
                "asset_type": "video_segment",
                "path": "/media/clip.mp4",
                "start_time_seconds": 0.0,
                "end_time_seconds": 30.0,
                "frame_time_seconds": None,
                "content_hash": "segment-hash",
                "metadata_json": {"scene_id": "scene-0001"},
            })
            for asset_id, frame_time in [("frame-3", 25.0), ("frame-1", 5.0), ("frame-2", 15.0)]:
                repository.add_source_asset({
                    "id": asset_id,
                    "file_id": "file-1",
                    "library_id": "library-1",
                    "asset_type": "video_frame",
                    "path": "/media/clip.mp4",
                    "frame_time_seconds": frame_time,
                    "content_hash": f"hash-{asset_id}",
                    "metadata_json": {"scene_id": "scene-0001"},
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

            handler.handle({
                "file_id": "file-1",
                "source_asset_ids": ["segment-1"],
                "prompt_version": "scene-caption-v2",
                "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                "model_version": "qwen2.5-vl-7b-instruct",
            })

            self.assertEqual(vlm_client.calls[0]["frame_times_seconds"], [5.0, 15.0, 25.0])
            self.assertEqual(vlm_client.calls[0]["image_paths"], extracted)
            self.assertTrue(all(not Path(path).exists() for path in extracted))
            metadata = repository.assets[0]["metadata_json"]
            self.assertEqual(metadata["source"], "vlm_scene_caption")
            self.assertEqual(metadata["scene_id"], "scene-0001")
            self.assertEqual(metadata["source_asset_ids"], ["frame-1", "frame-2", "frame-3"])
            self.assertEqual(metadata["frame_times_seconds"], [5.0, 15.0, 25.0])

    def test_generate_scene_caption_cleans_extracted_frames_when_vlm_fails(self):
        class FailingVlmClient(FakeVlmClient):
            def caption(self, **_kwargs):
                raise RuntimeError("VLM unavailable")

        with tempfile.TemporaryDirectory() as tmp_dir:
            repository = FakeCaptionRepository()
            repository.add_source_asset({
                "id": "segment-1",
                "file_id": "file-1",
                "library_id": "library-1",
                "asset_type": "video_segment",
                "path": "/media/clip.mp4",
                "start_time_seconds": 0.0,
                "end_time_seconds": 30.0,
                "content_hash": "segment-hash",
                "metadata_json": {"scene_id": "scene-0001"},
            })
            for index, frame_time in enumerate((5.0, 15.0), start=1):
                repository.add_source_asset({
                    "id": f"frame-{index}",
                    "file_id": "file-1",
                    "library_id": "library-1",
                    "asset_type": "video_frame",
                    "path": "/media/clip.mp4",
                    "frame_time_seconds": frame_time,
                    "content_hash": f"hash-{index}",
                    "metadata_json": {"scene_id": "scene-0001"},
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
                    "source_asset_ids": ["segment-1"],
                    "prompt_version": "scene-caption-v2",
                    "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
                    "model_version": "qwen2.5-vl-7b-instruct",
                })

            self.assertTrue(all(not Path(path).exists() for path in extracted))
            self.assertEqual(repository.assets, [])


if __name__ == "__main__":
    unittest.main()
