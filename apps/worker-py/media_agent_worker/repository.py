import json
import os
import uuid
from pathlib import Path


class PostgresJobRepository:
    def __init__(self, connection):
        self.connection = connection

    def claim_next_job(self, worker_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, job_type, input_json
                FROM jobs
                WHERE status = 'queued'
                ORDER BY priority DESC, created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """
            )
            row = cursor.fetchone()
            if row is None:
                self.connection.commit()
                return None

            job_id, job_type, input_json = row
            cursor.execute(
                """
                UPDATE jobs
                SET status = 'running',
                    locked_by = %s,
                    locked_at = now(),
                    heartbeat_at = now(),
                    attempt = attempt + 1,
                    updated_at = now()
                WHERE id = %s
                """,
                (worker_id, job_id),
            )
            self.connection.commit()
            return {"id": str(job_id), "job_type": job_type, "input_json": input_json}

    def create_job(self, job_type, input_json, timeout_seconds=None):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO jobs (id, job_type, input_json, timeout_seconds, status)
                VALUES (%s, %s, %s, COALESCE(%s, 3600), 'queued')
                """,
                (str(uuid.uuid4()), job_type, json.dumps(input_json), timeout_seconds),
            )
        self.connection.commit()

    def heartbeat(self, job_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                "UPDATE jobs SET heartbeat_at = now(), updated_at = now() WHERE id = %s",
                (job_id,),
            )
        self.connection.commit()

    def mark_succeeded(self, job_id, result):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE jobs
                SET status = 'succeeded',
                    progress = 100,
                    result_json = %s,
                    updated_at = now(),
                    finished_at = now()
                WHERE id = %s
                """,
                (json.dumps(result), job_id),
            )
        self.connection.commit()

    def mark_failed(self, job_id, message):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE jobs
                SET status = 'failed',
                    error_message = %s,
                    updated_at = now(),
                    finished_at = now()
                WHERE id = %s
                """,
                (message, job_id),
            )
        self.connection.commit()


