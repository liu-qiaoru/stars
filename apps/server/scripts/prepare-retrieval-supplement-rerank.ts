/** 本地准备两组至多20张图片及真实编码摘要，无Provider调用，不保存base64请求正文。 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { agentRerankRequestSchema } from '@local-media-agent/shared/schemas'
import { planEvidenceBudgets, encodeEvidenceWithinBudget, RERANK_SAFE_REQUEST_BYTES } from '../src/agent/agent-rerank.service.js'
import { AGENT_RERANK_IMAGE_MIME } from '../src/agent/agent-rerank.provider.js'
import { dashScopeShadowRerankRequestBytes } from '../src/evaluation/dashscope-shadow-rerank.provider.js'
import { buildLocalReviewEvidence } from './retrieval-review-evidence.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const local = JSON.parse(await readFile(`${root}/supplement-local-preflight.json`, 'utf8'))
const review = JSON.parse(await readFile(`${root}/supplement-review-evidence.json`, 'utf8'))
const testCase = frozen.cases.find((row: any) => row.id === 'cat')
const settings = createSettings(process.env)
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint || local.fingerprint !== frozen.fingerprint || review.fingerprint !== frozen.fingerprint)
    throw new Error('Prepared corpus mismatch')
  const byKey = new Map<string, any>()
  for (const row of review.rows) {
    if (hash(await readFile(resolve(root, row.image))) !== row.manifest.artifact_sha256) throw new Error('Prepared image changed')
    byKey.set(row.candidate_key, { image: row.image, manifest: row.manifest })
  }
  for (const result of testCase.results) {
    const key = result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`
    if (byKey.has(key)) continue
    if (!result.scene_id) throw new Error('Cat preflight requires video scene')
    const asset = (await pool.query('select asset_type from media_assets where id=$1 and file_id=$2 and scene_id=$3', [result.asset_id, result.file_id, result.scene_id])).rows[0]
    if (!asset) throw new Error('Prepared scene identity missing')
    const anchor = asset.asset_type === 'video_frame' ? result.asset_id : (await pool.query(`select id from media_assets
      where scene_id=$1 and asset_type='video_frame' order by frame_time_seconds,id limit 1`, [result.scene_id])).rows[0]?.id
    byKey.set(key, await buildLocalReviewEvidence(pool, { fileId: result.file_id, sceneId: result.scene_id, assetId: anchor, candidateKey: key }))
  }
  const encode = async (keys: string[]) => {
    const weights = keys.map(key => byKey.get(key).manifest.frame_count ?? 1)
    const budgets = planEvidenceBudgets(weights, testCase.query)
    const documents = []
    for (const [index, key] of keys.entries()) {
      const row = byKey.get(key)
      const bytes = await encodeEvidenceWithinBudget(await readFile(resolve(root, row.image)), budgets[index]!)
      documents.push({ index, candidate_key: key, evidence_sha256: hash(bytes), image_base64: bytes.toString('base64') })
    }
    const request = agentRerankRequestSchema.parse({ model: 'qwen3-vl-rerank', query: testCase.query, top_n: 10, documents })
    const size = dashScopeShadowRerankRequestBytes(request, AGENT_RERANK_IMAGE_MIME)
    if (size > RERANK_SAFE_REQUEST_BYTES) throw new Error('Prepared request too large')
    return { model: request.model, query: request.query, candidate_count: keys.length, candidate_keys: keys,
      evidence_sha256: documents.map(row => row.evidence_sha256), request_sha256: hash(JSON.stringify(request)),
      request_bytes: size, maximum_estimated_cost_cny: 0.216, external_calls: 0 }
  }
  const baseline = await encode(local.baseline_candidate_keys)
  const experimental = await encode(local.selection.candidate_keys)
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Prepared index changed')
  await writeFile(`${root}/supplement-rerank-preflight.json`, JSON.stringify({ fingerprint: frozen.fingerprint,
    provenance: 'local_preparation_not_actual_glm_selection', baseline, experimental, required_calls: 2,
    maximum_estimated_cost_cny: 0.432, external_calls: 0,
    evidence: [...byKey].map(([candidate_key, row]) => ({ candidate_key, image: row.image, manifest: row.manifest })) }, null, 2))
  console.log(JSON.stringify({ images: byKey.size, baseline_bytes: baseline.request_bytes, experimental_bytes: experimental.request_bytes, external_calls: 0 }))
} finally { await pool.end() }
