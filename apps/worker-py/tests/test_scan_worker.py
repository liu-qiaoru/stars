import tempfile
import unittest
from pathlib import Path

from media_agent_worker.scan import ScanHandler, detect_media_type
from media_agent_worker.worker import WorkerRunner


class InMemoryMediaRepository:
    def __init__(self):
        self.rows = {}

    def upsert_media_file(self, *, library_id, root_path, path, media_type, size_bytes, mtime_ms):
        relative_path = str(Path(path).relative_to(root_path))
        previous = self.rows.get((library_id, path))
        file_id = previous["id"] if previous else f"file-{len(self.rows) + 1}"
        current = {
            "id": file_id,
            "library_id": library_id,
            "path": path,
            "relative_path": relative_path,
            "media_type": media_type,
            "size_bytes": size_bytes,
            "mtime_ms": mtime_ms,
        }
        self.rows[(library_id, path)] = current
        if previous is None:
            return "created", file_id
        if previous["size_bytes"] == size_bytes and previous["mtime_ms"] == mtime_ms:
            return "skipped", file_id
        return "updated", file_id


class InMemoryJobRepository:
    def __init__(self, job=None):
        self.job = job
        self.heartbeats = 0
        self.completed = None
        self.created_jobs = []

    def claim_next_job(self, worker_id):
        if self.job is None:
            return None
        job = {**self.job, "locked_by": worker_id, "status": "running"}
        self.job = None
        return job

    def create_job(self, job_type, input_json):
        self.created_jobs.append({"job_type": job_type, "input_json": input_json})

    def heartbeat(self, job_id):
        self.heartbeats += 1

    def mark_succeeded(self, job_id, result):
        self.completed = (job_id, result)

    def mark_failed(self, job_id, message):
        raise AssertionError(message)


class ScanWorkerTest(unittest.TestCase):
    def test_detect_media_type_by_extension(self):
        self.assertEqual(detect_media_type("clip.MP4"), "video")
        self.assertEqual(detect_media_type("photo.jpeg"), "image")
        self.assertEqual(detect_media_type("voice.wav"), "audio")
        self.assertEqual(detect_media_type("notes.txt"), "document")
        self.assertIsNone(detect_media_type("archive.zip"))

    def test_scan_handler_is_idempotent_for_unchanged_files(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "video.mp4").write_bytes(b"video")
            (root / "photo.jpg").write_bytes(b"photo")
            (root / "archive.zip").write_bytes(b"ignored")

            repository = InMemoryMediaRepository()
            handler = ScanHandler(repository)
            job_input = {
                "library_id": "11111111-1111-4111-8111-111111111111",
                "root_path": str(root),
                "scan_mode": "mtime_size",
            }

            first = handler.handle(job_input)
            second = handler.handle(job_input)

            self.assertEqual(first, {"discovered": 2, "created": 2, "updated": 0, "skipped": 0, "failed": 0})
            self.assertEqual(second, {"discovered": 2, "created": 0, "updated": 0, "skipped": 2, "failed": 0})

    def test_worker_runner_claims_scan_job_and_writes_result(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "clip.mp4").write_bytes(b"video")
            media_repository = InMemoryMediaRepository()
            job_repository = InMemoryJobRepository(
                {
                    "id": "job-1",
                    "job_type": "scan_library",
                    "input_json": {
                        "library_id": "22222222-2222-4222-8222-222222222222",
                        "root_path": str(root),
                        "scan_mode": "mtime_size",
                    },
                }
            )
            runner = WorkerRunner(
                worker_id="worker-1",
                job_repository=job_repository,
                scan_handler=ScanHandler(media_repository, job_repository=job_repository),
            )

            runner.run_once()

            self.assertEqual(job_repository.heartbeats, 1)
            self.assertEqual(
                job_repository.completed,
                ("job-1", {"discovered": 1, "created": 1, "updated": 0, "skipped": 0, "failed": 0}),
            )

    def test_scan_handler_creates_probe_jobs_for_new_files(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "video.mp4").write_bytes(b"video")
            (root / "photo.jpg").write_bytes(b"photo")

            media_repository = InMemoryMediaRepository()
            job_repository = InMemoryJobRepository()
            handler = ScanHandler(media_repository, job_repository=job_repository)
            handler.handle({
                "library_id": "11111111-1111-4111-8111-111111111111",
                "root_path": str(root),
                "scan_mode": "mtime_size",
            })

            self.assertEqual(len(job_repository.created_jobs), 2)
            probe_types = {j["job_type"] for j in job_repository.created_jobs}
            self.assertEqual(probe_types, {"probe_media"})
            probe_paths = {j["input_json"]["path"] for j in job_repository.created_jobs}
            self.assertEqual(probe_paths, {str(root / "video.mp4"), str(root / "photo.jpg")})

    def test_scan_handler_does_not_create_probe_jobs_for_skipped_files(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "video.mp4").write_bytes(b"video")

            media_repository = InMemoryMediaRepository()
            job_repository = InMemoryJobRepository()
            handler = ScanHandler(media_repository, job_repository=job_repository)
            handler.handle({
                "library_id": "11111111-1111-4111-8111-111111111111",
                "root_path": str(root),
                "scan_mode": "mtime_size",
            })
            self.assertEqual(len(job_repository.created_jobs), 1)

            handler.handle({
                "library_id": "11111111-1111-4111-8111-111111111111",
                "root_path": str(root),
                "scan_mode": "mtime_size",
            })
            self.assertEqual(len(job_repository.created_jobs), 1)


if __name__ == "__main__":
    unittest.main()
