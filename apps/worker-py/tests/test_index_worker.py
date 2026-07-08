import struct
import tempfile
import unittest
from pathlib import Path

from media_agent_worker.indexing import IndexMediaHandler, deterministic_point_id
from media_agent_worker.probe import ProbeHandler, parse_image_dimensions
from media_agent_worker.worker import WorkerRunner


class FakeMediaRepository:
    def __init__(self):
        self.files = {}
        self.assets = {}
        self.vector_refs = {}
        self.probes = {}
        self.invalidations = []

    def get_media_file(self, file_id):
        return self.files[file_id]

    def update_probe_metadata(self, file_id, metadata):
        self.probes[file_id] = metadata

    def upsert_media_asset(self, **asset):
        key = (
            asset["file_id"],
            asset["asset_type"],
            asset.get("start_time_seconds"),
            asset.get("end_time_seconds"),
            asset.get("frame_time_seconds"),
            asset.get("path"),
        )
        if key not in self.assets:
            self.assets[key] = {"id": f"asset-{len(self.assets) + 1}", **asset}
        else:
            self.assets[key].update(asset)
        return self.assets[key]

    def upsert_vector_ref(self, **vector_ref):
        key = (vector_ref["collection_name"], vector_ref["point_id"])
        created = key not in self.vector_refs
        self.vector_refs[key] = vector_ref
        return "created" if created else "skipped"

    def invalidate_video_index_assets(self, file_id, segment_strategy, keyframe_density=None):
        stale_asset_ids = {
            asset["id"]
            for asset in self.assets.values()
            if asset["file_id"] == file_id
            and asset["asset_type"] in ("video_segment", "video_frame")
            and (
                asset.get("metadata_json", {}).get("segment_strategy") != segment_strategy
                or asset.get("metadata_json", {}).get("keyframe_density") != keyframe_density
            )
        }
        if stale_asset_ids:
            self.invalidations.append(file_id)
        self.assets = {
            key: asset
            for key, asset in self.assets.items()
            if asset["id"] not in stale_asset_ids
        }
        self.vector_refs = {
            key: vector_ref
            for key, vector_ref in self.vector_refs.items()
            if vector_ref["asset_id"] not in stale_asset_ids
        }
        return {"assets_invalidated": len(stale_asset_ids), "vector_refs_invalidated": len(stale_asset_ids)}


class InMemoryJobRepository:
    def __init__(self, job=None):
        self.job = job
        self.completed = None
        self.created_jobs = []

    def claim_next_job(self, worker_id):
        if self.job is None:
            return None
        job = self.job
        self.job = None
        return job

    def create_job(self, job_type, input_json, timeout_seconds=None):
        self.created_jobs.append({
            "job_type": job_type,
            "input_json": input_json,
            "timeout_seconds": timeout_seconds,
        })

    def heartbeat(self, job_id):
        pass

    def mark_succeeded(self, job_id, result):
        self.completed = (job_id, result)

    def mark_failed(self, job_id, message):
        raise AssertionError(message)


class StaticHandler:
    def __init__(self, result):
        self.result = result

    def handle(self, job_input):
        return self.result


