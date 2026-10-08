import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

/** 指纹覆盖活跃文件版本、索引配置及 asset 正文摘要；不把正文、路径或向量写日志。 */
export async function corpusFingerprint(client: Pool) {
  const rows = (await client.query(`select
    (select md5(string_agg(id::text || index_generation::text || size_bytes::text || mtime_ms::text, '|' order by id)) from media_files where deleted_at is null) as files,
    (select md5(string_agg(id::text || coalesce(text_content,'') || metadata_json::text, '|' order by id)) from media_assets) as assets,
    (select md5(string_agg(id::text || index_generation::text || start_time_seconds::text || end_time_seconds::text, '|' order by id)) from video_scenes) as scenes,
    (select md5(string_agg(point_id::text || status || content_hash || model_name || model_version, '|' order by point_id)) from vector_refs) as refs`)).rows
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
