/** 新查询的零外发核验准备。
 * 生产PostgreSQL强制只读；只把所需元数据复制到进程内测试数据库。
 * 复用产品的候选冻结、命中图文工具和本地Worker拼图，绝不创建生产任务或调用付费模型。
 * 新查询不继承旧相关性标签；本地变式不能冒充Agent自主补搜。
 */
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { QdrantClient } from '@qdrant/js-client-rest'
import { createSettings } from '../src/config/settings.js'
import * as schema from '../src/database/schema.js'
import type { Database } from '../src/database/repositories.js'
import { createTestDatabase } from '../tests/database/test-db.js'
import { SearchService } from '../src/search/search.service.js'
import { SearchQueryVectorService } from '../src/search/search-query-vector.service.js'
import { QueryExpansionService } from '../src/search/query-expansion.service.js'
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service.js'
import { AgentV1StepHandler } from '../src/agent/agent-v1-step.handler.js'
import { createDurableAgentRun } from '../src/agent/agent-run.repository.js'
import { SegmentDetailsTool } from '../src/agent/segment-details.tool.js'
import { MatchedEvidenceTool } from '../src/agent/matched-evidence.tool.js'
import { SceneInspectionTool } from '../src/agent/scene-inspection.tool.js'
import { MediaThumbnailService, runFfmpegThumbnail } from '../src/media/media-thumbnail.service.js'
import { RightApiRetrievalDecisionRunner } from '../src/agent/retrieval-decision.runner.js'
import type { RetrievalQuerySnapshot } from '../src/agent/retrieval-candidates.policy.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
import { buildLocalReviewEvidence } from './retrieval-review-evidence.js'

loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const folder = `${root}/sofa-phone`
const previous = JSON.parse(await readFile('../../.scratch/deepseek-matched-retrieval/new-query-results.json', 'utf8'))
const definition = previous.cases.find((row: any) => row.id === 'sofa-phone')
if (!definition) throw new Error('Local query exploration missing')
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: 'false', QUERY_EXPANSION_PROVIDER: 'none',
  AGENT_RETRIEVAL_MODEL: 'deepseek-v4-flash', AGENT_RETRIEVAL_EVIDENCE_MODE: 'matched_multimodal' })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const source = drizzle(pool, { schema }) as unknown as Database
const local = await createTestDatabase()
const db = local.db as unknown as Database
const search = new SearchService(source, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
const noExternal: typeof fetch = async () => { throw new Error('Local review forbids external requests') }
const scope = { search_scope: 'visual' as const, media_types: ['image', 'video'] as Array<'image' | 'video'>, library_ids: [] as string[] }
const request = { ...scope, limit: 20, offset: 0, query_expansion_mode: 'original' as const, ranking_mode: 'rrf' as const, include_diagnostics: false }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (row: any): string => row.scene_id ? `video:${row.scene_id}` : `image:${row.asset_id}`
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

/** 复制的写操作只发生在隔离数据库；自动生成的全文索引列不能直接赋值。
 * 所有素材、场景及向量引用先复制完成，再创建本地任务，防止半份上下文被误认为完整证据。
 */
async function copyMetadata(fileIds: string[]) {
  const files = await source.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.id, fileIds))
  const libraries = await source.select().from(schema.libraries).where(inArray(schema.libraries.id, [...new Set(files.map(row => row.libraryId))]))
  const scenes = await source.select().from(schema.videoScenes).where(inArray(schema.videoScenes.fileId, fileIds))
  const assets = await source.select().from(schema.mediaAssets).where(inArray(schema.mediaAssets.fileId, fileIds))
  const refs = await source.select().from(schema.vectorRefs).where(inArray(schema.vectorRefs.fileId, fileIds))
  await db.insert(schema.libraries).values(libraries)
  await db.insert(schema.mediaFiles).values(files)
  if (scenes.length) await db.insert(schema.videoScenes).values(scenes)
  for (let index = 0; index < assets.length; index += 100)
    await db.insert(schema.mediaAssets).values(assets.slice(index, index + 100).map(({ textTsv: _generated, ...row }) => row))
  for (let index = 0; index < refs.length; index += 100) await db.insert(schema.vectorRefs).values(refs.slice(index, index + 100))
}

