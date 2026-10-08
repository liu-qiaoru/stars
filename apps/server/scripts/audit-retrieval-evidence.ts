/**
 * 对已完成验收的文字/图片分歧做只读来源核对。生产 PostgreSQL 强制只读，
 * 只保存身份、时间、版本及布尔检查，不保存素材正文、路径或模型内部思考。
 * 来源一致只能排除部分接线错误，不能把 Caption 或 GLM 判断认证为画面真值。
 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'

loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const observations = JSON.parse(await readFile(`${root}/real-semantic-observations-r7.json`, 'utf8'))
const saved = JSON.parse(await readFile(`${root}/exclusion-r7-experimental.json`, 'utf8'))
const state = [...saved.steps].reverse().find(step => step.outputJson?.retrieval_state)?.outputJson.retrieval_state
const pool = new Pool({ connectionString: createSettings(process.env).databaseUrl,
  options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const items: unknown[] = []
const sameSeconds = (a: unknown, b: unknown) => a !== null && b !== null &&
  Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 0.000001
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Frozen index changed; no source verdict')
  for (const observation of observations.observations.filter((row: any) => row.case_id === 'exclusion')) {
    const candidate = saved.candidates.find((row: any) => row.candidateKey === observation.candidate_key)
    const derived = saved.evidence.find((row: any) => row.candidateKey === observation.candidate_key)
    if (!candidate || !derived || !state?.details[observation.candidate_key]) throw new Error('Saved candidate evidence missing')
    for (const evidence of state.details[observation.candidate_key].evidence.filter((row: any) => row.source === 'pre_generated_caption')) {
      const assetId = evidence.evidence_id.split(':')[0]
      const caption = (await pool.query(`select ma.id, ma.file_id, ma.scene_id, ma.start_time_seconds, ma.end_time_seconds,
        ma.text_content, ma.metadata_json, vs.file_id as scene_file_id, vs.index_generation as scene_generation,
        vs.start_time_seconds as scene_start, vs.end_time_seconds as scene_end, mf.index_generation as file_generation
        from media_assets ma join video_scenes vs on vs.id=ma.scene_id join media_files mf on mf.id=ma.file_id
        where ma.id=$1 and ma.asset_type='caption' and mf.deleted_at is null`, [assetId])).rows[0]
      if (!caption) throw new Error('Current caption identity missing')
      const times = caption.metadata_json?.frame_times_seconds
      const indexedFrames = (await pool.query(`select ma.frame_time_seconds from media_assets ma
        where ma.scene_id=$1 and ma.file_id=$2 and ma.asset_type='video_frame'
        and coalesce(ma.metadata_json->>'stale','false')!='true'
        and exists(select 1 from vector_refs vr where vr.asset_id=ma.id and vr.status='indexed' and vr.collection_name='video_frame_vectors')`,
      [candidate.sceneId, candidate.fileId])).rows
      const validTimes = Array.isArray(times) && times.length > 0 && times.every(time => typeof time === 'number' && Number.isFinite(time))
      items.push({ candidate_key: observation.candidate_key, caption_asset_id: assetId,
        candidate_scene_matches: caption.scene_id === candidate.sceneId,
        caption_file_matches: caption.file_id === candidate.fileId && caption.scene_file_id === candidate.fileId,
        caption_metadata_scene_matches: caption.metadata_json?.scene_id === candidate.sceneId,
        generation_matches: caption.scene_generation === candidate.fileGeneration && caption.file_generation === candidate.fileGeneration,
        prompt_version_matches: caption.metadata_json?.prompt_version === 'scene-caption-v2',
        caption_bounds_match_scene: sameSeconds(caption.start_time_seconds, caption.scene_start) && sameSeconds(caption.end_time_seconds, caption.scene_end),
        caption_text_matches_recorded_detail: caption.text_content?.slice(0, 1200) === evidence.text,
        caption_frame_count: validTimes ? times.length : null,
        caption_frame_times_in_scene: validTimes ? times.every((time: number) => time >= Number(caption.scene_start) && time <= Number(caption.scene_end)) : null,
        caption_frames_exist_in_indexed_scene: validTimes ? times.every((time: number) => indexedFrames.some(frame => sameSeconds(time, frame.frame_time_seconds))) : null,
        same_caption_and_review_frame_times: validTimes ? times.length === derived.manifestJson.frame_time_seconds.length &&
          times.every((time: number, index: number) => sameSeconds(time, derived.manifestJson.frame_time_seconds[index])) : null,
        scene_seconds: Number(caption.scene_end) - Number(caption.scene_start),
        continuous_action_verified: false,
      })
    }
  }
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Index changed during source audit')
  await writeFile(`${root}/exclusion-caption-source-audit.json`, JSON.stringify({ fingerprint: frozen.fingerprint,
    checked_at: new Date().toISOString(), production_database: 'read_only', external_calls: 0, items,
    note: 'Identity and same-frame checks do not verify visual facts or override human labels' }, null, 2))
  console.log(JSON.stringify({ audited_captions: items.length, external_calls: 0, report: 'exclusion-caption-source-audit.json' }))
} finally { await pool.end() }
