import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from media_agent_worker.ocr import OcrHandler, PaddleOcrReader
from media_agent_worker.worker import WorkerRunner


class FakeOcrRepository:
    def __init__(self):
        self.assets = {}
        self.updated_assets = []

    def add_asset(self, asset):
        self.assets[asset["id"]] = asset

    def get_media_asset_for_ocr(self, asset_id):
        return self.assets[asset_id]

    def update_asset_ocr_text(self, asset_id, *, text_content, ocr_metadata):
        asset = self.assets[asset_id]
        metadata = {**asset.get("metadata_json", {}), "ocr": ocr_metadata}
        asset.update({"text_content": text_content, "metadata_json": metadata})
        self.updated_assets.append((asset_id, text_content, ocr_metadata))


class FakeOcrer:
    def __init__(self, blocks):
        self.blocks = blocks
        self.image_paths = []

    def read_text(self, image_path):
        self.image_paths.append(image_path)
        return self.blocks


class FakePaddle3Ocr:
    def __init__(self):
        self.calls = []

    def predict(self, image_path, **kwargs):
        self.calls.append((image_path, kwargs))
        return [{
            "rec_texts": ["LOCAL", "MEDIA"],
            "rec_scores": [0.92, 0.88],
            "rec_polys": [[[0, 0], [10, 0], [10, 10], [0, 10]], [[10, 10], [20, 10], [20, 20], [10, 20]]],
        }]


class FakePaddleModuleOcr:
    def __init__(self, lang):
        self.lang = lang


