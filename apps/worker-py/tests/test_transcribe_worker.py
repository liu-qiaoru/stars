import tempfile
import unittest
from pathlib import Path

from media_agent_worker.transcription import TranscribeHandler, chunk_transcript_segments
from media_agent_worker.worker import WorkerRunner


class FakeMediaRepository:
    def __init__(self):
        self.files = {}
        self.assets = {}

    def get_media_file(self, file_id):
        return self.files[file_id]

    def upsert_media_asset(self, **asset):
        key = (
            asset["file_id"],
            asset["asset_type"],
            asset.get("start_time_seconds"),
            asset.get("end_time_seconds"),
        )
        if key not in self.assets:
            self.assets[key] = {"id": f"asset-{len(self.assets) + 1}", **asset}
            return self.assets[key], True
        self.assets[key].update(asset)
        return self.assets[key], False


class FakeTranscriber:
    def __init__(self, segments, language="zh"):
        self.segments = segments
        self.language = language
        self.audio_paths = []

    def transcribe(self, audio_path, language="auto"):
        self.audio_paths.append((audio_path, language))
        return {"segments": self.segments, "language": self.language}


class SingleJobRepository:
    def __init__(self):
        self.job = {
            "id": "transcribe-1",
            "job_type": "transcribe_audio",
            "input_json": {"file_id": "file-1", "path": "/tmp/audio.mp3", "media_type": "audio"},
        }
        self.completed = None

    def claim_next_job(self, _worker_id):
        job = self.job
        self.job = None
        return job

    def heartbeat(self, _job_id):
        pass

    def mark_succeeded(self, job_id, result):
        self.completed = (job_id, result)

    def mark_failed(self, _job_id, message):
        raise AssertionError(message)


class TranscribeWorkerTest(unittest.TestCase):
    def test_chunk_transcript_segments_uses_15_to_30_second_windows(self):
        chunks = chunk_transcript_segments([
            {"start": 0.0, "end": 7.0, "text": "hello"},
            {"start": 7.0, "end": 16.0, "text": "world"},
            {"start": 16.0, "end": 31.0, "text": "next"},
            {"start": 31.0, "end": 42.0, "text": "tail"},
        ])

        self.assertEqual(chunks, [
            {"start_time_seconds": 0.0, "end_time_seconds": 16.0, "text_content": "hello world"},
            {"start_time_seconds": 16.0, "end_time_seconds": 42.0, "text_content": "next tail"},
        ])

    def test_transcribe_handler_extracts_audio_and_upserts_text_chunks_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            extracted_audio = str(Path(tmp_dir) / "audio.wav")
            Path(extracted_audio).write_bytes(b"audio")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1",
                "path": "/tmp/source.mp4",
                "media_type": "video",
                "duration_seconds": 31.5,
            }
            transcriber = FakeTranscriber([
                {"start": 0.0, "end": 15.5, "text": "第一段"},
                {"start": 15.5, "end": 31.5, "text": "second part"},
            ])
            extractor_calls = []
            handler = TranscribeHandler(
                repository,
                transcriber=transcriber,
                audio_extractor=lambda source_path: extractor_calls.append(source_path) or extracted_audio,
            )
            job_input = {
                "file_id": "file-1",
                "path": "/tmp/source.mp4",
                "media_type": "video",
                "model": "base",
                "language": "auto",
            }

            first = handler.handle(job_input)
            second = handler.handle(job_input)

            self.assertEqual(first, {"chunks_created": 2, "language": "zh", "duration_seconds": 31.5})
            self.assertEqual(second, {"chunks_created": 0, "language": "zh", "duration_seconds": 31.5})
            self.assertEqual(extractor_calls, ["/tmp/source.mp4", "/tmp/source.mp4"])
            self.assertEqual(len(repository.assets), 2)
            first_chunk = repository.assets[("file-1", "text_chunk", 0.0, 15.5)]
            self.assertEqual(first_chunk["text_content"], "第一段")

    def test_worker_runner_dispatches_transcribe_audio_job(self):
        repository = SingleJobRepository()

        WorkerRunner(
            worker_id="worker-1",
            job_repository=repository,
            transcribe_handler=type("StaticHandler", (), {
                "handle": lambda _self, job_input: {"file_id": job_input["file_id"]},
            })(),
        ).run_once()

        self.assertEqual(repository.completed, ("transcribe-1", {"file_id": "file-1"}))


if __name__ == "__main__":
    unittest.main()
