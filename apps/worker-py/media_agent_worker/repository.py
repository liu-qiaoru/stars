import json
import os
import uuid
from pathlib import Path


class PostgresJobRepository:
    """Thin SQL adapter for the shared jobs table.

    This worker intentionally has no ORM model of its own; Drizzle/Zod in TypeScript remain the schema authority.
    """

    def __init__(self, connection):
        self.connection = connection

    def claim_next_job(self, worker_id):
        with self.connection.cursor() as cursor:
            # SKIP LOCKED lets multiple local worker processes share one PostgreSQL queue safely.
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

    def mark_failed(self, job_id, message, *, error_code=None, error_details=None):
        # error_code/error_details_json 让 Jobs 页面展示机器可读的结构化错误和技术诊断，
        # 与面向用户的 error_message 一起形成完整的失败说明。
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE jobs
                SET status = 'failed',
                    error_message = %s,
                    error_code = %s,
                    error_details_json = %s,
                    updated_at = now(),
                    finished_at = now()
                WHERE id = %s
                """,
                (
                    message,
                    error_code,
                    json.dumps(error_details) if error_details is not None else None,
                    job_id,
                ),
            )
        self.connection.commit()


class PostgresMediaRepository:
    """Media/job handlers use this adapter to update PostgreSQL facts without owning schema definitions."""

    def __init__(self, connection):
        self.connection = connection

    def upsert_media_file(self, *, library_id, root_path, path, media_type, size_bytes, mtime_ms):
        relative_path = str(Path(path).relative_to(root_path))
        with self.connection.cursor() as cursor:
            # A file's identity inside one library is its absolute path. Size/mtime
            # are the cheap change detector for the default scan mode; full content
            # hashing is intentionally left out of the hot scan path.
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
                SELECT id, library_id, path, media_type, duration_seconds, width, height, codec, index_generation
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
            "index_generation": int(row[8]) if row[8] is not None else 0,
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
            # Asset identity is semantic, not just UUID based: file + asset type + path/time window.
            # This makes scan/index/transcribe reruns idempotent across worker restarts.
            cursor.execute(
                """
                SELECT id, file_id, asset_type, path, start_time_seconds, end_time_seconds, frame_time_seconds, content_hash, text_content, metadata_json, scene_id
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
                # Re-indexing updates only fields owned by the current job. Transcription can add
                # text/metadata later, so absent text_content must preserve the existing value and
                # metadata is patched, not reset. scene_id 同步更新到最新场景（重索引可能换场景）。
                cursor.execute(
                    """
                    UPDATE media_assets
                    SET content_hash = %s,
                        text_content = CASE WHEN %s THEN %s ELSE text_content END,
                        metadata_json = COALESCE(metadata_json, '{}'::jsonb) || %s::jsonb,
                        scene_id = %s
                    WHERE id = %s
                    """,
                    (
                        asset.get("content_hash"),
                        has_text_content,
                        asset.get("text_content"),
                        json.dumps(metadata_patch),
                        asset.get("scene_id"),
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
                    "scene_id": str(previous[10]) if previous[10] is not None else None,
                    "_created": False,
                }

            asset_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO media_assets (
                  id, file_id, asset_type, path, scene_id, start_time_seconds, end_time_seconds,
                  frame_time_seconds, content_hash, text_content, metadata_json
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    asset_id,
                    asset["file_id"],
                    asset["asset_type"],
                    asset.get("path"),
                    asset.get("scene_id"),
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
            # vector_refs are created before embedding; the embedding job later writes Qdrant and marks them indexed.
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
                  ma.start_time_seconds, ma.end_time_seconds, ma.frame_time_seconds, ma.metadata_json,
                  ma.text_content, ma.scene_id
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
            "text_content": row[18],
            # scene_id 是正式列：视频帧/caption 引用真实 video_scenes 行；Qdrant payload 冗余保存它
            # 供分组检索（group_by=scene_id）和诊断使用，最终事实仍以 PostgreSQL 为准。
            "scene_id": str(row[19]) if row[19] is not None else None,
        }

    def get_caption_source_asset(self, asset_id):
        # 阶段 2 后只有图片走 caption-v1 单图来源；视频场景 Caption 直接用 video_scenes.id，
        # 不再以 video_segment 资产作为 Caption 来源。
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  ma.id, ma.file_id, ma.asset_type, COALESCE(ma.path, mf.path) AS path,
                  ma.start_time_seconds, ma.end_time_seconds, ma.frame_time_seconds,
                  ma.content_hash, ma.metadata_json, mf.library_id, mf.media_type
                FROM media_assets ma
                JOIN media_files mf ON mf.id = ma.file_id
                WHERE ma.id = %s
                  AND ma.asset_type = 'image'
                """,
                (asset_id,),
            )
            row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Caption source asset not found: {asset_id}")
        return {
            "id": str(row[0]),
            "file_id": str(row[1]),
            "asset_type": row[2],
            "path": row[3],
            "start_time_seconds": float(row[4]) if row[4] is not None else None,
            "end_time_seconds": float(row[5]) if row[5] is not None else None,
            "frame_time_seconds": float(row[6]) if row[6] is not None else None,
            "content_hash": row[7],
            "metadata_json": row[8] or {},
            "library_id": str(row[9]),
            "media_type": row[10],
        }

    def upsert_video_scene(
        self, *, file_id, scene_key, start_time_seconds, end_time_seconds, detection_strategy,
        strategy_fingerprint, index_generation,
    ):
        # 场景身份在 (file_id, scene_key, index_generation) 上幂等。重索引产生新 generation 时，
        # 旧 generation 的场景由阶段 3 的 purge 任务清理；本处只保证当前 generation 的场景可重复写入。
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO video_scenes (
                  id, file_id, scene_key, start_time_seconds, end_time_seconds,
                  detection_strategy, strategy_fingerprint, index_generation
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (file_id, scene_key, index_generation) DO UPDATE
                SET start_time_seconds = EXCLUDED.start_time_seconds,
                    end_time_seconds = EXCLUDED.end_time_seconds,
                    detection_strategy = EXCLUDED.detection_strategy,
                    strategy_fingerprint = EXCLUDED.strategy_fingerprint,
                    updated_at = now()
                RETURNING id
                """,
                (
                    str(uuid.uuid4()),
                    file_id,
                    scene_key,
                    start_time_seconds,
                    end_time_seconds,
                    detection_strategy,
                    strategy_fingerprint,
                    index_generation,
                ),
            )
            row = cursor.fetchone()
        self.connection.commit()
        return {"id": str(row[0]), "file_id": file_id, "scene_key": scene_key}

    def get_video_scene(self, scene_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT vs.id, vs.file_id, vs.scene_key, vs.start_time_seconds, vs.end_time_seconds,
                       vs.index_generation, mf.library_id, mf.path
                FROM video_scenes vs
                JOIN media_files mf ON mf.id = vs.file_id
                WHERE vs.id = %s
                """,
                (scene_id,),
            )
            row = cursor.fetchone()
        if row is None:
            raise ValueError(f"Video scene not found: {scene_id}")
        return {
            "id": str(row[0]),
            "file_id": str(row[1]),
            "scene_key": row[2],
            "start_time_seconds": float(row[3]) if row[3] is not None else None,
            "end_time_seconds": float(row[4]) if row[4] is not None else None,
            "index_generation": int(row[5]) if row[5] is not None else 0,
            "library_id": str(row[6]),
            "path": row[7],
        }

    def list_scene_frames(self, scene_id):
        # 按正式 video_scenes.id 取该场景下按时间排序的视频帧 asset（scene_id 外键列），
        # 取代旧的 metadata_json.scene_id 匹配。
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                  ma.id, ma.file_id, ma.asset_type, COALESCE(ma.path, mf.path) AS path,
                  ma.frame_time_seconds, ma.content_hash, ma.metadata_json
                FROM media_assets ma
                JOIN media_files mf ON mf.id = ma.file_id
                WHERE ma.scene_id = %s
                  AND ma.asset_type = 'video_frame'
                  AND COALESCE(ma.metadata_json->>'stale', 'false') <> 'true'
                ORDER BY ma.frame_time_seconds ASC, ma.id ASC
                """,
                (scene_id,),
            )
            rows = cursor.fetchall()
        return [
            {
                "id": str(row[0]),
                "file_id": str(row[1]),
                "asset_type": row[2],
                "path": row[3],
                "frame_time_seconds": float(row[4]) if row[4] is not None else None,
                "content_hash": row[5],
                "metadata_json": row[6] or {},
            }
            for row in rows
        ]

    def mark_vector_ref_indexed(self, point_id):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE vector_refs
                SET status = 'indexed', updated_at = now()
                WHERE point_id = %s
                  AND status IN ('pending', 'indexed')
                """,
                (point_id,),
            )
            cursor.execute(
                """
                UPDATE media_files AS media_file
                SET index_status = 'indexed', updated_at = now()
                FROM vector_refs AS vector_ref
                WHERE vector_ref.point_id = %s
                  AND vector_ref.file_id = media_file.id
                  AND vector_ref.status = 'indexed'
                  AND media_file.deleted_at IS NULL
                """,
                (point_id,),
            )
        self.connection.commit()


def connect_from_env():
    # Runtime worker entrypoint: tests usually inject fake repositories instead of opening a real PostgreSQL connection.
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("Install psycopg to run the PostgreSQL-backed worker") from error
    return psycopg.connect(database_url)
