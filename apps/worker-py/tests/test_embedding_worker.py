import tempfile
import unittest
from pathlib import Path

from media_agent_worker.__main__ import build_runner
from media_agent_worker.embedding_worker import EmbedImageHandler, EmbedTextAssetHandler, EmbedVideoFrameHandler
from media_agent_worker.embedding_worker import extract_video_frame
from media_agent_worker.embeddings import (
    SiglipEmbedder,
    mean_pool_hidden_state,
    normalize_vector,
    select_torch_device,
)
from media_agent_worker.errors import JobError
from media_agent_worker.model_service import EmbeddingModelRouter, handle_embed_text_request
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
    model_name = "google/siglip2-base-patch16-224"
    model_version = "siglip2-base-patch16-224"

    def __init__(self):
        self.image_paths = []
        self.texts = []

    def embed_image_path(self, path):
        self.image_paths.append(path)
        return [0.1, 0.2, 0.3, 0.4]

    def embed_text(self, text):
        self.texts.append(text)
        return [0.4, 0.3, 0.2, 0.1]


class FakeCaptionTextEmbedder(FakeEmbedder):
    model_name = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    model_version = "paraphrase-multilingual-MiniLM-L12-v2"


class FakeDeviceValue:
    def to(self, _device):
        return self


class FakeSiglipProcessor:
    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return {"input_ids": FakeDeviceValue()}


class FakeSiglipModel:
    def get_text_features(self, **_inputs):
        return [[3.0, 4.0]]


class FakeNoGrad:
    def __enter__(self):
        return None

    def __exit__(self, _error_type, _error, _traceback):
        return False


class FakeTorch:
    @staticmethod
    def no_grad():
        return FakeNoGrad()


