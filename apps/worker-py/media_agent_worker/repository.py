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

    def create_job(self, job_type, input_json):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO jobs (id, job_type, input_json, status)
                VALUES (%s, %s, %s, 'queued')
                """,
                (str(uuid.uuid4()), job_type, json.dumps(input_json)),
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
                SELECT id, file_id, asset_type, path, start_time_seconds, end_time_seconds, content_hash
                FROM media_assets
                WHERE file_id = %s
                  AND asset_type = %s
                  AND COALESCE(path, '') = COALESCE(%s, '')
                  AND COALESCE(start_time_seconds, -1) = COALESCE(%s, -1)
                  AND COALESCE(end_time_seconds, -1) = COALESCE(%s, -1)
                """,
                (
                    asset["file_id"],
                    asset["asset_type"],
                    asset.get("path"),
                    asset.get("start_time_seconds"),
                    asset.get("end_time_seconds"),
                ),
            )
            previous = cursor.fetchone()
            if previous is not None:
                return {
                    "id": str(previous[0]),
                    "file_id": str(previous[1]),
                    "asset_type": previous[2],
                    "path": previous[3],
                    "start_time_seconds": float(previous[4]) if previous[4] is not None else None,
                    "end_time_seconds": float(previous[5]) if previous[5] is not None else None,
                    "content_hash": previous[6],
                }

            asset_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO media_assets (
                  id, file_id, asset_type, path, start_time_seconds, end_time_seconds, content_hash
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    asset_id,
                    asset["file_id"],
                    asset["asset_type"],
                    asset.get("path"),
                    asset.get("start_time_seconds"),
                    asset.get("end_time_seconds"),
                    asset.get("content_hash"),
                ),
            )
        self.connection.commit()
        return {"id": asset_id, **asset}

    # Mock 阶段直接标记为 indexed，因为 mock vector 无需真实模型推理。
    # 真实 embedding 阶段应先写 pending，模型推理成功后再更新为 indexed。
    def upsert_vector_ref(self, **vector_ref):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id
                FROM vector_refs
                WHERE collection_name = %s AND point_id = %s
                """,
                (vector_ref["collection_name"], vector_ref["point_id"]),
            )
            previous = cursor.fetchone()
            if previous is not None:
                return "skipped"

            cursor.execute(
                """
                INSERT INTO vector_refs (
                  id, asset_id, file_id, library_id, collection_name, point_id,
                  model_name, model_version, vector_kind, vector_dim, distance,
                  content_hash, index_profile, status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'indexed')
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


def connect_from_env():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("Install psycopg to run the PostgreSQL-backed worker") from error
    return psycopg.connect(database_url)
