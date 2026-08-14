export type VlmBlindSelectionGroup =
  | 'exact_match'
  | 'missing_must_have'
  | 'exclusion_hit'
  | 'partial_relevance'
  | 'insufficient_evidence'

export type DiversityCandidate = {
  candidateId: string
  queryText: string
  eligibleGroups: VlmBlindSelectionGroup[]
  stableOrder: string
}

export type DiversitySlot = {
  proposalId: string
  group: VlmBlindSelectionGroup
}

const selectionGroups: VlmBlindSelectionGroup[] = [
  'exact_match',
  'missing_must_have',
  'exclusion_hit',
  'partial_relevance',
  'insufficient_evidence',
]

/**
 * 把人工分组超过配额的 accepted 叶子替换为缺额组的新 pending 候选。返回计划只描述
 * “哪个前代由哪个候选补到哪个组”，调用方负责在事务中追加后继，绝不改写前代审核。
 */
export function planAcceptedGroupRebalance(input: {
  targetPerGroup: number
  parents: Array<{
    caseId: string
    currentGroup: VlmBlindSelectionGroup
    runId: string
    queryId: string
  }>
  candidates: Array<{
    candidateId: string
    runId: string
    queryId: string
    eligibleGroups: VlmBlindSelectionGroup[]
    stableOrder: string
  }>
}) {
  const counts = countValues(input.parents.map((item) => item.currentGroup))
  const deficits = selectionGroups.flatMap((group) =>
    Array.from(
      { length: Math.max(0, input.targetPerGroup - (counts.get(group) ?? 0)) },
      () => group,
    ),
  )
  const remainingByGroup = new Map(counts)
  const usedParents = new Set<string>()
  const usedCandidates = new Set<string>()
  const result: Array<{
    parentCaseId: string
    candidateId: string
    targetGroup: VlmBlindSelectionGroup
  }> = []

  function assign(index: number): boolean {
    if (index === deficits.length) return true
    const targetGroup = deficits[index]!
    for (const parent of input.parents) {
      if (usedParents.has(parent.caseId)) continue
      if ((remainingByGroup.get(parent.currentGroup) ?? 0) <= input.targetPerGroup) continue
      const candidates = input.candidates
        .filter(
          (candidate) =>
            candidate.runId === parent.runId &&
            candidate.queryId === parent.queryId &&
            candidate.eligibleGroups.includes(targetGroup) &&
            !usedCandidates.has(candidate.candidateId),
        )
        .sort((left, right) => left.stableOrder.localeCompare(right.stableOrder))
      for (const candidate of candidates) {
        usedParents.add(parent.caseId)
        usedCandidates.add(candidate.candidateId)
        remainingByGroup.set(
          parent.currentGroup,
          (remainingByGroup.get(parent.currentGroup) ?? 0) - 1,
        )
        result.push({
          parentCaseId: parent.caseId,
          candidateId: candidate.candidateId,
          targetGroup,
        })
        if (assign(index + 1)) return true
        result.pop()
        remainingByGroup.set(
          parent.currentGroup,
          (remainingByGroup.get(parent.currentGroup) ?? 0) + 1,
        )
        usedCandidates.delete(candidate.candidateId)
        usedParents.delete(parent.caseId)
      }
    }
    return false
  }
  if (!assign(0)) throw new Error('accepted group rebalance has no complete frozen assignment')
  return result
}

/**
 * 新查询必须真正未见：不仅不能与已审核案例重复，也不能复用任何其他历史
 * Evaluation 文本。调用方从 PostgreSQL 读取新 source run 之外的查询全集；
 * 异常只携带数量，避免把本地查询语义写入命令输出或日志。
 */
export function assertFreshQueriesDoNotOverlapHistory(
  freshQueryTexts: Set<string>,
  historicalQueryTexts: Iterable<string>,
) {
  let overlapCount = 0
  for (const queryText of new Set(historicalQueryTexts)) {
    if (freshQueryTexts.has(queryText)) overlapCount += 1
  }
  if (overlapCount > 0) {
    throw new Error(`fresh Evaluation run overlaps ${overlapCount} historical query texts`)
  }
}

