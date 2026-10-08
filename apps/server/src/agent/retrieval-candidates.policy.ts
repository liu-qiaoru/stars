/**
 * 生成可审计的候选选择名单，供隔离验收和正式质量资格入口共同使用。输入是各轮独立名次，
 * 不接收也不比较不同查询的相似度分数。质量报告通过前不能把该名单用于正式输出。
 */
/** 一个原始素材命中。即使折叠为同一场景，也保留它在该次搜索中的位置与通道。 */
export interface RetrievalQueryHit {
  asset_id: string
  rank: number
  sources: string[]
  source_matches?: import('@local-media-agent/shared/schemas').RetrievalSourceMatch[]
}

export interface RetrievalQuerySnapshot {
  step_id: string
  query: string
  candidate_keys: string[]
  /** 原搜索名次及检索通道，跨轮重复候选也不覆盖。 */
  ranks?: Array<{ candidate_key: string; rank: number; sources: string[]; hits?: RetrievalQueryHit[] }>
}

/** 规范化仅用于查重，不更改实际搜索原文。忽略 limit、缺口解释和媒体类型的排列顺序。 */
export function retrievalQuerySignature(query: string, scope: string, types: string[]) {
  return JSON.stringify([query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(), scope, [...new Set(types)].sort()])
}

/**
 * 20 个位置中最多 4 个预留给新增候选，其余优先保留基线；都按每轮 1/(60+名次)
 * 累加选择，同分用稳定身份打破平局。4 是实验容量限制，不是额外付费批次。
 */
export function selectExperimentalCandidates(baseline: string[], queries: RetrievalQuerySnapshot[], limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Candidate selection limit must be 1 to 20')
  const scores = new Map<string, number>()
  for (const query of queries) {
    const ranks = new Map(query.ranks?.map(row => [row.candidate_key, row.rank]))
    for (const [index, key] of [...new Set(query.candidate_keys)].entries()) {
      // 去重不能给原本第20名的候选改成第1名。只有历史无ranks记录才兼容列表位置。
      const rank = ranks.get(key) ?? index + 1
      if (!Number.isInteger(rank) || rank < 1) throw new Error('Invalid persisted retrieval rank')
      scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank))
    }
  }
  const order = (a: string, b: string) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b)
  const base = [...new Set(baseline)]
  const added = [...scores.keys()].filter(key => !base.includes(key)).sort(order)
  const reserved = added.slice(0, Math.min(4, limit))
  const selected = [...base.sort(order).slice(0, limit - reserved.length), ...reserved]
  // 基线不足时利用空位，仍不超过硬上限，也不按首次发现顺序选择。
  for (const key of [...scores.keys()].sort(order)) {
    if (selected.length >= limit) break
    if (!selected.includes(key)) selected.push(key)
  }
  return selected.sort(order)
}