class ProbeAndIndexTest(unittest.TestCase):
    def test_parse_png_dimensions_without_external_dependencies(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", 640, 480)
        self.assertEqual(parse_image_dimensions(png), {"width": 640, "height": 480})

    def test_probe_handler_updates_video_metadata_from_ffprobe(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {"id": "file-1", "path": "/tmp/video.mp4", "media_type": "video"}
        handler = ProbeHandler(repository, ffprobe_runner=lambda _path: {
            "duration_seconds": 65.5,
            "width": 1920,
            "height": 1080,
            "codec": "h264",
            "streams": 2,
        })

        result = handler.handle({"file_id": "file-1", "path": "/tmp/video.mp4", "media_type": "video"})

        self.assertEqual(result["duration_seconds"], 65.5)
        self.assertEqual(repository.probes["file-1"]["codec"], "h264")

    def test_probe_handler_creates_index_and_transcribe_jobs_for_video_after_probing(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {"id": "file-1", "path": "/tmp/video.mp4", "media_type": "video"}
        job_repository = InMemoryJobRepository()
        handler = ProbeHandler(
            repository,
            job_repository=job_repository,
            ffprobe_runner=lambda _path: {
                "duration_seconds": 65.5,
                "width": 1920,
                "height": 1080,
                "codec": "h264",
                "streams": 2,
            },
        )

        handler.handle({"file_id": "file-1", "path": "/tmp/video.mp4", "media_type": "video"})

        self.assertEqual(len(job_repository.created_jobs), 2)
        self.assertEqual(job_repository.created_jobs[0]["job_type"], "index_media")
        self.assertEqual(job_repository.created_jobs[0]["input_json"]["file_id"], "file-1")
        self.assertEqual(job_repository.created_jobs[0]["input_json"]["segment_strategy"], "scene_detection")
        self.assertEqual(job_repository.created_jobs[1]["job_type"], "transcribe_audio")
        self.assertEqual(job_repository.created_jobs[1]["input_json"], {
            "file_id": "file-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "model": "base",
            "language": "auto",
        })
        self.assertEqual(job_repository.created_jobs[1]["timeout_seconds"], 14400)

    def test_probe_handler_creates_only_transcribe_job_for_audio_after_probing(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {"id": "file-1", "path": "/tmp/audio.mp3", "media_type": "audio"}
        job_repository = InMemoryJobRepository()
        handler = ProbeHandler(
            repository,
            job_repository=job_repository,
            ffprobe_runner=lambda _path: {
                "duration_seconds": 31.5,
                "width": None,
                "height": None,
                "codec": "mp3",
                "streams": 1,
            },
        )

        handler.handle({"file_id": "file-1", "path": "/tmp/audio.mp3", "media_type": "audio"})

        self.assertEqual(len(job_repository.created_jobs), 1)
        self.assertEqual(job_repository.created_jobs[0]["job_type"], "transcribe_audio")
        self.assertEqual(job_repository.created_jobs[0]["input_json"]["media_type"], "audio")
        self.assertEqual(job_repository.created_jobs[0]["timeout_seconds"], 14400)

    def test_index_media_creates_30s_video_segments_and_pending_vector_refs_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            video_path = str(Path(tmp_dir) / "video.mp4")
            Path(video_path).write_bytes(b"video")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1",
                "library_id": "library-1",
                "path": video_path,
                "media_type": "video",
                "duration_seconds": 65.0,
            }
            handler = IndexMediaHandler(repository)
            job_input = {
                "file_id": "file-1",
                "index_profile": "balanced",
                "segment_strategy": "fixed_30s",
            }

            first = handler.handle(job_input)
            second = handler.handle(job_input)

            self.assertEqual(first, {
                "assets_created": 3,
                "vector_refs_created": 3,
                "collections": ["video_segment_vectors"],
                "segment_strategy": "fixed_30s",
                "fallback": False,
                "scenes_detected": 0,
                "keyframes_selected": 0,
                "keyframe_density": "dense",
            })
            self.assertEqual(second, {
                "assets_created": 0,
                "vector_refs_created": 0,
                "collections": ["video_segment_vectors"],
                "segment_strategy": "fixed_30s",
                "fallback": False,
                "scenes_detected": 0,
                "keyframes_selected": 0,
                "keyframe_density": "dense",
            })
            self.assertEqual(len(repository.assets), 3)
            self.assertEqual(len(repository.vector_refs), 3)
            vector_ref = next(iter(repository.vector_refs.values()))
            self.assertEqual(vector_ref["model_name"], "google/siglip-base-patch16-224")
            self.assertEqual(vector_ref["model_version"], "siglip-base-patch16-224")
            self.assertEqual(vector_ref["vector_dim"], 768)

    def test_index_media_creates_run_ocr_job_for_image_asset(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = str(Path(tmp_dir) / "poster.jpg")
            Path(image_path).write_bytes(b"image")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1",
                "library_id": "library-1",
                "path": image_path,
                "media_type": "image",
            }
            job_repository = InMemoryJobRepository()
            handler = IndexMediaHandler(repository, job_repository=job_repository)

            handler.handle({
                "file_id": "file-1",
                "index_profile": "balanced",
                "segment_strategy": "fixed_30s",
            })

            self.assertEqual(len(job_repository.created_jobs), 1)
            self.assertEqual(job_repository.created_jobs[0]["job_type"], "run_ocr")
            self.assertEqual(job_repository.created_jobs[0]["input_json"], {
                "asset_ids": ["asset-1"],
                "engine": "paddleocr",
                "language": "ch",
            })
            self.assertEqual(job_repository.created_jobs[0]["timeout_seconds"], 7200)

    def test_index_media_scene_detection_creates_scene_segments_keyframes_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            video_path = str(Path(tmp_dir) / "video.mp4")
            Path(video_path).write_bytes(b"video")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1",
                "library_id": "library-1",
                "path": video_path,
                "media_type": "video",
                "duration_seconds": 80.0,
            }
            detector = lambda _path: [(0.0, 20.0), (20.0, 70.0), (70.0, 80.0)]
            handler = IndexMediaHandler(repository, scene_detector=detector)

            result = handler.handle({
                "file_id": "file-1",
                "index_profile": "balanced",
                "segment_strategy": "scene_detection",
            })

            self.assertEqual(result["segment_strategy"], "scene_detection")
            self.assertFalse(result["fallback"])
            self.assertEqual(result["scenes_detected"], 3)
            self.assertEqual(result["keyframes_selected"], 9)
            self.assertEqual(result["keyframe_density"], "dense")
            self.assertEqual(result["collections"], ["video_segment_vectors", "video_frame_vectors"])
            segment_assets = [asset for asset in repository.assets.values() if asset["asset_type"] == "video_segment"]
            frame_assets = [asset for asset in repository.assets.values() if asset["asset_type"] == "video_frame"]
            self.assertEqual(len(segment_assets), 3)
            self.assertEqual(len(frame_assets), 9)
            self.assertEqual(segment_assets[0]["metadata_json"]["scene_id"], "scene-0001")
            self.assertEqual(segment_assets[0]["metadata_json"]["segment_strategy"], "scene_detection")
            self.assertEqual(segment_assets[0]["metadata_json"]["keyframe_density"], "dense")
            self.assertEqual(frame_assets[0]["metadata_json"]["scene_id"], "scene-0001")
            self.assertEqual(frame_assets[0]["metadata_json"]["keyframe_index"], 1)
            self.assertEqual(frame_assets[0]["metadata_json"]["keyframe_density"], "dense")
            self.assertEqual(len(repository.vector_refs), 12)

    def test_index_media_uses_dense_keyframe_density_by_default(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "duration_seconds": 6.0,
        }
        handler = IndexMediaHandler(
            repository,
            scene_detector=lambda _path: [(0.0, 6.0)],
        )

        result = handler.handle({
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "scene_detection",
        })

        frame_assets = [asset for asset in repository.assets.values() if asset["asset_type"] == "video_frame"]
        self.assertEqual(result["keyframe_density"], "dense")
        self.assertEqual(result["keyframes_selected"], 1)
        self.assertEqual(len(frame_assets), 1)
        self.assertNotEqual(frame_assets[0]["frame_time_seconds"], 3.0)

    def test_index_media_creates_run_ocr_job_for_scene_video_frame_assets(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "duration_seconds": 80.0,
        }
        job_repository = InMemoryJobRepository()
        handler = IndexMediaHandler(
            repository,
            job_repository=job_repository,
            scene_detector=lambda _path: [(0.0, 80.0)],
        )

        handler.handle({
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "scene_detection",
        })

        frame_assets = [asset for asset in repository.assets.values() if asset["asset_type"] == "video_frame"]
        self.assertEqual(len(frame_assets), 6)
        self.assertEqual(job_repository.created_jobs, [
            {
                "job_type": "run_ocr",
                "input_json": {
                    "asset_ids": [asset["id"] for asset in frame_assets],
                    "engine": "paddleocr",
                    "language": "ch",
                },
                "timeout_seconds": 7200,
            },
        ])

    def test_index_media_merges_short_scenes_before_creating_assets(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "duration_seconds": 12.0,
        }
        detector = lambda _path: [(0.0, 1.0), (1.0, 4.0), (4.0, 12.0)]
        handler = IndexMediaHandler(repository, scene_detector=detector, scene_min_seconds=3.0)

        result = handler.handle({
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "scene_detection",
        })

        segment_assets = [asset for asset in repository.assets.values() if asset["asset_type"] == "video_segment"]
        self.assertEqual(result["scenes_detected"], 2)
        self.assertEqual([(asset["start_time_seconds"], asset["end_time_seconds"]) for asset in segment_assets], [(0.0, 4.0), (4.0, 12.0)])

    def test_index_media_scene_detection_falls_back_to_fixed_segments_when_detector_fails(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "duration_seconds": 65.0,
        }

        def failing_detector(_path):
            raise RuntimeError("PySceneDetect failed")

        handler = IndexMediaHandler(repository, scene_detector=failing_detector)

        result = handler.handle({
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "scene_detection",
        })

        self.assertEqual(result["segment_strategy"], "fixed_30s")
        self.assertTrue(result["fallback"])
        self.assertIn("PySceneDetect failed", result["fallback_reason"])
        self.assertEqual(len(repository.assets), 3)
        asset = next(iter(repository.assets.values()))
        self.assertIsNone(asset["metadata_json"]["scene_id"])
        self.assertEqual(asset["metadata_json"]["segment_strategy"], "fixed_30s_fallback")

    def test_index_media_invalidates_old_video_segments_when_strategy_changes(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/tmp/video.mp4",
            "media_type": "video",
            "duration_seconds": 35.0,
        }
        handler = IndexMediaHandler(repository)
        fixed_input = {
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "fixed_30s",
        }

        first = handler.handle(fixed_input)
        scene_handler = IndexMediaHandler(repository, scene_detector=lambda _path: [(0.0, 35.0)])
        second = scene_handler.handle({
            "file_id": "file-1",
            "index_profile": "balanced",
            "segment_strategy": "scene_detection",
        })

        self.assertEqual(first["assets_created"], 2)
        self.assertEqual(second["assets_created"], 4)
        self.assertEqual(repository.invalidations, ["file-1"])

    def test_deterministic_mock_vector_and_point_id_are_stable(self):
        point_id = deterministic_point_id(
            asset_id="asset-1",
            collection_name="video_segment_vectors",
            model_name="google/siglip-base-patch16-224",
            model_version="siglip-base-patch16-224",
            vector_kind="representative_frame_embedding",
            content_hash="asset-1:0:30",
        )

        self.assertEqual(
            point_id,
            deterministic_point_id(
                asset_id="asset-1",
                collection_name="video_segment_vectors",
                model_name="google/siglip-base-patch16-224",
                model_version="siglip-base-patch16-224",
                vector_kind="representative_frame_embedding",
                content_hash="asset-1:0:30",
            ),
        )

    def test_worker_runner_dispatches_probe_and_index_jobs(self):
        probe_repo = InMemoryJobRepository({"id": "probe-1", "job_type": "probe_media", "input_json": {"file_id": "file-1"}})
        WorkerRunner(
            worker_id="worker-1",
            job_repository=probe_repo,
            probe_handler=StaticHandler({"streams": 1}),
        ).run_once()
        self.assertEqual(probe_repo.completed, ("probe-1", {"streams": 1}))

        index_repo = InMemoryJobRepository({"id": "index-1", "job_type": "index_media", "input_json": {"file_id": "file-1"}})
        WorkerRunner(
            worker_id="worker-1",
            job_repository=index_repo,
            index_handler=StaticHandler({"assets_created": 1}),
        ).run_once()
        self.assertEqual(index_repo.completed, ("index-1", {"assets_created": 1}))


if __name__ == "__main__":
    unittest.main()
