import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

from media_agent_worker.candidate_evidence import CandidateEvidenceHandler, _draw_timestamp, _timestamp
from media_agent_worker.errors import JobCancelled, JobError
from media_agent_worker.worker import WorkerRunner


class FakeEvidenceRepository:
    def __init__(self, frame_count, strategies):
        self.completed = None
        self.context = {
            "file": {
                "id": "11111111-1111-4111-8111-111111111111",
                "path": "/media/video.mp4",
                "media_type": "video",
                "index_generation": 3,
                "deleted": False,
            },
            "scene": {
                "id": "33333333-3333-4333-8333-333333333333",
                "file_id": "11111111-1111-4111-8111-111111111111",
                "index_generation": 3,
                "start_time_seconds": 10.0,
                "end_time_seconds": 40.0,
            },
            "candidate_asset": {
                "id": "22222222-2222-4222-8222-222222222222",
                "file_id": "11111111-1111-4111-8111-111111111111",
                "scene_id": "33333333-3333-4333-8333-333333333333",
                "asset_type": "video_frame",
                "stale": False,
            },
            "frames": [
                {
                    "asset_id": (
                        "22222222-2222-4222-8222-222222222222"
                        if index == 0
                        else f"{index + 10:08d}-1111-4111-8111-111111111111"
                    ),
                    "file_id": "11111111-1111-4111-8111-111111111111",
                    "scene_id": "33333333-3333-4333-8333-333333333333",
                    "asset_type": "video_frame",
                    "frame_time_seconds": 10.5 + index,
                    "stale": False,
                    "indexed": True,
                }
                for index in range(frame_count)
            ],
        }
        ids = {
            "contact_sheet_v1": "44444444-4444-4444-8444-444444444444",
            "all_indexed_frames_v1": "55555555-5555-4555-8555-555555555555",
        }
        self.evidence = [
            {"id": ids[strategy], "strategy": strategy, "protocol_version": "candidate-evidence-v1"}
            for strategy in strategies
        ]

    def load_candidate_evidence_context(self, _job_input):
        return self.context

    def get_candidate_evidence_for_job(self, _job_id):
        return self.evidence

    def complete_candidate_evidence_job(self, job_id, outputs, result):
        self.completed = {"job_id": job_id, "outputs": outputs, "result": result}


class FakeJobRepository:
    def __init__(self, job_input):
        self.jobs = [{"id": "job-1", "job_type": "build_candidate_evidence", "input_json": job_input}]
        self.succeeded = []

    def claim_next_job(self, _worker_id):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, _job_id):
        pass

    def is_cancel_requested(self, _job_id):
        return False

    def mark_succeeded(self, job_id, result):
        self.succeeded.append((job_id, result))

    def mark_failed(self, job_id, message, **_kwargs):
        raise AssertionError(f"job {job_id} failed unexpectedly: {message}")

    def mark_cancelled(self, _job_id, _message):
        pass


def job_input(strategies):
    return {
        "candidate_key": "video:scene-1",
        "file_id": "11111111-1111-4111-8111-111111111111",
        "file_generation": 3,
        "asset_id": "22222222-2222-4222-8222-222222222222",
        "scene_id": "33333333-3333-4333-8333-333333333333",
        "strategies": strategies,
    }