class PostgresMediaRepository:
    def __init__(self, connection):
        self.connection = connection

    def upsert_media_file(self, *, library_id, root_path, path, media_type, size_bytes, mtime_ms):
        relative_path = str(Path(path).relative_to(root_path))
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, size_bytes, mtime_ms
                FROM media_files
                WHERE library_id = %s AND path = %s
                """,
                (library_id, path),
            )
            previous = cursor.fetchone()

            if previous is None:
                file_id = str(uuid.uuid4())
                cursor.execute(
                    """
                    INSERT INTO media_files (
                      id, library_id, path, relative_path, media_type, size_bytes, mtime_ms, index_status
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending')
                    """,
                    (file_id, library_id, path, relative_path, media_type, size_bytes, mtime_ms),
                )
                self.connection.commit()
                return "created", file_id

            file_id, previous_size, previous_mtime = previous
            if previous_size == size_bytes and previous_mtime == mtime_ms:
                return "skipped", str(file_id)

            cursor.execute(
                """
                UPDATE media_files
                SET relative_path = %s,
                    media_type = %s,
                    size_bytes = %s,
                    mtime_ms = %s,
                    index_status = 'pending',
                    updated_at = now()
                WHERE id = %s
                """,
                (relative_path, media_type, size_bytes, mtime_ms, file_id),
            )
            self.connection.commit()
            return "updated", str(file_id)

    def get_media_file(self, file_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, library_id, path, media_type, duration_seconds, width, height, codec
                FROM media_files
                WHERE id = %s
                """,
                (file_id,),
            )
            row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Media file not found: {file_id}")
        return {
            "id": str(row[0]),
            "library_id": str(row[1]),
            "path": row[2],
            "media_type": row[3],
            "duration_seconds": float(row[4]) if row[4] is not None else None,
            "width": row[5],
            "height": row[6],
            "codec": row[7],
        }

    def update_probe_metadata(self, file_id, metadata):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE media_files
                SET duration_seconds = %s,
                    width = %s,
                    height = %s,
                    codec = %s,
                    index_status = 'probed',
                    updated_at = now()
                WHERE id = %s
                """,
                (
                    metadata.get("duration_seconds"),
                    metadata.get("width"),
                    metadata.get("height"),
                    metadata.get("codec"),
                    file_id,
                ),
            )
        self.connection.commit()

    def upsert_media_asset(self, **asset):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, file_id, asset_type, path, start_time_seconds, end_time_seconds, frame_time_seconds, content_hash, text_content, metadata_json
                FROM media_assets
                WHERE file_id = %s
                  AND asset_type = %s
                  AND COALESCE(path, '') = COALESCE(%s, '')
                  AND COALESCE(start_time_seconds, -1) = COALESCE(%s, -1)
                  AND COALESCE(end_time_seconds, -1) = COALESCE(%s, -1)
                  AND COALESCE(frame_time_seconds, -1) = COALESCE(%s, -1)
                """,
                (
                    asset["file_id"],
                    asset["asset_type"],
                    asset.get("path"),
                    asset.get("start_time_seconds"),
                    asset.get("end_time_seconds"),
                    asset.get("frame_time_seconds"),
                ),
            )
            previous = cursor.fetchone()
            if previous is not None:
                has_text_content = "text_content" in asset
                metadata_patch = asset.get("metadata_json", {})
                cursor.execute(
                    """
                    UPDATE media_assets
                    SET content_hash = %s,
                        text_content = CASE WHEN %s THEN %s ELSE text_content END,
                        metadata_json = COALESCE(metadata_json, '{}'::jsonb) || %s::jsonb
                    WHERE id = %s
                    """,
                    (
                        asset.get("content_hash"),
                        has_text_content,
                        asset.get("text_content"),
                        json.dumps(metadata_patch),
                        previous[0],
                    ),
                )
                self.connection.commit()
                previous_metadata = previous[9] or {}
                if isinstance(previous_metadata, str):
                    previous_metadata = json.loads(previous_metadata)
                return {
                    "id": str(previous[0]),
                    "file_id": str(previous[1]),
                    "asset_type": previous[2],
                    "path": previous[3],
                    "start_time_seconds": float(previous[4]) if previous[4] is not None else None,
                    "end_time_seconds": float(previous[5]) if previous[5] is not None else None,
                    "frame_time_seconds": float(previous[6]) if previous[6] is not None else None,
                    "content_hash": previous[7],
                    "text_content": asset["text_content"] if has_text_content else previous[8],
                    "metadata_json": {**previous_metadata, **metadata_patch},
                    "_created": False,
                }

            asset_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO media_assets (
                  id, file_id, asset_type, path, start_time_seconds, end_time_seconds,
                  frame_time_seconds, content_hash, text_content, metadata_json
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    asset_id,
                    asset["file_id"],
                    asset["asset_type"],
                    asset.get("path"),
                    asset.get("start_time_seconds"),
                    asset.get("end_time_seconds"),
                    asset.get("frame_time_seconds"),
                    asset.get("content_hash"),
                    asset.get("text_content"),
                    json.dumps(asset.get("metadata_json", {})),
                ),
            )
        self.connection.commit()
        return {"id": asset_id, **asset, "_created": True}

    def upsert_vector_ref(self, **vector_ref):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, status
                FROM vector_refs
                WHERE collection_name = %s AND point_id = %s
                """,
                (vector_ref["collection_name"], vector_ref["point_id"]),
            )
            previous = cursor.fetchone()
            if previous is not None:
                if previous[1] == "stale":
                    cursor.execute(
                        """
                        UPDATE vector_refs
                        SET status = 'pending',
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (previous[0],),
                    )
                    self.connection.commit()
                    return "created"
                return "skipped"

            cursor.execute(
                """
                INSERT INTO vector_refs (
                  id, asset_id, file_id, library_id, collection_name, point_id,
                  model_name, model_version, vector_kind, vector_dim, distance,
                  content_hash, index_profile, status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                """,
                (
                    str(uuid.uuid4()),
                    vector_ref["asset_id"],
                    vector_ref["file_id"],
                    vector_ref["library_id"],
                    vector_ref["collection_name"],
                    vector_ref["point_id"],
                    vector_ref["model_name"],
                    vector_ref["model_version"],
                    vector_ref["vector_kind"],
                    vector_ref["vector_dim"],
                    vector_ref["distance"],
                    vector_ref["content_hash"],
                    vector_ref["index_profile"],
                ),
            )
        self.connection.commit()
        return "created"

    def get_vector_ref_for_embedding(self, *, asset_id, collection_name, model_name, model_version):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  vr.asset_id, vr.file_id, vr.library_id, vr.collection_name, vr.point_id,
                  vr.model_name, vr.model_version, vr.vector_kind, vr.vector_dim, vr.distance,
                  vr.content_hash, vr.index_profile, ma.asset_type, mf.media_type,
                  ma.start_time_seconds, ma.end_time_seconds, ma.frame_time_seconds, ma.metadata_json
                FROM vector_refs vr
                JOIN media_assets ma ON ma.id = vr.asset_id
                JOIN media_files mf ON mf.id = vr.file_id
                WHERE vr.asset_id = %s
                  AND vr.collection_name = %s
                  AND vr.model_name = %s
                  AND vr.model_version = %s
                """,
                (asset_id, collection_name, model_name, model_version),
            )
            row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Vector ref not found for asset: {asset_id}")
        return {
            "asset_id": str(row[0]),
            "file_id": str(row[1]),
            "library_id": str(row[2]),
            "collection_name": row[3],
            "point_id": str(row[4]),
            "model_name": row[5],
            "model_version": row[6],
            "vector_kind": row[7],
            "vector_dim": row[8],
            "distance": row[9],
            "content_hash": row[10],
            "index_profile": row[11],
            "asset_type": row[12],
            "media_type": row[13],
            "start_time_seconds": float(row[14]) if row[14] is not None else None,
            "end_time_seconds": float(row[15]) if row[15] is not None else None,
            "frame_time_seconds": float(row[16]) if row[16] is not None else None,
            "metadata_json": row[17] or {},
        }

    def invalidate_video_index_assets(self, file_id, segment_strategy):
        stale_metadata = json.dumps({
            "stale": True,
            "stale_reason": "video_reindex",
        })
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id
                FROM media_assets
                WHERE file_id = %s
                  AND asset_type IN ('video_segment', 'video_frame')
                  AND metadata_json->>'segment_strategy' IS DISTINCT FROM %s
                """,
                (file_id, segment_strategy),
            )
            asset_ids = [row[0] for row in cursor.fetchall()]
            if not asset_ids:
                self.connection.commit()
                return {"assets_invalidated": 0, "vector_refs_invalidated": 0}

            cursor.execute(
                """
                UPDATE vector_refs
                SET status = 'stale',
                    updated_at = now()
                WHERE asset_id = ANY(%s)
                  AND status <> 'stale'
                """,
                (asset_ids,),
            )
            vector_refs_invalidated = cursor.rowcount
            cursor.execute(
                """
                UPDATE media_assets
                SET metadata_json = metadata_json || %s::jsonb
                WHERE id = ANY(%s)
                """,
                (stale_metadata, asset_ids),
            )
            assets_invalidated = cursor.rowcount
        self.connection.commit()
        return {
            "assets_invalidated": assets_invalidated,
            "vector_refs_invalidated": vector_refs_invalidated,
        }

    def mark_vector_ref_indexed(self, point_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE vector_refs
                SET status = 'indexed', updated_at = now()
                WHERE point_id = %s
                """,
                (point_id,),
            )
        self.connection.commit()

    def get_media_asset_for_ocr(self, asset_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  ma.id, ma.file_id, ma.asset_type, COALESCE(ma.path, mf.path) AS path,
                  ma.frame_time_seconds, ma.metadata_json
                FROM media_assets ma
                JOIN media_files mf ON mf.id = ma.file_id
                WHERE ma.id = %s
                  AND ma.asset_type IN ('image', 'video_frame')
                """,
                (asset_id,),
            )
            row = cursor.fetchone()
        if row is None:
            raise ValueError(f"OCR asset not found: {asset_id}")
        return {
            "id": str(row[0]),
            "file_id": str(row[1]),
            "asset_type": row[2],
            "path": row[3],
            "frame_time_seconds": float(row[4]) if row[4] is not None else None,
            "metadata_json": row[5] or {},
        }

    def update_asset_ocr_text(self, asset_id, *, text_content, ocr_metadata):
        ocr_patch = json.dumps({"ocr": ocr_metadata})
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE media_assets
                SET text_content = %s,
                    metadata_json = metadata_json || %s::jsonb
                WHERE id = %s
                """,
                (text_content, ocr_patch, asset_id),
            )
        self.connection.commit()


def connect_from_env():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("Install psycopg to run the PostgreSQL-backed worker") from error
    return psycopg.connect(database_url)
