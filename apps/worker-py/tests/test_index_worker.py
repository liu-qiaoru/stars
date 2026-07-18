import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_agent_worker.errors import JobError
from media_agent_worker.indexing import (
    IndexMediaHandler,
    SCENE_COUNT_EXCEEDED,
    VIDEO_DECODE_FAILED,
    VIDEO_DURATION_MISSING,
    deterministic_point_id,
    sample_frame_times,
)
from media_agent_worker.probe import ProbeHandler, parse_image_dimensions
from media_agent_worker.worker import WorkerRunner


class FakeMediaRepository:
    """内存版 media repository，模拟阶段 2 后的 video_scenes/video_frame/scene_id 写入。"""

    def __init__(self):
        self.files = {}
        self.assets = {}
        self.vector_refs = {}
        self.scenes = {}  # (file_id, scene_key, index_generation) -> scene row
        self.probes = {}

    def get_media_file(self, file_id):
        return self.files[file_id]

    def update_probe_metadata(self, file_id, metadata):
        self.probes[file_id] = metadata

    def upsert_video_scene(self, *, file_id, scene_key, start_time_seconds, end_time_seconds,
                           detection_strategy, strategy_fingerprint, index_generation):
        key = (file_id, scene_key, index_generation)
        if key not in self.scenes:
            scene_id = f"scene-uuid-{len(self.scenes) + 1}"
            self.scenes[key] = {"id": scene_id, "file_id": file_id, "scene_key": scene_key}
        return self.scenes[key]

    def upsert_media_asset(self, **asset):
        # 身份键加入 scene_id，避免不同场景的同时间帧在内存里碰撞（真实仓库按 SQL 唯一约束保证）。
        key = (
            asset["file_id"],
            asset["asset_type"],
            asset.get("scene_id"),
            asset.get("start_time_seconds"),
            asset.get("end_time_seconds"),
            asset.get("frame_time_seconds"),
            asset.get("path"),
        )
        if key not in self.assets:
            self.assets[key] = {"id": f"asset-{len(self.assets) + 1}", "_created": True, **asset}
        else:
            self.assets[key].update(asset)
            self.assets[key]["_created"] = False
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
        self.failure = None
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

    def mark_failed(self, job_id, message, *, error_code=None, error_details=None):
        self.failure = {"job_id": job_id, "message": message, "error_code": error_code}


class StaticHandler:
    def __init__(self, result):
        self.result = result

    def handle(self, job_input):
        return self.result


class FailingDetector:
    """模拟视频解码失败：抛出普通异常，应由 IndexMediaHandler 转成 JobError。"""

    def __call__(self, _path):
        raise RuntimeError("video decode blew up")


