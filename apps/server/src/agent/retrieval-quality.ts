import { calculateRankingMetrics } from '../ranking/metrics.js'

/**
 * 将冻结查询集的结果保护与新增席位策略的质量分开报告。相同请求复用已确认响应
 * 可证明该样本结果没有变化，却没有实际检验新增候选替换基线的风险。
 * 此函数不启用产品策略；不同请求通过也只覆盖有限样本，不能保证未来查询。
 */
export function summarizeRetrievalQualityAcceptance(cases: Array<{
  accepted: boolean; changed_rerank_input: boolean | null; supplemental_candidates: number
}>) {
  const frozenSuiteAccepted = cases.length > 0 && cases.every(row => row.accepted)
  // 仅改同一名单的顺序同样没有覆盖新增席位；必须实际重排至少一个池外新候选。
  const supplementalExercised = cases.some(row => row.changed_rerank_input === true && row.supplemental_candidates > 0)
  return {
    frozen_suite_accepted: frozenSuiteAccepted,
    enhanced_selection_quality_accepted: frozenSuiteAccepted && supplementalExercised,
    unverified_reason: !frozenSuiteAccepted ? 'frozen_suite_not_accepted'
      : !supplementalExercised ? 'supplemental_selection_not_exercised' : null,
  }
}

/** 只消费冻结的人工作业；不能传入模型分数或为缺失标签填0。此模块无网络和数据库写操作。 */
export interface RetrievalQualityCase {
  baseline: string[]
  enhanced: string[]
  pool: string[]
  judgments: Record<string, 0 | 1 | 2 | null>
  target: string | null
}

export interface HumanReviewLabel {
  case_id: string
  candidate_key: string
  relevance: 0 | 1 | 2 | null
}

/**
 * 只校验人工补标文件的版本、候选归属和数值，不判断标注语义是否正确。
 * 重复条目直接拒绝，不能以文件顺序悄悄覆盖已有等级；未填写仍为null。
 * 错误使用固定文字，避免日志泄露原始素材或用户输入。
 */
export function validateHumanReviewLabels(input: unknown, fingerprint: string,
  cases: Array<{ id: string; candidate_keys: string[] }>): HumanReviewLabel[] {
  if (!input || typeof input !== 'object') throw new Error('Invalid human labels file')
  const file = input as Record<string, unknown>
  if (file.fingerprint !== fingerprint || file.source !== 'human_review' || !Array.isArray(file.labels))
    throw new Error('Human labels version/source mismatch')
  const allowed = new Map(cases.map(row => [row.id, new Set(row.candidate_keys)]))
  const seen = new Set<string>()
  return file.labels.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid human label')
    const label = value as Record<string, unknown>
    if (typeof label.case_id !== 'string' || typeof label.candidate_key !== 'string' ||
      !allowed.get(label.case_id)?.has(label.candidate_key) ||
      (label.relevance !== null && label.relevance !== 0 && label.relevance !== 1 && label.relevance !== 2))
      throw new Error('Invalid human label identity/grade')
    const key = JSON.stringify([label.case_id, label.candidate_key])
    if (seen.has(key)) throw new Error('Duplicate human label')
    seen.add(key)
    return { case_id: label.case_id, candidate_key: label.candidate_key, relevance: label.relevance as HumanReviewLabel['relevance'] }
  })
}

/**
 * 每个查询独立检查 P@5、nDCG@10 与（适用时）Hit@10，固定截断位置与共享理想分母。
 * pool 是两种方法共同冻结的候选池；标签缺失/无法判断使整查询未验收，不计算部分分数。
 */
export function compareRetrievalQuality(input: RetrievalQualityCase) {
  const pool = [...new Set([...input.pool, ...input.baseline, ...input.enhanced])]
  const missing = pool.filter(key => input.judgments[key] === undefined || input.judgments[key] === null)
  const changes = {
    added: input.enhanced.filter(key => !input.baseline.includes(key)),
    lost: input.baseline.filter(key => !input.enhanced.includes(key)),
    rank_changes: pool.map(key => ({ candidate_key: key,
      baseline_rank: input.baseline.includes(key) ? input.baseline.indexOf(key) + 1 : null,
      enhanced_rank: input.enhanced.includes(key) ? input.enhanced.indexOf(key) + 1 : null })),
  }
  if (missing.length) return { ...changes, status: 'unjudged' as const, missing_labels: missing, baseline: null, enhanced: null }
  const judgments = new Map(pool.map(key => [key, input.judgments[key]!]))
  const metrics = (keys: string[]) => {
    const graded = calculateRankingMetrics(keys, judgments, { knownTargetKey: null, fixedCutoff: true })
    const target = input.target === null ? null : calculateRankingMetrics(keys, judgments, { knownTargetKey: input.target }).hitAt10
    return { precisionAt5: graded.precisionAt5!, ndcgAt10: graded.ndcgAt10!, hitAt10: target }
  }
  const baseline = metrics(input.baseline), enhanced = metrics(input.enhanced)
  // 很小的浮点误差不算退化；容差不是可掩盖真实产品差异的百分比阈值。
  const regressed = enhanced.precisionAt5 + 1e-12 < baseline.precisionAt5 ||
    enhanced.ndcgAt10 + 1e-12 < baseline.ndcgAt10 ||
    (baseline.hitAt10 !== null && enhanced.hitAt10! < baseline.hitAt10)
  return { ...changes, status: regressed ? 'regressed' as const : 'non_decreasing' as const,
    missing_labels: [], baseline, enhanced }
}
