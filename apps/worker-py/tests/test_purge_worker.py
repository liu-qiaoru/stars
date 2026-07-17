import unittest

from media_agent_worker.purging import PurgeVideoIndexHandler


class FakeQdrantClient:
    """记录按集合删除的 point 列表，模拟 Qdrant 删除（删除不存在的点是 no-op）。"""

    def __init__(self):
        self.deleted = []

    def delete_points(self, collection_name, point_ids):
        self.deleted.append((collection_name, list(point_ids)))
        return len(point_ids)


class FakePurgeRepository:
    """模拟 list_vector_refs_for_file + purge_file_index；可让 purge 抛错以测试重试。"""

    def __init__(self, refs, purge_result, purge_raises=False):
        self.refs = refs
        self.purge_result = purge_result
        self.purge_raises = purge_raises
        self.purge_calls = 0

    def list_vector_refs_for_file(self, _file_id):
        return self.refs

    def purge_file_index(self, _file_id):
        self.purge_calls += 1
        if self.purge_raises:
            raise RuntimeError("PostgreSQL cleanup failed")
        return self.purge_result


class InMemoryJobRepository:
    def __init__(self):
        self.created_jobs = []
        self.succeeded = None
        self.failure = None

    def claim_next_job(self, _worker_id):
        return None

    def create_job(self, job_type, input_json, timeout_seconds=None):
        self.created_jobs.append({"job_type": job_type, "input_json": input_json})

    def heartbeat(self, _job_id):
        pass

    def mark_succeeded(self, job_id, result):
        self.succeeded = (job_id, result)

    def mark_failed(self, job_id, message, *, error_code=None, error_details=None):
        self.failure = {"job_id": job_id, "message": message}


class PurgeWorkerTest(unittest.TestCase):
    def test_purge_deletes_qdrant_by_collection_then_pg_then_creates_reindex(self):
        refs = [
            {"collection_name": "video_frame_vectors", "point_id": "p1"},
            {"collection_name": "video_frame_vectors", "point_id": "p2"},
            {"collection_name": "caption_text_vectors", "point_id": "p3"},
        ]
        repo = FakePurgeRepository(
            refs,
            purge_result={
                "vector_refs_deleted": 3,
                "assets_deleted": 5,
                "scenes_deleted": 1,
                "index_generation": 2,
            },
        )
        qdrant = FakeQdrantClient()
        jobs = InMemoryJobRepository()
        handler = PurgeVideoIndexHandler(repo, qdrant, job_repository=jobs)

        result = handler.handle({"file_id": "file-1"})

        # Qdrant 按集合分组删除。
        self.assertEqual(sorted(qdrant.deleted), [
            ("caption_text_vectors", ["p3"]),
            ("video_frame_vectors", ["p1", "p2"]),
        ])
        self.assertEqual(result["points_deleted"], 3)
        self.assertEqual(result["index_generation"], 2)
        # purge 成功后创建 index_media 重建索引。
        self.assertEqual(
            jobs.created_jobs,
            [
                {
                    "job_type": "index_media",
                    "input_json": {"file_id": "file-1", "index_profile": "balanced"},
                }
            ],
        )

    def test_purge_without_job_repository_skips_reindex_creation(self):
        repo = FakePurgeRepository(
            [],
            purge_result={"vector_refs_deleted": 0, "assets_deleted": 0, "scenes_deleted": 0, "index_generation": 1},
        )
        handler = PurgeVideoIndexHandler(repo, FakeQdrantClient(), job_repository=None)

        result = handler.handle({"file_id": "file-1"})

        self.assertFalse(result["reindex_job_created"])

    def test_purge_propagates_postgres_failure_after_qdrant_delete(self):
        # Qdrant 已删但 PostgreSQL 清理失败：异常必须向上传播，让任务失败并可安全重试。
        refs = [{"collection_name": "video_frame_vectors", "point_id": "p1"}]
        repo = FakePurgeRepository(refs, purge_result={}, purge_raises=True)
        qdrant = FakeQdrantClient()
        handler = PurgeVideoIndexHandler(repo, qdrant, job_repository=InMemoryJobRepository())

        with self.assertRaises(RuntimeError):
            handler.handle({"file_id": "file-1"})

        # Qdrant 已被删除（事务回滚不会撤销 Qdrant，重试时由仓库侧幂等保证安全）。
        self.assertEqual(repo.purge_calls, 1)
        self.assertEqual(qdrant.deleted, [("video_frame_vectors", ["p1"])])

    def test_purge_retry_succeeds_after_prior_postgres_failure(self):
        # 第一次：Qdrant 删除成功，PG 清理失败；第二次：重试整体成功。
        refs = [{"collection_name": "video_frame_vectors", "point_id": "p1"}]
        repo = FakePurgeRepository(refs, purge_result={}, purge_raises=True)
        qdrant = FakeQdrantClient()
        handler = PurgeVideoIndexHandler(repo, qdrant, job_repository=InMemoryJobRepository())

        with self.assertRaises(RuntimeError):
            handler.handle({"file_id": "file-1"})

        # 重试：PG 清理这次成功（generation 由仓库的条件逻辑保证只递增一次，这里用 fake 固定返回值）。
        repo.purge_raises = False
        repo.purge_result = {
            "vector_refs_deleted": 1,
            "assets_deleted": 2,
            "scenes_deleted": 1,
            "index_generation": 2,
        }
        result = handler.handle({"file_id": "file-1"})

        self.assertEqual(repo.purge_calls, 2)
        self.assertTrue(result["reindex_job_created"])
        self.assertEqual(result["index_generation"], 2)


if __name__ == "__main__":
    unittest.main()