class ProbeAndIndexTest(unittest.TestCase):
    def test_parse_png_dimensions_without_external_dependencies(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", 640, 480)
        self.assertEqual(parse_image_dimensions(png), {"width": 640, "height": 480})

    def test_sample_frame_times_uses_2_5s_intervals(self):
        # 30s 场景得到 12 帧；0.5s 场景至少一帧；所有帧严格位于边界内。
        self.assertEqual(len(sample_frame_times(0, 30, 2.5)), 12)
        self.assertEqual(sample_frame_times(0, 0.5, 2.5), [0.25])
        frames = sample_frame_times(0, 30, 2.5)
        self.assertTrue(all(0 <= frame < 30 for frame in frames))
        # 不足一个区间的尾段也取中点。
        self.assertEqual(sample_frame_times(0, 6, 2.5), [1.25, 3.75, 5.5])

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
        # segment_strategy 已删除：index_media 输入只含 file_id + index_profile。
        self.assertEqual(
            job_repository.created_jobs[0]["input_json"],
            {"file_id": "file-1", "index_profile": "balanced"},
        )
        self.assertEqual(job_repository.created_jobs[1]["job_type"], "transcribe_audio")

    def test_probe_handler_creates_only_transcribe_job_for_audio_after_probing(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {"id": "file-1", "path": "/tmp/audio.mp3", "media_type": "audio"}
        job_repository = InMemoryJobRepository()
        handler = ProbeHandler(
            repository,
            job_repository=job_repository,
            ffprobe_runner=lambda _path: {"duration_seconds": 31.5, "width": None, "height": None, "codec": "mp3", "streams": 1},
        )

        handler.handle({"file_id": "file-1", "path": "/tmp/audio.mp3", "media_type": "audio"})

        self.assertEqual(len(job_repository.created_jobs), 1)
        self.assertEqual(job_repository.created_jobs[0]["job_type"], "transcribe_audio")

    def test_index_media_creates_image_asset_and_image_vector_ref(self):
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
            handler = IndexMediaHandler(repository)

            result = handler.handle({"file_id": "file-1", "index_profile": "balanced"})

            self.assertEqual(result, {
                "assets_created": 1,
                "vector_refs_created": 1,
                "collections": ["image_vectors"],
            })
            self.assertEqual(len(repository.assets), 1)
            vector_ref = next(iter(repository.vector_refs.values()))
            self.assertEqual(vector_ref["collection_name"], "image_vectors")
            self.assertEqual(vector_ref["vector_dim"], 768)
            # 默认关闭 Caption 时不再创建任何子任务（OCR 已删除）。
            self.assertEqual(repository.created_jobs if hasattr(repository, "created_jobs") else [], [])

    def test_index_media_creates_video_scenes_and_2_5s_frames_referencing_scene_uuid(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            video_path = str(Path(tmp_dir) / "video.mp4")
            Path(video_path).write_bytes(b"video")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1",
                "library_id": "library-1",
                "path": video_path,
                "media_type": "video",
                "duration_seconds": 60.0,
                "index_generation": 0,
            }
            # 一个 60 秒场景：拆成两个 30 秒窗口，每窗口 12 帧 → 24 帧。
            handler = IndexMediaHandler(repository, scene_detector=lambda _path: [(0.0, 60.0)])

            result = handler.handle({"file_id": "file-1", "index_profile": "balanced"})

            self.assertEqual(result["collections"], ["video_frame_vectors"])
            self.assertEqual(result["scenes_detected"], 2)
            self.assertEqual(result["frames_created"], 24)
            self.assertEqual(len(repository.scenes), 2)
            frame_assets = [a for a in repository.assets.values() if a["asset_type"] == "video_frame"]
            self.assertEqual(len(frame_assets), 24)
            # 不再创建 video_segment 资产；场景身份在 video_scenes 表与 scene_id 外键。
            self.assertFalse(any(a["asset_type"] == "video_segment" for a in repository.assets.values()))
            scene_ids = {scene["id"] for scene in repository.scenes.values()}
            self.assertTrue(all(a["scene_id"] in scene_ids for a in frame_assets))
            self.assertEqual(len(repository.vector_refs), 24)
            self.assertTrue(all(
                ref["collection_name"] == "video_frame_vectors" for ref in repository.vector_refs.values()
            ))

    def test_index_media_single_scene_when_detector_finds_no_cuts(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 10.0, "index_generation": 0,
        }
        handler = IndexMediaHandler(repository, scene_detector=lambda _path: [])

        result = handler.handle({"file_id": "file-1", "index_profile": "balanced"})

        # 无切点 → 整个视频是一个原始场景；10s 场景按 2.5s 抽 4 帧。
        self.assertEqual(result["scenes_detected"], 1)
        self.assertEqual(result["frames_created"], 4)

    def test_index_media_merges_noise_scenes_shorter_than_min_seconds(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 12.0, "index_generation": 0,
        }
        # 第一个 0.3s 场景 < 0.5s，并入下一个 → (0,4) 与 (4,12) 两个场景。
        detector = lambda _path: [(0.0, 0.3), (0.3, 4.0), (4.0, 12.0)]
        handler = IndexMediaHandler(repository, scene_detector=detector)

        result = handler.handle({"file_id": "file-1", "index_profile": "balanced"})

        self.assertEqual(result["scenes_detected"], 2)

    def test_index_media_fails_when_scene_count_exceeds_max(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 30.0, "index_generation": 0,
        }
        handler = IndexMediaHandler(
            repository,
            scene_detector=lambda _path: [(float(i), float(i + 1)) for i in range(5)],
            scene_max_count=2,
        )

        with self.assertRaises(JobError) as caught:
            handler.handle({"file_id": "file-1", "index_profile": "balanced"})
        self.assertEqual(caught.exception.error_code, SCENE_COUNT_EXCEEDED)

    def test_index_media_fails_on_decoder_error_without_fallback(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 65.0, "index_generation": 0,
        }
        handler = IndexMediaHandler(repository, scene_detector=FailingDetector())

        with self.assertRaises(JobError) as caught:
            handler.handle({"file_id": "file-1", "index_profile": "balanced"})
        # 解码失败是确定性错误，必须结构化失败，不回退到固定窗口。
        self.assertEqual(caught.exception.error_code, VIDEO_DECODE_FAILED)
        self.assertEqual(len(repository.assets), 0)

    def test_index_media_fails_when_duration_is_missing(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": None, "index_generation": 0,
        }
        handler = IndexMediaHandler(repository, scene_detector=lambda _path: [(0.0, 10.0)])

        with self.assertRaises(JobError) as caught:
            handler.handle({"file_id": "file-1", "index_profile": "balanced"})
        self.assertEqual(caught.exception.error_code, VIDEO_DURATION_MISSING)

    def test_worker_runner_records_structured_error_code_on_job_failure(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 65.0, "index_generation": 0,
        }
        job_repository = InMemoryJobRepository({
            "id": "index-1",
            "job_type": "index_media",
            "input_json": {"file_id": "file-1", "index_profile": "balanced"},
        })
        runner = WorkerRunner(
            worker_id="worker-1",
            job_repository=job_repository,
            index_handler=IndexMediaHandler(repository, scene_detector=FailingDetector()),
        )

        runner.run_once()

        self.assertIsNotNone(job_repository.failure)
        self.assertEqual(job_repository.failure["error_code"], VIDEO_DECODE_FAILED)

    def test_index_media_creates_caption_v1_job_for_image_when_caption_enabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = str(Path(tmp_dir) / "poster.jpg")
            Path(image_path).write_bytes(b"image")
            repository = FakeMediaRepository()
            repository.files["file-1"] = {
                "id": "file-1", "library_id": "library-1", "path": image_path, "media_type": "image",
            }
            job_repository = InMemoryJobRepository()
            handler = IndexMediaHandler(repository, job_repository=job_repository)

            with patch.dict("os.environ", {"CAPTION_INDEXING_ENABLED": "true", "LOCAL_VLM_ENABLED": "true"}):
                handler.handle({"file_id": "file-1", "index_profile": "balanced"})

            self.assertEqual(len(job_repository.created_jobs), 1)
            job = job_repository.created_jobs[0]
            self.assertEqual(job["job_type"], "generate_caption")
            self.assertEqual(job["input_json"]["prompt_version"], "caption-v1")
            self.assertEqual(job["input_json"]["source_asset_ids"], ["asset-1"])

    def test_index_media_creates_scene_caption_v2_jobs_per_video_scene(self):
        repository = FakeMediaRepository()
        repository.files["file-1"] = {
            "id": "file-1", "library_id": "library-1", "path": "/tmp/video.mp4",
            "media_type": "video", "duration_seconds": 60.0, "index_generation": 0,
        }
        job_repository = InMemoryJobRepository()
        handler = IndexMediaHandler(
            repository,
            job_repository=job_repository,
            scene_detector=lambda _path: [(0.0, 60.0)],
        )

        with patch.dict("os.environ", {"CAPTION_INDEXING_ENABLED": "true", "LOCAL_VLM_ENABLED": "true"}):
            handler.handle({"file_id": "file-1", "index_profile": "balanced"})

        caption_jobs = [j for j in job_repository.created_jobs if j["job_type"] == "generate_caption"]
        # 60s 场景拆成 2 个 30s 窗口 → 2 个 scene-caption-v2 任务，各带正式 scene_id。
        self.assertEqual(len(caption_jobs), 2)
        scene_ids = {scene["id"] for scene in repository.scenes.values()}
        for job in caption_jobs:
            self.assertEqual(job["input_json"]["prompt_version"], "scene-caption-v2")
            self.assertIn(job["input_json"]["scene_id"], scene_ids)

    def test_deterministic_point_id_is_stable(self):
        kwargs = {
            "asset_id": "asset-1",
            "collection_name": "video_frame_vectors",
            "model_name": "google/siglip-base-patch16-224",
            "model_version": "siglip-base-patch16-224",
            "vector_kind": "frame_embedding",
            "content_hash": "asset-1:0:30",
        }
        self.assertEqual(deterministic_point_id(**kwargs), deterministic_point_id(**{**kwargs}))

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
