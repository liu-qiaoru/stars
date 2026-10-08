/** 对新查询生成真实重排编码预检，始终零外发。
 * 读取已冻结场景拼图，复用产品的图片预算和编码；不调用影子Provider、不更改其额度。
 * 实验名单来自人工本地变式，仅能作为选择策略对照，不能冒充模型自主补搜。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { agentRerankRequestSchema } from '@local-media-agent/shared/schemas'
import { planEvidenceBudgets, encodeEvidenceWithinBudget, RERANK_SAFE_REQUEST_BYTES } from '../src/agent/agent-rerank.service.js'
import { AGENT_RERANK_IMAGE_MIME } from '../src/agent/agent-rerank.provider.js'
import { dashScopeShadowRerankRequestBytes } from '../src/evaluation/dashscope-shadow-rerank.provider.js'
import { selectExperimentalCandidates } from '../src/agent/retrieval-candidates.policy.js'
const root = '../../.scratch/retrieval-quality'
const folder = `${root}/sofa-phone`
const frozen = JSON.parse(await readFile(`${folder}/frozen.json`, 'utf8'))
const review = JSON.parse(await readFile(`${folder}/review-evidence.json`, 'utf8'))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const { freeze_sha256, ...content } = frozen
if (hash(JSON.stringify(content)) !== freeze_sha256 || review.freeze_sha256 !== freeze_sha256) throw new Error('New query freeze changed')
const byKey = new Map<string, any>(review.rows.map((row: any) => [row.candidate_key, row]))

/** 逐张核对Worker图片指纹，再使用与正式服务相同的20张预算分配和JPEG编码。
 * 预检只保存摘要、身份和字节数；不把base64正文写到文件或普通日志。
 */
async function encode(keys: string[]) {
  const weights = keys.map(key => byKey.get(key).contact_manifest.frame_count)
  const budgets = planEvidenceBudgets(weights, frozen.query)
  const documents = []
  for (const [index, key] of keys.entries()) {
    const row = byKey.get(key)
    const raw = await readFile(resolve(root, row.contact_sheet))
    if (hash(raw) !== row.contact_manifest.artifact_sha256) throw new Error('Review image changed')
    const bytes = await encodeEvidenceWithinBudget(raw, budgets[index]!)
    documents.push({ index, candidate_key: key, evidence_sha256: hash(bytes), image_base64: bytes.toString('base64') })
  }
  const request = agentRerankRequestSchema.parse({ model: 'qwen3-vl-rerank', query: frozen.query, top_n: 10, documents })
  const bytes = dashScopeShadowRerankRequestBytes(request, AGENT_RERANK_IMAGE_MIME)
  if (bytes > RERANK_SAFE_REQUEST_BYTES) throw new Error('New query rerank request exceeds product limit')
  return { candidate_keys: keys, image_count: documents.length, evidence_sha256: documents.map(row => row.evidence_sha256),
    request_sha256: hash(JSON.stringify(request)), request_bytes: bytes, maximum_estimated_cost_cny: 0.216, external_calls: 0 }
}

const baseline = await encode(frozen.baseline_candidate_keys)
const experimentalKeys = selectExperimentalCandidates(frozen.baseline_candidate_keys, frozen.queries)
const experimental = await encode(experimentalKeys)
await writeFile(`${folder}/rerank-preflight.json`, JSON.stringify({ freeze_sha256, query: frozen.query, baseline,
  local_strategy_control: experimental, local_added_candidates_selected: experimentalKeys.filter(key => !frozen.baseline_candidate_keys.includes(key)),
  origin: 'developer_local_query_not_autonomous_agent', actual_dispatch_requires_fresh_identity_and_budget_checks: true,
  human_quality_accepted: false, maximum_calls_if_two_distinct_inputs_approved: 2, maximum_estimated_cost_cny: 0.432,
  external_calls: 0 }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ baseline_images: baseline.image_count, baseline_bytes: baseline.request_bytes,
  local_strategy_images: experimental.image_count, local_strategy_bytes: experimental.request_bytes,
  selected_local_added: experimentalKeys.filter(key => !frozen.baseline_candidate_keys.includes(key)).length, external_calls: 0 }))
