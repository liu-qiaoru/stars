import json
import unittest

from media_agent_worker.repository import PostgresMediaRepository


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


if __name__ == "__main__":
    unittest.main()