class CandidateEvidenceHandlerTest(unittest.TestCase):
    def test_builds_fixed_contact_sheet_layouts_for_1_2_6_and_12_indexed_frames(self):
        for frame_count, expected_grid in [(1, (1, 1)), (2, (1, 2)), (6, (2, 3)), (12, (3, 4))]:
            with self.subTest(frame_count=frame_count), tempfile.TemporaryDirectory() as temp_dir:
                repository = FakeEvidenceRepository(frame_count, ["contact_sheet_v1"])

                def frame_loader(_path, frame_time):
                    # 宽图强制覆盖 contain + 留白规则；颜色随时间变化，避免各格内容偶然相同。
                    return Image.new("RGB", (640, 240), (int(frame_time * 3) % 255, 80, 120))

                handler = CandidateEvidenceHandler(
                    repository,
                    artifacts_root=Path(temp_dir),
                    frame_loader=frame_loader,
                    cancellation_checker=lambda _job_id: False,
                    source_exists=lambda _path: True,
                )
                result = handler.handle(job_input(["contact_sheet_v1"]), job_id="job-1")
                manifest = result["manifests"][0]
                artifact_path = Path(repository.completed["outputs"][0]["artifact_path"])

                self.assertEqual(manifest["frame_count"], frame_count)
                self.assertEqual(
                    (manifest["protocol_parameters"]["rows"], manifest["protocol_parameters"]["columns"]),
                    expected_grid,
                )
                with Image.open(artifact_path) as image:
                    self.assertEqual(image.size, (1600, 900))
                    # 640:240 的宽图保持原比例后，格子顶部必须保留协议背景色；
                    # 若实现错误地拉伸填满，这个像素会变成帧颜色。
                    self.assertEqual(image.getpixel((800, 10)), (17, 24, 39))
                self.assertEqual(list(Path(temp_dir).glob("*.partial")), [])

        self.assertEqual(_timestamp(3661.234), "T+01:01:01.234")
        glyph_canvas = Image.new("RGB", (500, 40), "black")
        width, height = _draw_timestamp(
            ImageDraw.Draw(glyph_canvas),
            (0, 0),
            "T+00:00:00.000",
        )
        self.assertEqual((width, height), (332, 28))
        self.assertEqual(glyph_canvas.getpixel((0, 0)), (255, 255, 255))

    def test_all_indexed_frames_manifest_is_stably_sorted_and_reproducible(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = FakeEvidenceRepository(2, ["all_indexed_frames_v1"])
            repository.context["frames"].reverse()
            handler = CandidateEvidenceHandler(
                repository,
                artifacts_root=Path(temp_dir),
                frame_loader=lambda _path, _time: Image.new("RGB", (120, 240), "red"),
                cancellation_checker=lambda _job_id: False,
                source_exists=lambda _path: True,
            )

            first = handler.handle(job_input(["all_indexed_frames_v1"]), job_id="job-1")
            first_manifest = first["manifests"][0]
            artifact = json.loads(Path(repository.completed["outputs"][0]["artifact_path"]).read_text())
            repeated = handler.handle(job_input(["all_indexed_frames_v1"]), job_id="job-1")

            self.assertEqual(first_manifest["frame_time_seconds"], [10.5, 11.5])
            self.assertEqual([frame["frame_time_seconds"] for frame in artifact["frames"]], [10.5, 11.5])
            self.assertEqual(first_manifest["input_sha256"], repeated["manifests"][0]["input_sha256"])
            self.assertEqual(first_manifest["artifact_sha256"], repeated["manifests"][0]["artifact_sha256"])
            self.assertEqual(len(list((Path(temp_dir) / "55555555-5555-4555-8555-555555555555.bundle" / "frames").glob("*.png"))), 2)

            changed_repository = FakeEvidenceRepository(2, ["all_indexed_frames_v1"])
            changed_repository.context["frames"][1]["frame_time_seconds"] = 11.5000000001
            changed = CandidateEvidenceHandler(
                changed_repository,
                artifacts_root=Path(temp_dir) / "changed-time",
                frame_loader=lambda _path, _time: Image.new("RGB", (120, 240), "red"),
                source_exists=lambda _path: True,
            ).handle(job_input(["all_indexed_frames_v1"]), job_id="job-1")
            self.assertNotEqual(
                first_manifest["input_sha256"], changed["manifests"][0]["input_sha256"]
            )

    def test_worker_dispatches_candidate_evidence_without_any_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = FakeEvidenceRepository(1, ["contact_sheet_v1"])
            jobs = FakeJobRepository(job_input(["contact_sheet_v1"]))
            handler = CandidateEvidenceHandler(
                repository,
                artifacts_root=Path(temp_dir),
                frame_loader=lambda _path, _time: Image.new("RGB", (100, 100), "blue"),
                cancellation_checker=jobs.is_cancel_requested,
                source_exists=lambda _path: True,
            )
            runner = WorkerRunner(
                worker_id="worker-1",
                job_repository=jobs,
                candidate_evidence_handler=handler,
            )

            self.assertTrue(runner.run_once())
            # evidence 事实与 Job succeeded 已由 handler 的 repository 事务一起提交，
            # WorkerRunner 不应再做第二次、非原子的 mark_succeeded。
            self.assertEqual(len(jobs.succeeded), 0)
            self.assertEqual(repository.completed["job_id"], "job-1")

    def test_revalidates_generation_scene_asset_frames_and_source_file(self):
        mutations = [
            (lambda context: context["file"].update(index_generation=4), "STALE_FILE_GENERATION"),
            (lambda context: context["scene"].update(file_id="99999999-9999-4999-8999-999999999999"), "SCENE_IDENTITY_MISMATCH"),
            (lambda context: context["candidate_asset"].update(scene_id=None), "CANDIDATE_ASSET_MISMATCH"),
            (lambda context: context["frames"].append(dict(context["frames"][0])), "DUPLICATE_EVIDENCE_FRAME"),
            (lambda context: context["frames"][0].update(frame_time_seconds=float("nan")), "INVALID_FRAME_TIME"),
            (lambda context: context["frames"][0].update(frame_time_seconds=50.0), "FRAME_OUTSIDE_SCENE"),
            (lambda context: context["frames"][0].update(indexed=False), "INVALID_EVIDENCE_FRAME"),
            (
                lambda context: context["frames"][0].update(
                    asset_id="88888888-8888-4888-8888-888888888888"
                ),
                "CANDIDATE_ASSET_NOT_INDEXED",
            ),
        ]
        for mutate, expected_code in mutations:
            with self.subTest(error_code=expected_code), tempfile.TemporaryDirectory() as temp_dir:
                repository = FakeEvidenceRepository(1, ["contact_sheet_v1"])
                mutate(repository.context)
                handler = CandidateEvidenceHandler(
                    repository,
                    artifacts_root=Path(temp_dir),
                    frame_loader=lambda _path, _time: Image.new("RGB", (50, 50), "black"),
                    source_exists=lambda _path: True,
                )
                with self.assertRaises(JobError) as raised:
                    handler.handle(job_input(["contact_sheet_v1"]), job_id="job-1")
                self.assertEqual(raised.exception.error_code, expected_code)

        repository = FakeEvidenceRepository(1, ["contact_sheet_v1"])
        handler = CandidateEvidenceHandler(repository, source_exists=lambda _path: False)
        with self.assertRaises(JobError) as raised:
            handler.handle(job_input(["contact_sheet_v1"]), job_id="job-1")
        self.assertEqual(raised.exception.error_code, "SOURCE_FILE_MISSING")

    def test_failure_and_cancellation_remove_new_artifacts_and_partial_files(self):
        for mode in ["database_failure", "cancel_after_publish"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                repository = FakeEvidenceRepository(1, ["contact_sheet_v1"])
                checks = {"count": 0}

                if mode == "database_failure":
                    repository.complete_candidate_evidence_job = lambda *_args: (_ for _ in ()).throw(
                        RuntimeError("database commit failed")
                    )
                    cancellation_checker = lambda _job_id: False
                    expected_error = RuntimeError
                else:
                    def cancellation_checker(_job_id):
                        checks["count"] += 1
                        return checks["count"] >= 3
                    expected_error = JobCancelled

                handler = CandidateEvidenceHandler(
                    repository,
                    artifacts_root=Path(temp_dir),
                    frame_loader=lambda _path, _time: Image.new("RGB", (50, 50), "green"),
                    cancellation_checker=cancellation_checker,
                    source_exists=lambda _path: True,
                )
                with self.assertRaises(expected_error):
                    handler.handle(job_input(["contact_sheet_v1"]), job_id="job-1")
                self.assertEqual(list(Path(temp_dir).iterdir()), [])

    def test_rejects_missing_or_tampered_frames_when_reusing_an_existing_bundle(self):
        for mode in ["missing", "tampered", "extra"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                repository = FakeEvidenceRepository(2, ["all_indexed_frames_v1"])
                handler = CandidateEvidenceHandler(
                    repository,
                    artifacts_root=Path(temp_dir),
                    frame_loader=lambda _path, _time: Image.new("RGB", (50, 50), "purple"),
                    source_exists=lambda _path: True,
                )
                handler.handle(job_input(["all_indexed_frames_v1"]), job_id="job-1")
                frame_path = next(
                    (Path(temp_dir) / "55555555-5555-4555-8555-555555555555.bundle" / "frames").glob("*.png")
                )
                if mode == "missing":
                    frame_path.unlink()
                elif mode == "tampered":
                    frame_path.write_bytes(b"tampered")
                else:
                    frame_path.with_name("extra.png").write_bytes(frame_path.read_bytes())

                with self.assertRaises(JobError) as raised:
                    handler.handle(job_input(["all_indexed_frames_v1"]), job_id="job-1")
                self.assertEqual(raised.exception.error_code, "EVIDENCE_ARTIFACT_CONFLICT")

    def test_partial_cleanup_error_after_atomic_publication_does_not_flip_job_to_failed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = FakeEvidenceRepository(1, ["contact_sheet_v1"])
            handler = CandidateEvidenceHandler(
                repository,
                artifacts_root=Path(temp_dir),
                frame_loader=lambda _path, _time: Image.new("RGB", (50, 50), "orange"),
                source_exists=lambda _path: True,
            )
            original_unlink = Path.unlink

            def fail_only_for_partial(path, *args, **kwargs):
                if path.name.endswith(".partial"):
                    raise PermissionError("fixture cleanup denied")
                return original_unlink(path, *args, **kwargs)

            with mock.patch("pathlib.Path.unlink", autospec=True, side_effect=fail_only_for_partial):
                result = handler.handle(job_input(["contact_sheet_v1"]), job_id="job-1")

            self.assertEqual(result["manifests"][0]["strategy"], "contact_sheet_v1")
            self.assertTrue(Path(repository.completed["outputs"][0]["artifact_path"]).is_file())


if __name__ == "__main__":
    unittest.main()
