/** 只读生成新增候选核验页，复用已有人工标签；无外部模型调用。 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { extendRetrievalReviewPool, retrievalReviewExtensionSchema } from '../src/agent/retrieval-review-pool.js'
import { validateHumanReviewLabels } from '../src/agent/retrieval-quality.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
import { buildLocalReviewEvidence } from './retrieval-review-evidence.js'
loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const settings = createSettings(process.env)
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const extension = retrievalReviewExtensionSchema.parse(JSON.parse(await readFile(`${root}/review-extension.json`, 'utf8')))
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Review corpus changed')
  const generations = new Map<string, number>((await pool.query('select id,index_generation from media_files where deleted_at is null')).rows.map(row => [row.id, row.index_generation]))
  const reviewPool = extendRetrievalReviewPool(frozen.cases.map((row: any) => ({ id: row.id, query: row.query, scope: row.scope,
    media_types: row.request.media_types, library_ids: row.request.library_ids,
    candidate_keys: row.results.map((result: any) => result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`) })), extension, frozen.fingerprint, generations)
  const labels = validateHumanReviewLabels(JSON.parse(await readFile(`${root}/human-labels.json`, 'utf8')), frozen.fingerprint, reviewPool)
  try { labels.push(...validateHumanReviewLabels(JSON.parse(await readFile(`${root}/human-labels-supplemental.json`, 'utf8')), frozen.fingerprint, reviewPool)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const rows = []
  for (const testCase of extension.cases) for (const candidate of testCase.candidates) {
    if (labels.some(row => row.case_id === testCase.id && row.candidate_key === candidate.candidate_key && row.relevance !== null)) continue
    // 清单仍须回表核对asset、file、scene和当前generation；不信任JSON自报身份。
    const asset = (await pool.query(`select ma.id,ma.asset_type,ma.file_id,ma.scene_id,vs.index_generation
      from media_assets ma left join video_scenes vs on vs.id=ma.scene_id where ma.id=$1`, [candidate.asset_id])).rows[0]
    if (!asset || asset.file_id !== candidate.file_id || asset.scene_id !== candidate.scene_id || asset.index_generation !== candidate.file_generation)
      throw new Error('Supplement candidate identity changed')
    if (candidate.media_type !== 'video' || !candidate.scene_id) throw new Error('Supplement review requires scene pictures')
    const anchor = asset.asset_type === 'video_frame' ? asset.id : (await pool.query(`select id from media_assets
      where scene_id=$1 and asset_type='video_frame' order by frame_time_seconds,id limit 1`, [candidate.scene_id])).rows[0]?.id
    const generated = await buildLocalReviewEvidence(pool, { fileId: candidate.file_id, sceneId: candidate.scene_id,
      assetId: anchor, candidateKey: candidate.candidate_key })
    rows.push({ case_id: testCase.id, query: testCase.original_query, candidate_key: candidate.candidate_key,
      image: generated.image, relevance: null, manifest: generated.manifest })
  }
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Review corpus changed during preparation')
  const cards = rows.map((row, index) => `<article><h2>候选 ${index + 1} · ${escape(row.query)}</h2><img src="${escape(row.image)}" alt="待核验场景拼图"><p>请按全部原始条件判断。拼图无法确认时选择“无法判断”。</p><select data-index="${index}"><option value="">未标注</option><option value="2">2 完全符合</option><option value="1">1 部分相关</option><option value="0">0 不相关</option><option value="unknown">无法判断</option></select></article>`).join('')
  await writeFile(`${root}/supplement-review-evidence.json`, JSON.stringify({ fingerprint: frozen.fingerprint, rows, external_calls: 0 }, null, 2))
  const data = JSON.stringify(rows.map(({ manifest, image, query, ...row }) => row)).replace(/</g, '\\u003c')
  await writeFile(`${root}/human-review-supplemental.html`, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>新增候选人工核验</title><style>body{font:16px system-ui;margin:24px;max-width:1100px}img{max-width:100%;max-height:650px}article{border-top:1px solid #ccc;padding:20px 0}select,button{font:inherit;padding:8px}textarea{width:100%;height:180px}</style><h1>仅核验 ${rows.length} 个新增候选</h1><p>已有100条标签继续复用。这是本地页面，不外发。1表示只符合部分条件；无法判断保留空值。未显示模型评分或搜索名次。本地预检不能证明真实Agent已经自主补搜。</p><button id="export">生成人工标签</button><textarea id="output" aria-label="人工标签JSON"></textarea>${cards}<script>const rows=${data};document.querySelector('#export').onclick=()=>{rows.forEach((row,i)=>{const v=document.querySelector('[data-index="'+i+'"]').value;row.relevance=v===''||v==='unknown'?null:Number(v)});document.querySelector('#output').value=JSON.stringify({fingerprint:${JSON.stringify(frozen.fingerprint)},source:'human_review',labels:rows},null,2);window.scrollTo(0,0)};</script></html>`)
  console.log(JSON.stringify({ missing_labels: rows.length, prepared_images: rows.length, external_calls: 0 }))
} finally { await pool.end() }