class SingleJobRepository:
    def __init__(self):
        self.job = {
            "id": "ocr-1",
            "job_type": "run_ocr",
            "input_json": {
                "asset_ids": ["asset-1"],
                "engine": "paddleocr",
                "language": "ch",
            },
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


class OcrWorkerTest(unittest.TestCase):
    def test_paddle_reader_supports_paddleocr_3_predict_output(self):
        reader = PaddleOcrReader(language="ch")
        reader._ocr = FakePaddle3Ocr()

        blocks = reader.read_text("/media/poster.png")

        self.assertEqual(blocks, [
            {"text": "LOCAL", "confidence": 0.92, "bbox": [[0, 0], [10, 0], [10, 10], [0, 10]]},
            {"text": "MEDIA", "confidence": 0.88, "bbox": [[10, 10], [20, 10], [20, 20], [10, 20]]},
        ])
        self.assertEqual(reader._ocr.calls, [
            ("/media/poster.png", {"use_textline_orientation": False}),
        ])

    def test_paddle_reader_defaults_cache_under_system_temp_dir(self):
        previous_cache = os.environ.pop("PADDLE_PDX_CACHE_HOME", None)
        previous_module = sys.modules.get("paddleocr")
        sys.modules["paddleocr"] = types.SimpleNamespace(PaddleOCR=FakePaddleModuleOcr)
        try:
            PaddleOcrReader(language="ch")._load()

            self.assertEqual(
                os.environ["PADDLE_PDX_CACHE_HOME"],
                str(Path(tempfile.gettempdir()) / "media-agent-paddlex-cache"),
            )
        finally:
            if previous_cache is None:
                os.environ.pop("PADDLE_PDX_CACHE_HOME", None)
            else:
                os.environ["PADDLE_PDX_CACHE_HOME"] = previous_cache
            if previous_module is None:
                sys.modules.pop("paddleocr", None)
            else:
                sys.modules["paddleocr"] = previous_module

    def test_ocr_handler_consumes_normalized_reader_blocks_without_renormalizing(self):
        repository = FakeOcrRepository()
        repository.add_asset({
            "id": "asset-1",
            "file_id": "file-1",
            "asset_type": "image",
            "path": "/media/poster.png",
            "metadata_json": {},
        })
        handler = OcrHandler(
            repository,
            ocrer=FakeOcrer([{"text": "TITLE", "confidence": 0.8, "bbox": None}]),
        )

        with patch("media_agent_worker.ocr._normalize_block", side_effect=AssertionError("unexpected normalize")):
            result = handler.handle({"asset_ids": ["asset-1"], "engine": "paddleocr", "language": "ch"})

        self.assertEqual(result["text_written"], 1)
        self.assertEqual(repository.assets["asset-1"]["text_content"], "TITLE")

    def test_image_asset_ocr_writes_text_content_and_metadata(self):
        repository = FakeOcrRepository()
        repository.add_asset({
            "id": "asset-1",
            "file_id": "file-1",
            "asset_type": "image",
            "path": "/media/poster.png",
            "frame_time_seconds": None,
            "metadata_json": {},
        })
        handler = OcrHandler(
            repository,
            ocrer=FakeOcrer([
                {"text": "LOCAL", "confidence": 0.92, "bbox": [0, 0, 10, 10]},
                {"text": "low", "confidence": 0.2, "bbox": [1, 1, 2, 2]},
                {"text": "MEDIA", "confidence": 0.88, "bbox": [10, 10, 20, 20]},
            ]),
            min_confidence=0.5,
        )

        result = handler.handle({
            "asset_ids": ["asset-1"],
            "engine": "paddleocr",
            "language": "ch",
        })

        self.assertEqual(result, {"assets_processed": 1, "text_written": 1, "skipped_no_text": 0})
        self.assertEqual(repository.assets["asset-1"]["text_content"], "LOCAL MEDIA")
        self.assertEqual(repository.assets["asset-1"]["metadata_json"]["ocr"], {
            "engine": "paddleocr",
            "language": "ch",
            "confidence": 0.9,
            "block_count": 2,
        })

    def test_video_frame_ocr_extracts_frame_before_reading_text(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            frame_path = str(Path(tmp_dir) / "frame.jpg")
            Path(frame_path).write_bytes(b"frame")
            repository = FakeOcrRepository()
            repository.add_asset({
                "id": "asset-1",
                "file_id": "file-1",
                "asset_type": "video_frame",
                "path": "/media/clip.mp4",
                "frame_time_seconds": 12.5,
                "metadata_json": {},
            })
            ocrer = FakeOcrer([{"text": "TITLE", "confidence": 0.75}])
            calls = []
            handler = OcrHandler(
                repository,
                ocrer=ocrer,
                frame_extractor=lambda source_path, frame_time_seconds: calls.append((source_path, frame_time_seconds)) or frame_path,
            )

            result = handler.handle({"asset_ids": ["asset-1"], "engine": "paddleocr", "language": "ch"})

            self.assertEqual(result["text_written"], 1)
            self.assertEqual(calls, [("/media/clip.mp4", 12.5)])
            self.assertEqual(ocrer.image_paths, [frame_path])

    def test_ocr_rerun_overwrites_same_asset_text_without_new_rows(self):
        repository = FakeOcrRepository()
        repository.add_asset({
            "id": "asset-1",
            "file_id": "file-1",
            "asset_type": "image",
            "path": "/media/poster.png",
            "metadata_json": {"scene_id": "scene-0001"},
        })
        handler = OcrHandler(repository, ocrer=FakeOcrer([{"text": "FIRST", "confidence": 0.8}]))
        second_handler = OcrHandler(repository, ocrer=FakeOcrer([{"text": "SECOND", "confidence": 0.9}]))

        handler.handle({"asset_ids": ["asset-1"], "engine": "paddleocr", "language": "ch"})
        second_handler.handle({"asset_ids": ["asset-1"], "engine": "paddleocr", "language": "ch"})

        self.assertEqual(repository.assets["asset-1"]["text_content"], "SECOND")
        self.assertEqual(repository.assets["asset-1"]["metadata_json"]["scene_id"], "scene-0001")
        self.assertEqual(len(repository.updated_assets), 2)

    def test_worker_runner_dispatches_run_ocr_job(self):
        repository = SingleJobRepository()

        WorkerRunner(
            worker_id="worker-1",
            job_repository=repository,
            ocr_handler=type("StaticHandler", (), {
                "handle": lambda _self, job_input: {"assets_processed": len(job_input["asset_ids"])},
            })(),
        ).run_once()

        self.assertEqual(repository.completed, ("ocr-1", {"assets_processed": 1}))


if __name__ == "__main__":
    unittest.main()
