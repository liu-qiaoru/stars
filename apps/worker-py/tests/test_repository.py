import json
import unittest

from media_agent_worker.repository import PostgresMediaRepository


class PurgeFakeConnection:
    """模拟 purge_file_index 的事务：返回锁定的 index_status/generation 与各删除的 rowcount。"""

    def __init__(self, *, index_status, index_generation, rowcounts):
        self.index_status = index_status
        self.index_generation = index_generation
        self.rowcounts = rowcounts
        self.executed = []
        self.rolled_back = False
        self.committed = False

    def cursor(self):
        return PurgeFakeCursor(self)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


class PurgeFakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.fetchone_result = None
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=None):
        self.connection.executed.append((query, params))
        # SELECT ... FOR UPDATE 返回锁定的状态与 generation。
        if "SELECT index_status" in query:
            self.fetchone_result = (self.connection.index_status, self.connection.index_generation)
            return
        # DELETE 按目标表返回模拟的删除行数。
        if "DELETE FROM vector_refs" in query:
            self.rowcount = self.connection.rowcounts.get("vector_refs", 0)
        elif "DELETE FROM media_assets" in query:
            self.rowcount = self.connection.rowcounts.get("assets", 0)
        elif "DELETE FROM video_scenes" in query:
            self.rowcount = self.connection.rowcounts.get("scenes", 0)
        else:
            self.rowcount = 0

    def fetchone(self):
        return self.fetchone_result



class FakeConnection:
    def __init__(self, row):
        self.row = row
        self.commits = 0
        self.executed = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.fetchone_result = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=None):
        self.connection.executed.append((query, params))
        if "UPDATE vector_refs" in query or "UPDATE media_files" in query:
            return
        if query.strip().startswith("SELECT id, file_id"):
            self.fetchone_result = tuple(self.connection.row)
            return
        if "UPDATE media_assets" in query:
            row = self.connection.row
            if "CASE WHEN %s THEN %s ELSE text_content END" in query:
                # 阶段 2 后 re-index UPDATE 多了 scene_id 参数：
                # (content_hash, has_text_content, text_content, metadata_json, scene_id, asset_id)
                content_hash, has_text_content, text_content, metadata_json, scene_id, _asset_id = params
                row[7] = content_hash
                if has_text_content:
                    row[8] = text_content
                row[9] = {**(row[9] or {}), **json.loads(metadata_json)}
                row[10] = scene_id
                return
            raise AssertionError(f"Unexpected media_assets update: {query}")
        raise AssertionError(f"Unexpected query: {query}")

    def fetchone(self):
        return self.fetchone_result


class PostgresMediaRepositoryTest(unittest.TestCase):
    def test_mark_vector_ref_indexed_also_marks_its_file_indexed_in_one_commit(self):
        connection = FakeConnection([])
        repository = PostgresMediaRepository(connection)

        repository.mark_vector_ref_indexed("point-1")

        self.assertEqual(connection.commits, 1)
        self.assertEqual(len(connection.executed), 2)
        self.assertIn("UPDATE vector_refs", connection.executed[0][0])
        self.assertIn("status = 'indexed'", connection.executed[0][0])
        self.assertIn("status IN ('pending', 'indexed')", connection.executed[0][0])
        self.assertEqual(connection.executed[0][1], ("point-1",))
        self.assertIn("UPDATE media_files", connection.executed[1][0])
        self.assertIn("index_status = 'indexed'", connection.executed[1][0])
        self.assertIn("FROM vector_refs", connection.executed[1][0])
        self.assertEqual(connection.executed[1][1], ("point-1",))

    def test_upsert_media_asset_preserves_existing_text_and_merges_metadata_and_scene(self):
        # 重索引时，未提供的 text_content 必须保留旧值（转录等后置任务可能已经写入文本），
        # metadata 以 patch 合并，scene_id 同步更新到新场景。
        row = [
            "asset-1",        # 0 id
            "file-1",         # 1 file_id
            "video_frame",    # 2 asset_type
            "/media/clip.mp4",  # 3 path
            None,             # 4 start_time_seconds
            None,             # 5 end_time_seconds
            12.5,             # 6 frame_time_seconds
            "old-hash",       # 7 content_hash
            "EXISTING TRANSCRIPT",  # 8 text_content
            {"transcript": True},   # 9 metadata_json
            None,             # 10 scene_id
        ]
        connection = FakeConnection(row)
        repository = PostgresMediaRepository(connection)

        repository.upsert_media_asset(
            file_id="file-1",
            asset_type="video_frame",
            scene_id="scene-uuid-2",
            path="/media/clip.mp4",
            frame_time_seconds=12.5,
            content_hash="new-hash",
            metadata_json={"frame_index": 1},
        )

        self.assertEqual(row[7], "new-hash")
        self.assertEqual(row[8], "EXISTING TRANSCRIPT")
        self.assertEqual(row[9], {"transcript": True, "frame_index": 1})
        self.assertEqual(row[10], "scene-uuid-2")
        self.assertEqual(connection.commits, 1)

    def test_purge_file_index_increments_generation_when_purge_queued(self):
        connection = PurgeFakeConnection(
            index_status="purge_queued",
            index_generation=1,
            rowcounts={"vector_refs": 3, "assets": 5, "scenes": 1},
        )
        repository = PostgresMediaRepository(connection)

        result = repository.purge_file_index("file-1")

        self.assertEqual(result, {
            "vector_refs_deleted": 3,
            "assets_deleted": 5,
            "scenes_deleted": 1,
            "index_generation": 2,
        })
        executed_sql = [query for query, _params in connection.executed]
        # 一个事务内删除 vector_refs / 视频帧与 Caption 资产 / video_scenes。
        self.assertTrue(any("DELETE FROM vector_refs" in q for q in executed_sql))
        self.assertTrue(any("DELETE FROM media_assets" in q and "video_frame" in q for q in executed_sql))
        self.assertTrue(any("DELETE FROM video_scenes" in q for q in executed_sql))
        # 仅在 purge_queued 时递增 generation 并翻回 pending。
        self.assertTrue(
            any("index_generation = index_generation + 1" in q and "index_status = 'pending'" in q for q in executed_sql)
        )

    def test_purge_file_index_does_not_increment_generation_on_retry_after_status_flip(self):
        # 重试路径：上一轮已把状态翻回 pending，generation 不应再次递增。
        connection = PurgeFakeConnection(
            index_status="pending",
            index_generation=2,
            rowcounts={"vector_refs": 0, "assets": 0, "scenes": 0},
        )
        repository = PostgresMediaRepository(connection)

        result = repository.purge_file_index("file-1")

        self.assertEqual(result["index_generation"], 2)
        executed_sql = [query for query, _params in connection.executed]
        self.assertFalse(any("index_generation = index_generation + 1" in q for q in executed_sql))


if __name__ == "__main__":
    unittest.main()
