import tempfile
import unittest
from pathlib import Path

from media_agent_worker.exporting import ExportClipHandler
from media_agent_worker.worker import WorkerRunner


class FakeMediaRepository:
    def __init__(self):
        self.file = {
            "id": "file-1",
            "library_id": "library-1",
            "path": "/Volumes/Media/video.mp4",
            "media_type": "video",
            "duration_seconds": 180.0,
            "width": 1920,
            "height": 1080,
            "codec": "h264",
        }

    def get_media_file(self, file_id):
        self.requested_file_id = file_id
        return self.file


class FakeJobRepository:
    def __init__(self):
        self.jobs = [
            {
                "id": "job-1",
                "job_type": "export_clip",
                "input_json": {
                    "file_id": "file-1",
                    "start_time_seconds": 10,
                    "end_time_seconds": 25,
                    "output_format": "mp4",
                },
            }
        ]
        self.succeeded = []

    def claim_next_job(self, _worker_id):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, _job_id):
        pass

    def mark_succeeded(self, job_id, result):
        self.succeeded.append((job_id, result))

    def mark_failed(self, job_id, message):
        raise AssertionError(f"job {job_id} failed unexpectedly: {message}")


class ExportClipHandlerTest(unittest.TestCase):
    def test_exports_clip_with_ffmpeg_copy_command(self):
        calls = []

        def fake_runner(command):
            calls.append(command)

        with tempfile.TemporaryDirectory() as temp_dir:
            repository = FakeMediaRepository()
            handler = ExportClipHandler(
                repository,
                ffmpeg_runner=fake_runner,
                exports_root=Path(temp_dir) / ".media-agent" / "exports" / "clips",
            )

            result = handler.handle(
                {
                    "file_id": "file-1",
                    "start_time_seconds": 10,
                    "end_time_seconds": 25,
                    "output_format": "mp4",
                }
            )

        self.assertEqual(repository.requested_file_id, "file-1")
        self.assertEqual(result["duration_seconds"], 15)
        self.assertTrue(result["export_path"].endswith(".media-agent/exports/clips/file-1-10-25.mp4"))
        self.assertEqual(calls[0][0:2], ["ffmpeg", "-y"])
        self.assertIn("/Volumes/Media/video.mp4", calls[0])
        self.assertEqual(calls[0][-1], result["export_path"])

    def test_worker_dispatches_export_clip_job(self):
        calls = []
        job_repository = FakeJobRepository()
        handler = ExportClipHandler(FakeMediaRepository(), ffmpeg_runner=lambda command: calls.append(command))
        runner = WorkerRunner(
            worker_id="worker-1",
            job_repository=job_repository,
            export_handler=handler,
        )

        did_work = runner.run_once()

        self.assertTrue(did_work)
        self.assertEqual(job_repository.succeeded[0][0], "job-1")
        self.assertEqual(job_repository.succeeded[0][1]["duration_seconds"], 15)
        self.assertEqual(len(calls), 1)

    def test_ffmpeg_failure_includes_stderr_in_error_message(self):
        def failing_runner(_command):
            raise RuntimeError("FFmpeg exited 1: Invalid data found when processing input")

        with tempfile.TemporaryDirectory() as temp_dir:
            handler = ExportClipHandler(
                FakeMediaRepository(),
                ffmpeg_runner=failing_runner,
                exports_root=Path(temp_dir) / ".media-agent" / "exports" / "clips",
            )

            with self.assertRaises(RuntimeError) as ctx:
                handler.handle(
                    {
                        "file_id": "file-1",
                        "start_time_seconds": 10,
                        "end_time_seconds": 25,
                        "output_format": "mp4",
                    }
                )

            self.assertIn("FFmpeg exited 1", str(ctx.exception))
            self.assertIn("Invalid data", str(ctx.exception))
