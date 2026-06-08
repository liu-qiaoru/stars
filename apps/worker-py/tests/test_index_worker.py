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
        return self.assets[key]

    def upsert_vector_ref(self, **vector_ref):
        key = (vector_ref["collection_name"], vector_ref["point_id"])
        created = key not in self.vector_refs
        self.vector_refs[key] = vector_ref
        return "created" if created else "skipped"


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

    def create_job(self, job_type, input_json):
        self.created_jobs.append({"job_type": job_type, "input_json": input_json})

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

    def test_probe_handler_creates_index_job_after_probing(self):
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

        self.assertEqual(len(job_repository.created_jobs), 1)
        self.assertEqual(job_repository.created_jobs[0]["job_type"], "index_media")
        self.assertEqual(job_repository.created_jobs[0]["input_json"]["file_id"], "file-1")
        self.assertEqual(job_repository.created_jobs[0]["input_json"]["segment_strategy"], "fixed_30s")

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
            })
            self.assertEqual(second, {
                "assets_created": 0,
                "vector_refs_created": 0,
                "collections": ["video_segment_vectors"],
            })
            self.assertEqual(len(repository.assets), 3)
            self.assertEqual(len(repository.vector_refs), 3)
            vector_ref = next(iter(repository.vector_refs.values()))
            self.assertEqual(vector_ref["model_name"], "google/siglip-base-patch16-224")
            self.assertEqual(vector_ref["model_version"], "siglip-base-patch16-224")
            self.assertEqual(vector_ref["vector_dim"], 768)

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