/**
 * 为尚未审核的槽位选择替代候选。第一轮使用二分图增广匹配，尽可能让每个槽位
 * 获得尚未出现过的查询；第二轮才允许查询出现第二次。已审核候选只作为只读
 * 计数输入，返回值永远不包含或改写它们。
 */
export function selectDiversePendingCandidates(input: {
  slots: DiversitySlot[]
  candidates: DiversityCandidate[]
  reviewedCandidateIds: Set<string>
  reviewedQueryTexts: string[]
  minimumUniqueQueries: number
  maxPairsPerQuery?: number
}) {
  const maxPairsPerQuery = input.maxPairsPerQuery ?? 2
  const queryCounts = countValues(input.reviewedQueryTexts)
  const selectedCandidateIds = new Set(input.reviewedCandidateIds)
  const available = input.candidates.filter(
    (candidate) => !selectedCandidateIds.has(candidate.candidateId),
  )
  const slotById = new Map(input.slots.map((slot) => [slot.proposalId, slot]))
  const eligibleNewQueriesBySlot = new Map(
    input.slots.map((slot) => [
      slot.proposalId,
      uniqueSorted(
        available
          .filter(
            (candidate) =>
              candidate.eligibleGroups.includes(slot.group) &&
              !queryCounts.has(candidate.queryText),
          )
          .map((candidate) => candidate.queryText),
      ),
    ]),
  )
  const queryToSlot = new Map<string, string>()
  const slotToQuery = new Map<string, string>()

  function assignNewQuery(slotId: string, visitedQueries: Set<string>): boolean {
    for (const queryText of eligibleNewQueriesBySlot.get(slotId) ?? []) {
      if (visitedQueries.has(queryText)) continue
      visitedQueries.add(queryText)
      const previousSlot = queryToSlot.get(queryText)
      if (!previousSlot || assignNewQuery(previousSlot, visitedQueries)) {
        queryToSlot.set(queryText, slotId)
        slotToQuery.set(slotId, queryText)
        return true
      }
    }
    return false
  }

  for (const slot of input.slots) assignNewQuery(slot.proposalId, new Set())

  const result = new Map<string, DiversityCandidate>()
  for (const [slotId, queryText] of slotToQuery) {
    const slot = slotById.get(slotId)!
    const candidate = firstStable(
      available.filter(
        (item) =>
          item.queryText === queryText &&
          item.eligibleGroups.includes(slot.group) &&
          !selectedCandidateIds.has(item.candidateId),
      ),
    )
    if (!candidate) throw new Error(`no candidate remains for diversity slot ${slotId}`)
    result.set(slotId, candidate)
    selectedCandidateIds.add(candidate.candidateId)
    queryCounts.set(queryText, 1)
  }

  for (const slot of input.slots) {
    if (result.has(slot.proposalId)) continue
    const candidate = firstStable(
      available.filter(
        (item) =>
          item.eligibleGroups.includes(slot.group) &&
          !selectedCandidateIds.has(item.candidateId) &&
          (queryCounts.get(item.queryText) ?? 0) < maxPairsPerQuery,
      ),
    )
    if (!candidate) throw new Error(`no capped candidate remains for slot ${slot.proposalId}`)
    result.set(slot.proposalId, candidate)
    selectedCandidateIds.add(candidate.candidateId)
    queryCounts.set(candidate.queryText, (queryCounts.get(candidate.queryText) ?? 0) + 1)
  }

  if (queryCounts.size < input.minimumUniqueQueries) {
    throw new Error(
      `candidate diversity reached only ${queryCounts.size} unique queries; expected ${input.minimumUniqueQueries}`,
    )
  }
  if ([...queryCounts.values()].some((count) => count > maxPairsPerQuery)) {
    throw new Error(`candidate diversity exceeded ${maxPairsPerQuery} pairs for one query`)
  }
  return result
}

function firstStable(candidates: DiversityCandidate[]) {
  return [...candidates].sort((left, right) => left.stableOrder.localeCompare(right.stableOrder))[0]
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function countValues(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}
