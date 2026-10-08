import { retrievalQualityQualificationSchema } from '@local-media-agent/shared/schemas'
import { selectExperimentalCandidates, type RetrievalQuerySnapshot } from './retrieval-candidates.policy.js'
import { compareRetrievalQuality, summarizeRetrievalQualityAcceptance } from './retrieval-quality.js'

export const RETRIEVAL_SELECTION_VERSION = 'evidence-selection-v2'
export interface RetrievalSelectionInput {
  query: string
  scope: { search_scope: string; media_types: string[]; library_ids: string[] }
  baseline: string[]
  queries: RetrievalQuerySnapshot[]
  fingerprint: string
  configuration_fingerprint: string
  stop_reason: string
  /** 产品传入冻结完整查询集，不能只提交通过的一条而省略退化查询。 */
  required_queries?: Record<string, string>
}
export interface RetrievalSelectionPlan {
  candidate_keys: string[]
  experimental_candidate_keys: string[]
  result_mode: 'baseline' | 'enhanced' | 'evaluation'
  policy_version: typeof RETRIEVAL_SELECTION_VERSION
  qualification_id: string | null
  fallback_reason: string | null
}
const equal = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
const scopeKey = (scope: RetrievalSelectionInput['scope']) => JSON.stringify([scope.search_scope,
  [...new Set(scope.media_types)].sort(), [...new Set(scope.library_ids)].sort()])

/**
 * 产品和隔离评测唯一的20席位选择入口，无数据库或外部调用。
 * 资格只覆盖记录中的原文/范围/素材版本/配置及实际测试名单，不能推广到其他未来查询。
 * evaluation仅供隔离脚本显式注入，不是客户端参数；任务状态不能授予质量资格。
 */
export function selectRetrievalCandidatePlan(input: RetrievalSelectionInput,
  options: { qualification?: unknown; evaluation?: boolean } = {}): RetrievalSelectionPlan {
  const experimental = selectExperimentalCandidates(input.baseline, input.queries)
  const plan: RetrievalSelectionPlan = { candidate_keys: [...input.baseline], experimental_candidate_keys: experimental,
    result_mode: 'baseline', policy_version: RETRIEVAL_SELECTION_VERSION, qualification_id: null,
    fallback_reason: 'quality_not_accepted' }
  if (options.evaluation) return { ...plan, result_mode: 'evaluation', candidate_keys: experimental, fallback_reason: null }
  // 文字工具无法核实画面，与partial一样允许独立人工质量资格判断名单。
  // 此状态本身不会授予资格；下面仍校验完整查询、版本、名单和逐查询指标。
  if (!['found', 'partial', 'visual_evidence_unverified'].includes(input.stop_reason)) return { ...plan, fallback_reason: input.stop_reason }
  const parsed = retrievalQualityQualificationSchema.safeParse(options.qualification)
  if (!parsed.success) return plan
  const report = parsed.data
  if (report.fingerprint !== input.fingerprint || report.configuration_fingerprint !== input.configuration_fingerprint)
    return { ...plan, fallback_reason: 'quality_context_changed' }
  if (input.required_queries && (report.cases.length !== Object.keys(input.required_queries).length ||
    Object.entries(input.required_queries).some(([id, query]) => !report.cases.some(row => row.id === id && row.query === query))))
    return { ...plan, fallback_reason: 'quality_suite_incomplete' }
  const ids = new Set<string>()
  const verdicts = report.cases.map(row => {
    const pool = [...new Set([...row.baseline_candidate_keys, ...row.selected_candidate_keys])]
    const lists = [row.baseline_candidate_keys, row.selected_candidate_keys, row.baseline_final, row.enhanced_final]
    const labels = row.judgments.map(item => item.candidate_key)
    const valid = !ids.has(row.id) && lists.every(list => new Set(list).size === list.length) &&
      row.baseline_final.every(key => row.baseline_candidate_keys.includes(key)) &&
      row.enhanced_final.every(key => row.selected_candidate_keys.includes(key)) &&
      new Set(labels).size === labels.length && labels.every(key => pool.includes(key)) &&
      (row.target === null || pool.includes(row.target)) &&
      (pool.length === 0 || (row.baseline_request !== null && row.enhanced_request !== null))
    ids.add(row.id)
    const comparison = compareRetrievalQuality({ baseline: row.baseline_final, enhanced: row.enhanced_final,
      pool, judgments: Object.fromEntries(row.judgments.map(item => [item.candidate_key, item.relevance as 0 | 1 | 2])), target: row.target })
    const added = row.selected_candidate_keys.filter(key => !row.baseline_candidate_keys.includes(key)).length
    // 新名单却复用同一请求身份是无效对照；未知、缺标或任一查询退化都拒绝。
    const changed = row.baseline_request?.request_sha256 !== row.enhanced_request?.request_sha256
    return { accepted: valid && comparison.status === 'non_decreasing' && (!added || changed),
      changed_rerank_input: changed, supplemental_candidates: added }
  })
  if (!summarizeRetrievalQualityAcceptance(verdicts).enhanced_selection_quality_accepted) return plan
  const match = report.cases.find(row => row.query === input.query && scopeKey(row.scope) === scopeKey(input.scope) &&
    equal(row.baseline_candidate_keys, input.baseline) && equal(row.selected_candidate_keys, experimental))
  if (!match) return { ...plan, fallback_reason: 'quality_context_changed' }
  return { ...plan, candidate_keys: experimental, result_mode: 'enhanced', qualification_id: report.report_id, fallback_reason: null }
}
