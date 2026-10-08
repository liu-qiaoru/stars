/** 本地验收辅助：只读媒体身份，复用 Worker 生成拼图，不写生产 Job 或证据表。 */
import { spawn } from 'node:child_process'
import type { Pool } from 'pg'

export async function buildLocalReviewEvidence(pool: Pool, candidate: { fileId: string; sceneId: string; assetId: string; candidateKey: string }) {
  const { fileId, sceneId, assetId, candidateKey } = candidate
  const file = (await pool.query(`select id, path, media_type, index_generation, deleted_at is not null as deleted from media_files where id=$1`, [fileId])).rows[0]
  const scene = (await pool.query(`select id, file_id, index_generation, start_time_seconds, end_time_seconds from video_scenes where id=$1`, [sceneId])).rows[0]
  const asset = (await pool.query(`select id, file_id, scene_id, asset_type, coalesce(metadata_json->>'stale','false')='true' as stale from media_assets where id=$1`, [assetId])).rows[0]
  const frames = (await pool.query(`select ma.id as asset_id, ma.file_id, ma.scene_id, ma.asset_type, ma.frame_time_seconds,
    coalesce(ma.metadata_json->>'stale','false')='true' as stale,
    exists(select 1 from vector_refs vr where vr.asset_id=ma.id and vr.collection_name='video_frame_vectors' and vr.status='indexed') as indexed
    from media_assets ma where ma.scene_id=$1 and ma.asset_type='video_frame' order by frame_time_seconds, ma.id`, [sceneId])).rows
  if (!file || !scene || !asset) throw new Error('Local review identity missing')
  // PostgreSQL 小数列读作字符串；Python 严格要求时间是有限数值，传递前统一转换。
  scene.start_time_seconds = Number(scene.start_time_seconds); scene.end_time_seconds = Number(scene.end_time_seconds)
  for (const frame of frames) frame.frame_time_seconds = frame.frame_time_seconds === null ? null : Number(frame.frame_time_seconds)
  const request = { context: { file, scene, candidate_asset: asset, frames }, job: { candidate_key: candidateKey,
    file_id: fileId, file_generation: file.index_generation, scene_id: sceneId, asset_id: assetId, strategies: ['contact_sheet_v1'] } }
  return await new Promise<{ image: string; manifest: any }>((resolve, reject) => {
    const child = spawn('../../.venv/bin/python', ['scripts/build-retrieval-review-evidence.py'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.resume()
    child.on('error', () => reject(new Error('Local review process failed')))
    child.on('close', code => {
      try {
        const data = JSON.parse(stdout)
        if (code !== 0) reject(new Error(`Local Worker review preparation failed: ${data.error_code ?? data.error_type}`))
        else resolve(data)
      } catch { reject(new Error('Local Worker review preparation failed: invalid diagnostic')) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