try {
  if (await corpusFingerprint(pool) !== previous.fingerprint) throw new Error('Exploration corpus changed')
  // 目录须全新，重跑不能覆盖已冻结的查询、图片或人工评判。
  await mkdir(folder)
  const responses = []
  for (const query of [definition.query, definition.probe]) {
    const response = await search.search({ ...request, query })
    const old = definition.observations.find((row: any) => row.query === query)
    if (JSON.stringify(response.results.map(key)) !== JSON.stringify(old.results.map(key))) throw new Error('Exploration candidate order changed')
    responses.push(response.results)
  }
  // 先前原文命中代表保留，跨查询同场景的不同实际来源仍保存在各轮快照中。
  const firstByKey = new Map<string, (typeof responses)[number][number]>()
  for (const row of responses.flat()) if (!firstByKey.has(key(row))) firstByKey.set(key(row), row)
  const unique = [...firstByKey.values()]
  await copyMetadata([...new Set(unique.map(row => row.file_id))])
  const freezer = new AgentV1StepHandler(db, settings, { isReady: () => false, extract: noExternal } as any, search)
  const candidates = await freezer.freezeCandidates(unique, scope)
  const run = await createDurableAgentRun(db, { prompt: definition.query, retrievalAgent: true, allowExternalText: false,
    allowExternalVisual: false, libraryIds: [], mediaTypes: scope.media_types, searchScope: 'visual' })
  await db.insert(schema.agentRunCandidates).values(candidates.map(row => ({ ...row, id: randomUUID(), runId: run.id,
    sceneStartSeconds: row.sceneStartSeconds === null ? null : String(row.sceneStartSeconds),
    sceneEndSeconds: row.sceneEndSeconds === null ? null : String(row.sceneEndSeconds) })))
  const queries: RetrievalQuerySnapshot[] = responses.map((results, i) => ({ step_id: `local-search-${i + 1}`,
    query: i === 0 ? definition.query : definition.probe, candidate_keys: results.map(key), ranks: results.map((row, index) => ({
      candidate_key: key(row), rank: index + 1, sources: row.reasons,
      hits: [{ asset_id: row.asset_id, rank: index + 1, sources: row.reasons,
        source_matches: 'source_matches' in row ? row.source_matches : [] }] })) }))
  const details = new SegmentDetailsTool(db)
  const frames = new SceneInspectionTool(db, settings, details, new MediaThumbnailService(runFfmpegThumbnail), noExternal)
  const matched = new MatchedEvidenceTool(db, details, frames)
  const batches = []
  // 两个搜索各自不超过20；第二批只用于本地核验来源，不假装已被真实模型检查。
  for (const query of queries) batches.push(await matched.prepare(run.id, query.candidate_keys, [query]))
  const frozen = { case_id: 'sofa-phone', query: definition.query, manual_probe_query: definition.probe,
    probe_origin: 'developer_local_experiment_not_agent', corpus_fingerprint: previous.fingerprint, request,
    model: { decision: 'deepseek-v4-flash', evidence_protocol: 'matched-multimodal-v1', rerank: 'qwen3-vl-rerank' },
    candidates, queries, baseline_candidate_keys: queries[0]!.candidate_keys,
    local_added_keys: queries[1]!.candidate_keys.filter(id => !queries[0]!.candidate_keys.includes(id)),
    human_labels: null, quality_accepted: false, external_calls: 0 }
  const freezeHash = digest(frozen)
  const rows = []
  for (const candidate of candidates) {
    if (!candidate.sceneId) throw new Error('This review supports current video scenes only')
    const anchor = (await pool.query(`select ma.id from media_assets ma where ma.scene_id=$1 and ma.asset_type='video_frame'
      and exists(select 1 from vector_refs vr where vr.asset_id=ma.id and vr.collection_name='video_frame_vectors' and vr.status='indexed')
      order by ma.frame_time_seconds,ma.id limit 1`, [candidate.sceneId])).rows[0]?.id
    if (!anchor) throw new Error('Review indexed frame missing')
    const contact = await buildLocalReviewEvidence(pool, { fileId: candidate.fileId, sceneId: candidate.sceneId, assetId: anchor, candidateKey: candidate.candidateKey })
    const image = batches[0]!.images.find(row => row.candidate_key === candidate.candidateKey) ?? batches[1]!.images.find(row => row.candidate_key === candidate.candidateKey)
    const jpeg = image ? `sofa-phone/${candidate.sceneId}.jpg` : null
    if (image) await writeFile(`${root}/${jpeg}`, Buffer.from(image.data_url.split(',')[1]!, 'base64'), { flag: 'wx' })
    rows.push({ case_id: 'sofa-phone', candidate_key: candidate.candidateKey, file_generation: candidate.fileGeneration,
      contact_sheet: contact.image, contact_manifest: contact.manifest, matched_image: jpeg,
      matched_image_evidence_id: image?.evidence_id ?? null, relevance: null, comment: '' })
    console.log(JSON.stringify({ prepared_review_candidates: rows.length, external_calls: 0 }))
  }
  // 稳定打乱顺序，页面不显示搜索名次、来源、描述或模型判断，减少人工标注偏差。
  rows.sort((a, b) => digest([freezeHash, a.candidate_key]).localeCompare(digest([freezeHash, b.candidate_key])))
  // 只用于准备时估算大小：手工忠实条件不是已收到的模型意图，实际请求前必须重新预检。
  const conditions = [definition.query, '戴白色耳机的人', '坐在绿色沙发上', '手里拿着手机', '不要抱臂'].map((source_text, index) => ({
    condition_id: `preparation-condition-${index}`, source_text, kind: index === 4 ? 'exclusion' : 'must_have', evidence_type: 'visual' }))
  const context = { original_goal: definition.query, conditions, enforced_scope: scope,
    queries: [queries[0]], candidates: candidates.filter(row => queries[0]!.candidate_keys.includes(row.candidateKey)).map(row => ({ candidate_key: row.candidateKey,
      file_id: row.fileId, start_seconds: row.sceneStartSeconds, end_seconds: row.sceneEndSeconds, sources: row.retrievalJson.reasons })),
    matched_evidence: batches[0]!.records, details: {}, assessable_candidate_keys: queries[0]!.candidate_keys,
    unread_candidate_keys: queries[0]!.candidate_keys, baseline: { candidate_keys: queries[0]!.candidate_keys } }
  const preflight = new RightApiRetrievalDecisionRunner(settings, noExternal).preflight(context, batches[0]!.images)
  const estimate = { ...preflight, candidate_count: 20, image_count: batches[0]!.images.length,
    preparation_context_only: true, actual_dispatch_requires_fresh_intent_and_preflight: true,
    maximum_next_reserve_cny: (preflight.request_bytes + 4096) * 8 / 1e6 + 2000 * 28 / 1e6 }
  if (await corpusFingerprint(pool) !== previous.fingerprint) throw new Error('Corpus changed during preparation')
  await writeFile(`${folder}/frozen.json`, JSON.stringify({ ...frozen, freeze_sha256: freezeHash }, null, 2), { flag: 'wx' })
  await writeFile(`${folder}/review-evidence.json`, JSON.stringify({ freeze_sha256: freezeHash, corpus_fingerprint: previous.fingerprint,
    query: definition.query, rows, matched_records: batches.map(batch => ({ records: batch.records, fingerprint: batch.fingerprint })),
    preflight: estimate, external_calls: 0 }, null, 2), { flag: 'wx' })
  const cards = rows.map((row, i) => `<article><h2>候选 ${i + 1}</h2><img src="${escape(row.contact_sheet)}" alt="候选 ${i + 1} 场景拼图">${row.matched_image ? `<details><summary>查看检索实际命中的单帧（模型输入尺寸）</summary><img class="matched" src="${escape(row.matched_image)}" alt="候选 ${i + 1} 实际命中帧"></details>` : '<p>本次没有视觉帧命中，不为文字命中猜造画面。</p>'}<label>全部条件的相关性 <select data-index="${i}"><option value="">未标注</option><option value="2">2 完全符合</option><option value="1">1 部分相关</option><option value="0">0 不相关</option><option value="unknown">无法判断</option></select></label><label>核验备注 <input data-comment="${i}" placeholder="例如：看不清手机，或手臂交叉"></label></article>`).join('')
  const publicRows = rows.map(({ case_id, candidate_key, file_generation, relevance, comment }) => ({ case_id, candidate_key, file_generation, relevance, comment }))
  const data = JSON.stringify(publicRows).replace(/</g, '\\u003c')
  const storage = `stars-human-review:${freezeHash}`
  const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>拿手机与排除抱臂：人工核验</title><style>body{font:16px/1.6 system-ui;margin:24px auto;padding:0 20px;max-width:1100px;color:#17202c}header{position:sticky;top:0;background:white;padding:10px 0;border-bottom:1px solid #ddd}article{border-bottom:1px solid #ddd;padding:20px 0}img{display:block;max-width:100%;max-height:650px}img.matched{image-rendering:auto}label{display:block;margin:12px 0}select,button,input{font:inherit;padding:8px}input{width:min(80%,600px)}textarea{width:100%;height:180px}details{margin:10px 0}</style><header><strong id="progress">0 / ${rows.length} 已标注</strong> <button id="export">下载人工标签</button><button id="show">显示标签JSON</button></header><h1>按新查询核验 ${rows.length} 个场景</h1><p><strong>${escape(definition.query)}</strong></p><p>要求同时检查：白色耳机、坐在绿色沙发、手里拿手机、不要抱臂。场景拼图是离散采样，不能证明全程动作或全程排除；无法确认就选“无法判断”，备注说明原因。2表示符合全部条件，1表示相关但只符合部分条件，0表示不相关。</p><p>这些场景来自原文20条与本地变式新增5条。尚未由模型自主补搜；不同查询不能沿用旧标签。本地页面不外发，选择自动保存在此浏览器。本页隐藏搜索名次、描述和模型判断。</p><textarea id="output" aria-label="人工标签JSON" hidden></textarea>${cards}<script>const rows=${data};const storage=${JSON.stringify(storage)};const meta={case_id:'sofa-phone',query:${JSON.stringify(definition.query)},freeze_sha256:${JSON.stringify(freezeHash)},corpus_fingerprint:${JSON.stringify(previous.fingerprint)},source:'human_review',labels:rows};const output=document.querySelector('#output');function refresh(){rows.forEach((row,i)=>{const value=document.querySelector('[data-index="'+i+'"]').value;row.relevance=value===''||value==='unknown'?null:Number(value);row.review_status=value===''?'not_reviewed':value==='unknown'?'unknown':'labelled';row.comment=document.querySelector('[data-comment="'+i+'"]').value});output.value=JSON.stringify(meta,null,2);localStorage.setItem(storage,output.value);document.querySelector('#progress').textContent=rows.filter(r=>r.review_status!=='not_reviewed').length+' / '+rows.length+' 已标注'}try{const saved=JSON.parse(localStorage.getItem(storage));if(saved&&saved.freeze_sha256===meta.freeze_sha256){rows.forEach((row,i)=>{const old=saved.labels.find(r=>r.candidate_key===row.candidate_key);if(old){document.querySelector('[data-index="'+i+'"]').value=old.review_status==='unknown'?'unknown':old.relevance===null?'':String(old.relevance);document.querySelector('[data-comment="'+i+'"]').value=old.comment||''}})}}catch{}document.querySelectorAll('select,input').forEach(el=>el.addEventListener('change',refresh));document.querySelector('#show').onclick=()=>{refresh();output.hidden=false;output.scrollIntoView()};document.querySelector('#export').onclick=()=>{refresh();const url=URL.createObjectURL(new Blob([output.value],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='sofa-phone-human-labels.json';a.click();URL.revokeObjectURL(url)};refresh();</script></html>`
  await writeFile(`${root}/sofa-phone-human-review.html`, page, { flag: 'wx' })
  console.log(JSON.stringify({ status: 'prepared', candidates: rows.length, files: new Set(candidates.map(row => row.fileId)).size,
    baseline: 20, added: frozen.local_added_keys.length, preflight: estimate, external_calls: 0 }))
} finally { await local.close(); await pool.end() }
