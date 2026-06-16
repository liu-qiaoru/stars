import json
import unittest

from media_agent_worker.repository import PostgresMediaRepository


class FakeConnection:
    def __init__(self, row):
        self.row = row
        self.commits = 0

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
        if query.strip().startswith("SELECT id, file_id"):
            self.fetchone_result = tuple(self.connection.row)
            return
        if "UPDATE media_assets" in query:
            row = self.connection.row
            if "CASE WHEN %s THEN %s ELSE text_content END" in query:
                content_hash, has_text_content, text_content, metadata_json, _asset_id = params
                row[7] = content_hash
                if has_text_content:
                    row[8] = text_content
                row[9] = {**(row[9] or {}), **json.loads(metadata_json)}
                return
            content_hash, text_content, metadata_json, _asset_id = params
            row[7] = content_hash
            row[8] = text_content
            row[9] = json.loads(metadata_json)
            return
        raise AssertionError(f"Unexpected query: {query}")

    def fetchone(self):
        return self.fetchone_result


class PostgresMediaRepositoryTest(unittest.TestCase):
    def test_upsert_media_asset_preserves_ocr_text_and_merges_metadata_when_reindexing(self):
        row = [
            "asset-1",
            "file-1",
            "video_frame",
            "/media/clip.mp4",
            None,
            None,
            12.5,
            "old-hash",
            "VISIBLE TITLE",
            {"ocr": {"engine": "paddleocr"}, "scene_id": "scene-0001"},
        ]
        connection = FakeConnection(row)
        repository = PostgresMediaRepository(connection)

        repository.upsert_media_asset(
            file_id="file-1",
            asset_type="video_frame",
            path="/media/clip.mp4",
            frame_time_seconds=12.5,
            content_hash="new-hash",
            metadata_json={"scene_id": "scene-0002", "keyframe_index": 1},
        )

        self.assertEqual(row[8], "VISIBLE TITLE")
        self.assertEqual(row[9], {
            "ocr": {"engine": "paddleocr"},
            "scene_id": "scene-0002",
            "keyframe_index": 1,
        })
        self.assertEqual(connection.commits, 1)


if __name__ == "__main__":
    unittest.main()
