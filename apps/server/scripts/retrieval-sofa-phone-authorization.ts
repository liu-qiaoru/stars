/** 新查询的验收许可边界。仅用于隔离脚本，不给产品授权，也不刷新历史账本。
 * 先校验完整冻结摘要，再把无路径身份转换为旧验收脚本的输入；新场景只属于此诊断池。
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { selectExperimentalCandidates } from '../src/agent/retrieval-candidates.policy.js'
export const SOFA_PHONE_QUERY = '戴白色耳机的人坐在绿色沙发上，手里拿着手机，不要抱臂'
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const approvalSchema = z.object({ source: z.literal('direct_user_message'), authorized_on: z.literal('2026-10-07'),
  user_answer: z.literal('授权。你能不能快点完成这块，我现在检索会走到deepseek决策是否补搜的逻辑上吗'),
  case_id: z.literal('sofa-phone'), protocol: z.literal('matched-multimodal-v1'), model: z.literal('deepseek-v4-flash'),
  fingerprint: sha, freeze_sha256: sha, minimum_revision: z.literal(48), maximum_revision: z.literal(49),
  case_ids: z.tuple([z.literal('sofa-phone')]), maximum_new_calls: z.literal(3), prior_deepseek_agent_calls: z.literal(69),
  prior_product_rerank_calls: z.literal(17), maximum_product_rerank_calls: z.literal(19),
  maximum_candidates: z.literal(20), maximum_frames_per_candidate: z.literal(1), maximum_texts_per_candidate: z.literal(2),
  maximum_characters_per_text: z.literal(1200), maximum_details_per_candidate: z.literal(8), maximum_request_bytes: z.literal(750000),
  maximum_deepseek_total_cost_cny: z.literal(12), maximum_historical_total_cost_cny: z.literal(20),
  unknown_requests_replay: z.literal(false), independent_local_selection_control_allowed: z.literal(true),
}).strict()

/** 摘要与原始完整JSON关联，不能经解析丢字段后为不同来源重新算一个“相同”指纹。 */
export function sofaPhoneDiagnosticSnapshot(raw: any) {
  const { freeze_sha256, ...content } = raw
  if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== freeze_sha256 || raw.case_id !== 'sofa-phone' ||
    raw.query !== SOFA_PHONE_QUERY || raw.candidates.length !== 25 || raw.baseline_candidate_keys.length !== 20 ||
    raw.queries.length !== 2 || raw.probe_origin !== 'developer_local_experiment_not_agent') throw new Error('Diagnostic freeze mismatch')
  const candidateKeys = raw.candidates.map((row: any) => row.candidateKey)
  if (new Set(candidateKeys).size !== 25 || new Set(raw.baseline_candidate_keys).size !== 20 ||
    raw.baseline_candidate_keys.some((key: string) => !candidateKeys.includes(key))) throw new Error('Diagnostic identities invalid')
  const result = (key: string, query: any) => {
    const candidate = raw.candidates.find((row: any) => row.candidateKey === key)
    const hit = query.ranks.find((row: any) => row.candidate_key === key)?.hits[0]
    if (!candidate || !hit || !query.candidate_keys.includes(key)) throw new Error('Diagnostic source identity missing')
    return { asset_id: hit.asset_id, file_id: candidate.fileId, scene_id: candidate.sceneId,
      start_time_seconds: candidate.sceneStartSeconds, end_time_seconds: candidate.sceneEndSeconds,
      ...candidate.retrievalJson, source_matches: hit.source_matches }
  }
  const testCase = { id: 'sofa-phone', query: raw.query, scope: 'visual', target: null,
    request: { ...raw.request, query: raw.query }, results: raw.baseline_candidate_keys.map((key: string) => result(key, raw.queries[0])), reusable_labels: [] }
  return { snapshot: { fingerprint: raw.corpus_fingerprint, protocol: 'sofa-phone-diagnostic-v1', cases: [testCase] },
    approved_keys: candidateKeys as string[], controlled_search: { fingerprint: raw.corpus_fingerprint, query: raw.query,
      provenance: 'local_search_preflight_not_model_decision', observations: [{ query: raw.manual_probe_query,
        results: raw.queries[1].candidate_keys.map((key: string) => result(key, raw.queries[1])) }],
      selection: { candidate_keys: selectExperimentalCandidates(raw.baseline_candidate_keys, raw.queries) } } }
}

/** 只承认此次直接批准的3次新增请求和原剩余2次图片请求。须持锁重读后检查累计次数。
 * 同一case重复启动依然由已有run/version检查拒绝；结果未知的旧请求不能通过此许可重放。
 */
export function sofaPhoneApproval(raw: unknown, scope: { fingerprint: string; freezeSha256: string; revision: number }) {
  const approved = approvalSchema.parse(raw)
  if (approved.fingerprint !== scope.fingerprint || approved.freeze_sha256 !== scope.freezeSha256 ||
    scope.revision < approved.minimum_revision || scope.revision > approved.maximum_revision) throw new Error('Diagnostic approval scope exceeded')
  return approved
}

/** 独立本地选择只允许r49。恢复仍须脚本另行核对已提交的、尚未外发的重排交接。
 * 此许可不允许追加模型请求，也不能把本地变式标为自主补搜。
 */
export function sofaPhoneSelectionControlAllowed(approval: ReturnType<typeof sofaPhoneApproval> | null,
  scope: { caseId: string; revision: number; live: boolean; localChain: boolean }) {
  return Boolean(approval?.independent_local_selection_control_allowed && scope.caseId === 'sofa-phone' &&
    scope.revision === 49 && scope.live && !scope.localChain)
}
