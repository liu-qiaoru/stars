import tempfile
import unittest
from pathlib import Path

from media_agent_worker.__main__ import build_runner
from media_agent_worker.embedding_worker import EmbedImageHandler, EmbedVideoFrameHandler
from media_agent_worker.embedding_worker import extract_video_frame
from media_agent_worker.embeddings import normalize_vector, select_torch_device
from media_agent_worker.model_service import handle_embed_text_request
from media_agent_worker.worker import WorkerRunner


class FakeEmbeddingRepository:
    def __init__(self):
        self.vector_refs = {}
        self.indexed = []

    def add_vector_ref(self, vector_ref):
        key = (
            vector_ref["asset_id"],
            vector_ref["collection_name"],
            vector_ref["model_name"],
            vector_ref["model_version"],
        )
        self.vector_refs[key] = vector_ref

    def get_vector_ref_for_embedding(self, *, asset_id, collection_name, model_name, model_version):
        return self.vector_refs[(asset_id, collection_name, model_name, model_version)]

    def mark_vector_ref_indexed(self, point_id):
        self.indexed.append(point_id)


class FakeQdrantClient:
    def __init__(self):
        self.points = []

    def upsert_point(self, collection_name, point):
        self.points.append((collection_name, point))


class FakeEmbedder:
    vector_dim = 4
    model_name = "google/siglip-base-patch16-224"
    model_version = "siglip-base-patch16-224"

    def __init__(self):
        self.image_paths = []
        self.texts = []

    def embed_image_path(self, path):
        self.image_paths.append(path)
        return [0.1, 0.2, 0.3, 0.4]

    def embed_text(self, text):
        self.texts.append(text)
        return [0.4, 0.3, 0.2, 0.1]


class EmbeddingWorkerTest(unittest.TestCase):
    def test_normalize_vector_returns_unit_length(self):
        self.assertEqual(normalize_vector([3.0, 4.0]), [0.6, 0.8])

    def test_select_torch_device_prefers_requested_cpu_without_importing_torch(self):
        self.assertEqual(select_torch_device("cpu", torch_module=None), "cpu")

    def test_model_service_text_request_returns_vector_and_dimension(self):
        embedder = FakeEmbedder()

        response = handle_embed_text_request(embedder, {"text": "red car"})

        self.assertEqual(response, {
            "model_name": "google/siglip-base-patch16-224",
            "model_version": "siglip-base-patch16-224",
            "vector": [0.4, 0.3, 0.2, 0.1],
            "vector_dim": 4,
        })
        self.assertEqual(embedder.texts, ["red car"])

    def test_embed_image_job_writes_qdrant_point_and_marks_vector_ref_indexed(self):
        repository = FakeEmbeddingRepository()
        repository.add_vector_ref({
            "asset_id": "asset-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "collection_name": "image_vectors",
            "point_id": "11111111-1111-4111-8111-111111111111",
            "model_name": "google/siglip-base-patch16-224",
            "model_version": "siglip-base-patch16-224",
            "vector_kind": "image_embedding",
            "vector_dim": 4,
            "distance": "Cosine",
            "content_hash": "image-hash",
            "index_profile": "balanced",
            "asset_type": "image",
            "media_type": "image",
            "start_time_seconds": None,
            "end_time_seconds": None,
        })
        qdrant = FakeQdrantClient()
        handler = EmbedImageHandler(repository, qdrant, FakeEmbedder())

        result = handler.handle({
            "asset_id": "asset-1",
            "path": "/media/cat.jpg",
            "collection": "image_vectors",
            "model_name": "google/siglip-base-patch16-224",
            "model_version": "siglip-base-patch16-224",
        })

        self.assertEqual(result["point_id"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(result["vector_dim"], 4)
        self.assertEqual(repository.indexed, ["11111111-1111-4111-8111-111111111111"])
        collection_name, point = qdrant.points[0]
        self.assertEqual(collection_name, "image_vectors")
        self.assertEqual(point["vector"], [0.1, 0.2, 0.3, 0.4])
        self.assertEqual(point["payload"]["model_name"], "google/siglip-base-patch16-224")

    def test_embed_video_segment_job_extracts_representative_frame_before_embedding(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            extracted = str(Path(tmp_dir) / "frame.jpg")
            Path(extracted).write_bytes(b"frame")
            repository = FakeEmbeddingRepository()
            repository.add_vector_ref({
                "asset_id": "asset-2",
                "file_id": "file-2",
                "library_id": "library-1",
                "collection_name": "video_segment_vectors",
                "point_id": "22222222-2222-4222-8222-222222222222",
                "model_name": "google/siglip-base-patch16-224",
                "model_version": "siglip-base-patch16-224",
                "vector_kind": "representative_frame_embedding",
                "vector_dim": 4,
                "distance": "Cosine",
                "content_hash": "segment-hash",
                "index_profile": "balanced",
                "asset_type": "video_segment",
                "media_type": "video",
                "start_time_seconds": 30.0,
                "end_time_seconds": 60.0,
            })
            qdrant = FakeQdrantClient()
            embedder = FakeEmbedder()
            calls = []
            handler = EmbedVideoFrameHandler(
                repository,
                qdrant,
                embedder,
                frame_extractor=lambda source_path, frame_time_seconds: calls.append((source_path, frame_time_seconds)) or extracted,
            )

            result = handler.handle({
                "asset_id": "asset-2",
                "frame_path": "/media/clip.mp4",
                "frame_time_seconds": 45,
                "collection": "video_segment_vectors",
                "model_name": "google/siglip-base-patch16-224",
                "model_version": "siglip-base-patch16-224",
            })

            self.assertEqual(result["collection"], "video_segment_vectors")
            self.assertEqual(calls, [("/media/clip.mp4", 45)])
            self.assertEqual(embedder.image_paths, [extracted])

    def test_worker_runner_dispatches_embedding_jobs(self):
        class StaticHandler:
            def handle(self, job_input):
                return {"asset_id": job_input["asset_id"]}

        class SingleJobRepository:
            def __init__(self):
                self.job = {"id": "embed-1", "job_type": "embed_image", "input_json": {"asset_id": "asset-1"}}
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

        repository = SingleJobRepository()
        WorkerRunner(
            worker_id="worker-1",
            job_repository=repository,
            embed_image_handler=StaticHandler(),
        ).run_once()

        self.assertEqual(repository.completed, ("embed-1", {"asset_id": "asset-1"}))

    def test_build_runner_shares_one_embedder_between_embedding_handlers(self):
        embedder = FakeEmbedder()
        runner = build_runner(
            worker_id="worker-1",
            job_repository=object(),
            media_repository=object(),
            qdrant_client=object(),
            embedder=embedder,
        )

        self.assertIs(runner.embed_image_handler.embedder, embedder)
        self.assertIs(runner.embed_video_frame_handler.embedder, embedder)

    def test_extract_video_frame_removes_temp_file_when_ffmpeg_fails(self):
        outputs = []

        def failing_run(command, **_kwargs):
            outputs.append(command[-1])
            raise RuntimeError("ffmpeg failed")

        with self.assertRaises(RuntimeError):
            extract_video_frame("/media/clip.mp4", 12.0, runner=failing_run)

        self.assertEqual(len(outputs), 1)
        self.assertFalse(Path(outputs[0]).exists())


if __name__ == "__main__":
    unittest.main()