class EmbeddingWorkerTest(unittest.TestCase):
    def test_normalize_vector_returns_unit_length(self):
        self.assertEqual(normalize_vector([3.0, 4.0]), [0.6, 0.8])

    def test_caption_mean_pooling_ignores_padding_tokens(self):
        """索引 Caption 与查询文本必须使用同一套只计算有效 token 的平均池化。"""
        import torch

        hidden = torch.tensor([[[1.0, 2.0], [3.0, 4.0], [100.0, 100.0]]])
        attention_mask = torch.tensor([[1, 1, 0]])

        pooled = mean_pool_hidden_state(hidden, attention_mask)

        self.assertEqual(pooled.tolist(), [[2.0, 3.0]])

    def test_select_torch_device_prefers_requested_cpu_without_importing_torch(self):
        self.assertEqual(select_torch_device("cpu", torch_module=None), "cpu")

    def test_siglip_text_embedding_uses_training_compatible_fixed_length_padding(self):
        # 绕过重量级模型初始化，只验证查询文本传给 Hugging Face Processor 的契约。
        # 图片向量已经离线写入 Qdrant；查询预处理变化必须由此测试防止以后意外回退。
        embedder = SiglipEmbedder.__new__(SiglipEmbedder)
        embedder.processor = FakeSiglipProcessor()
        embedder.model = FakeSiglipModel()
        embedder.torch = FakeTorch()
        embedder.device = "cpu"
        embedder._finalize = lambda vector: vector

        vector = embedder.embed_text("a person standing by the sea")

        self.assertEqual(vector, [3.0, 4.0])
        self.assertEqual(embedder.processor.calls, [{
            "text": ["a person standing by the sea"],
            "padding": "max_length",
            "return_tensors": "pt",
        }])

    def test_model_service_text_request_returns_vector_and_dimension(self):
        embedder = FakeEmbedder()

        response = handle_embed_text_request(embedder, {"text": "red car"})

        self.assertEqual(response, {
            "model_name": "google/siglip2-base-patch16-224",
            "model_version": "siglip2-base-patch16-224",
            "vector": [0.4, 0.3, 0.2, 0.1],
            "vector_dim": 4,
        })
        self.assertEqual(embedder.texts, ["red car"])

    def test_model_service_routes_caption_text_model_requests(self):
        siglip_embedder = FakeEmbedder()
        caption_embedder = FakeCaptionTextEmbedder()
        router = EmbeddingModelRouter(
            siglip_embedder=siglip_embedder,
            caption_text_embedder_factory=lambda: caption_embedder,
        )

        response = handle_embed_text_request(router, {
            "text": "一只猫坐在窗边",
            "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
        })

        self.assertEqual(response["model_name"], "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
        self.assertEqual(caption_embedder.texts, ["一只猫坐在窗边"])
        self.assertEqual(siglip_embedder.texts, [])

    def test_embed_image_job_writes_qdrant_point_and_marks_vector_ref_indexed(self):
        repository = FakeEmbeddingRepository()
        repository.add_vector_ref({
            "asset_id": "asset-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "collection_name": "image_vectors",
            "point_id": "11111111-1111-4111-8111-111111111111",
            "model_name": "google/siglip2-base-patch16-224",
            "model_version": "siglip2-base-patch16-224",
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
            "model_name": "google/siglip2-base-patch16-224",
            "model_version": "siglip2-base-patch16-224",
        })

        self.assertEqual(result["point_id"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(result["vector_dim"], 4)
        self.assertEqual(repository.indexed, ["11111111-1111-4111-8111-111111111111"])
        collection_name, point = qdrant.points[0]
        self.assertEqual(collection_name, "image_vectors")
        self.assertEqual(point["vector"], [0.1, 0.2, 0.3, 0.4])
        self.assertEqual(point["payload"]["model_name"], "google/siglip2-base-patch16-224")

    def test_embed_text_asset_job_writes_caption_vector_and_marks_ref_indexed(self):
        repository = FakeEmbeddingRepository()
        repository.add_vector_ref({
            "asset_id": "caption-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "collection_name": "caption_text_vectors",
            "point_id": "44444444-4444-4444-8444-444444444444",
            "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
            "vector_kind": "vlm_caption_text_embedding",
            "vector_dim": 4,
            "distance": "Cosine",
            "content_hash": "caption-hash",
            "index_profile": "balanced",
            "asset_type": "caption",
            "media_type": "video",
            "start_time_seconds": 10.0,
            "end_time_seconds": 20.0,
            "text_content": "一只猫坐在窗边",
            "metadata_json": {"source": "vlm_caption", "prompt_version": "caption-v1"},
        })
        qdrant = FakeQdrantClient()
        embedder = FakeCaptionTextEmbedder()
        handler = EmbedTextAssetHandler(repository, qdrant, embedder)

        result = handler.handle({
            "asset_id": "caption-1",
            "collection": "caption_text_vectors",
            "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
        })

        self.assertEqual(result["point_id"], "44444444-4444-4444-8444-444444444444")
        self.assertEqual(embedder.texts, ["一只猫坐在窗边"])
        self.assertEqual(repository.indexed, ["44444444-4444-4444-8444-444444444444"])
        collection_name, point = qdrant.points[0]
        self.assertEqual(collection_name, "caption_text_vectors")
        self.assertEqual(point["vector"], [0.4, 0.3, 0.2, 0.1])
        self.assertEqual(point["payload"]["asset_type"], "caption")
        self.assertEqual(point["payload"]["source"], "vlm_caption")

    def test_embed_text_asset_rejects_a_model_that_does_not_match_the_vector_ref(self):
        """错误文本模型不能把不可比较的向量写进 Caption Collection。"""
        repository = FakeEmbeddingRepository()
        repository.add_vector_ref({
            "asset_id": "caption-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "collection_name": "caption_text_vectors",
            "point_id": "44444444-4444-4444-8444-444444444444",
            "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
            "vector_kind": "vlm_caption_text_embedding",
            "vector_dim": 4,
            "distance": "Cosine",
            "content_hash": "caption-hash",
            "index_profile": "balanced",
            "asset_type": "caption",
            "media_type": "image",
            "text_content": "一只猫坐在窗边",
        })
        qdrant = FakeQdrantClient()
        wrong_embedder = FakeEmbedder()
        handler = EmbedTextAssetHandler(repository, qdrant, wrong_embedder)

        with self.assertRaisesRegex(ValueError, "Embedding model mismatch"):
            handler.handle({
                "asset_id": "caption-1",
                "collection": "caption_text_vectors",
                "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
            })

        self.assertEqual(qdrant.points, [])
        self.assertEqual(repository.indexed, [])
        self.assertEqual(wrong_embedder.texts, [])

    def test_caption_model_mismatch_is_visible_as_a_failed_job(self):
        """模型配置漂移必须落到 Job 错误，而不是生成部分向量或静默跳过。"""
        media_repository = FakeEmbeddingRepository()
        media_repository.add_vector_ref({
            "asset_id": "caption-1",
            "file_id": "file-1",
            "library_id": "library-1",
            "collection_name": "caption_text_vectors",
            "point_id": "44444444-4444-4444-8444-444444444444",
            "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
            "vector_kind": "vlm_caption_text_embedding",
            "vector_dim": 4,
            "distance": "Cosine",
            "content_hash": "caption-hash",
            "index_profile": "balanced",
            "asset_type": "caption",
            "media_type": "image",
            "text_content": "一只猫坐在窗边",
        })
        qdrant = FakeQdrantClient()
        handler = EmbedTextAssetHandler(media_repository, qdrant, FakeEmbedder())

        class SingleCaptionJobRepository:
            def __init__(self):
                self.job = {
                    "id": "embed-caption-1",
                    "job_type": "embed_text_asset",
                    "input_json": {
                        "asset_id": "caption-1",
                        "collection": "caption_text_vectors",
                        "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                        "model_version": "paraphrase-multilingual-MiniLM-L12-v2",
                    },
                }
                self.failure = None

            def claim_next_job(self, _worker_id):
                job = self.job
                self.job = None
                return job

            def heartbeat(self, _job_id):
                pass

            def mark_succeeded(self, _job_id, _result):
                raise AssertionError("mismatched model must not succeed")

            def mark_failed(self, job_id, message, *, error_code=None, error_details=None):
                self.failure = (job_id, message, error_code, error_details)

        job_repository = SingleCaptionJobRepository()
        runner = WorkerRunner(
            worker_id="worker-1",
            job_repository=job_repository,
            embed_text_asset_handler=handler,
        )

        self.assertFalse(runner.run_once())
        self.assertEqual(job_repository.failure[0], "embed-caption-1")
        self.assertEqual(job_repository.failure[1], "Caption 文本 Embedding 任务失败")
        self.assertEqual(job_repository.failure[2], "EMBEDDING_FAILED")
        self.assertEqual(job_repository.failure[3]["stage"], "caption_text_embedding")
        self.assertEqual(qdrant.points, [])
        self.assertEqual(media_repository.indexed, [])

    def test_embed_video_frame_job_extracts_frame_and_writes_scene_id_payload(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            extracted = str(Path(tmp_dir) / "frame.jpg")
            Path(extracted).write_bytes(b"frame")
            repository = FakeEmbeddingRepository()
            repository.add_vector_ref({
                "asset_id": "asset-2",
                "file_id": "file-2",
                "library_id": "library-1",
                "collection_name": "video_frame_vectors",
                "point_id": "22222222-2222-4222-8222-222222222222",
                "model_name": "google/siglip2-base-patch16-224",
                "model_version": "siglip2-base-patch16-224",
                "vector_kind": "frame_embedding",
                "vector_dim": 4,
                "distance": "Cosine",
                "content_hash": "frame-hash",
                "index_profile": "balanced",
                "asset_type": "video_frame",
                "media_type": "video",
                "start_time_seconds": 30.0,
                "end_time_seconds": 60.0,
                # scene_id 是 media_assets 正式列（引用 video_scenes 行），写入 Qdrant payload 供分组检索。
                "scene_id": "scene-uuid-2",
                "metadata_json": {"scene_key": "scene-0002"},
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
                "collection": "video_frame_vectors",
                "model_name": "google/siglip2-base-patch16-224",
                "model_version": "siglip2-base-patch16-224",
            })

            self.assertEqual(result["collection"], "video_frame_vectors")
            self.assertEqual(calls, [("/media/clip.mp4", 45)])
            self.assertEqual(embedder.image_paths, [extracted])
            self.assertEqual(qdrant.points[0][1]["payload"]["scene_id"], "scene-uuid-2")
            # segment_strategy 已删除，不再写入 Qdrant payload。
            self.assertNotIn("segment_strategy", qdrant.points[0][1]["payload"])

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

    def test_build_runner_shares_visual_embedder_but_keeps_caption_model_separate(self):
        embedder = FakeEmbedder()
        text_embedder = FakeCaptionTextEmbedder()
        runner = build_runner(
            worker_id="worker-1",
            job_repository=object(),
            media_repository=object(),
            qdrant_client=object(),
            embedder=embedder,
            text_embedder=text_embedder,
        )

        self.assertIs(runner.embed_image_handler.embedder, embedder)
        self.assertIs(runner.embed_video_frame_handler.embedder, embedder)
        self.assertIs(runner.embed_text_asset_handler.embedder, text_embedder)

    def test_extract_video_frame_removes_temp_file_when_ffmpeg_fails(self):
        outputs = []

        def failing_run(command, **_kwargs):
            outputs.append(command[-1])
            raise RuntimeError("ffmpeg failed")

        with self.assertRaises(JobError) as raised:
            extract_video_frame("/media/clip.mp4", 12.0, runner=failing_run)

        self.assertEqual(raised.exception.error_code, "FRAME_EXTRACTION_FAILED")
        self.assertEqual(raised.exception.details["stage"], "frame_extraction")
        self.assertEqual(len(outputs), 1)
        self.assertFalse(Path(outputs[0]).exists())


if __name__ == "__main__":
    unittest.main()
