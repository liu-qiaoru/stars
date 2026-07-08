export type HybridReason = 'vector_match' | 'transcript_match' | 'ocr_match'

export interface HybridCandidateInput {
  asset_id: string
  file_id: string
  media_type: string
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  scene_id: string | null
  reasons: HybridReason[]
  source_scores: Record<string, number>
}

export interface HybridSearchResult extends HybridCandidateInput {
  merged_asset_ids: string[]
  score: number
  score_kind: 'hybrid_score'
  primary_reason: HybridReason
  confidence: 'high' | 'low'
}

interface MergeCandidate extends HybridCandidateInput {
  merged_asset_ids: string[]
  representative_contribution: number
}

const ADJACENT_VIDEO_WINDOW_SECONDS = 5
const VECTOR_SOURCE_WEIGHT = 0.55
const TEXT_SOURCE_WEIGHT = 0.45
const MULTI_SIGNAL_BONUS = 0.08
const MIN_VECTOR_ONLY_RAW_SCORE = 0.05
const REASON_TIE_BREAK_ORDER: HybridReason[] = ['transcript_match', 'ocr_match', 'vector_match']

// Hybrid reranker 是纯函数，方便用单测固定合并和打分语义。
// 输入候选已经通过 PostgreSQL 补齐事实字段；这里不再访问数据库或 Qdrant。
export function buildHybridResults(
  candidates: HybridCandidateInput[],
  options: { limit: number; offset: number },
): HybridSearchResult[] {
  const assetOrder = new Map(candidates.map((candidate, index) => [candidate.asset_id, index]))
  const mergedByAsset = mergeSameAsset(candidates)
  const mergedWindows = mergeAdjacentVideoWindows(mergedByAsset, assetOrder)

  return mergedWindows
    .map((candidate) => rankCandidate(sortMergedAssetIds(candidate, assetOrder)))
    .sort((left, right) => compareRankedResults(left, right))
    .slice(options.offset, options.offset + options.limit)
}

function mergeSameAsset(candidates: HybridCandidateInput[]): MergeCandidate[] {
  const merged = new Map<string, MergeCandidate>()
  for (const candidate of candidates) {
    const existing = merged.get(candidate.asset_id)
    const next = toMergeCandidate(candidate)
    if (!existing) {
      merged.set(candidate.asset_id, next)
      continue
    }
    merged.set(candidate.asset_id, combineCandidates(existing, next))
  }
  return [...merged.values()]
}

function mergeAdjacentVideoWindows(
  candidates: MergeCandidate[],
  assetOrder: Map<string, number>,
): MergeCandidate[] {
  // 相邻视频窗口可能来自不同 asset：比如视觉 segment 命中和 transcript chunk 命中。
  // 合并后 asset_id 选择贡献最强的代表，完整来源保存在 merged_asset_ids。
  const timedVideos = candidates
    .filter(
      (candidate) =>
        candidate.media_type === 'video' &&
        candidate.start_time_seconds !== null &&
        candidate.end_time_seconds !== null,
    )
    .sort((left, right) => {
      if (left.file_id !== right.file_id) {
        return left.file_id.localeCompare(right.file_id)
      }
      return (left.start_time_seconds ?? 0) - (right.start_time_seconds ?? 0)
    })
  const otherCandidates = candidates.filter(
    (candidate) =>
      candidate.media_type !== 'video' ||
      candidate.start_time_seconds === null ||
      candidate.end_time_seconds === null,
  )
  const mergedVideos: MergeCandidate[] = []

  for (const candidate of timedVideos) {
    const previous = mergedVideos[mergedVideos.length - 1]
    if (previous && canMergeVideoWindows(previous, candidate)) {
      mergedVideos[mergedVideos.length - 1] = combineCandidates(previous, candidate)
    } else {
      mergedVideos.push(candidate)
    }
  }

  return [...otherCandidates, ...mergedVideos].map((candidate) =>
    sortMergedAssetIds(candidate, assetOrder),
  )
}

function canMergeVideoWindows(left: MergeCandidate, right: MergeCandidate) {
  if (left.file_id !== right.file_id) {
    return false
  }
  if (left.end_time_seconds === null || right.start_time_seconds === null) {
    return false
  }
  return right.start_time_seconds - left.end_time_seconds <= ADJACENT_VIDEO_WINDOW_SECONDS
}

function toMergeCandidate(candidate: HybridCandidateInput): MergeCandidate {
  return {
    ...candidate,
    reasons: uniqueReasons(candidate.reasons),
    source_scores: { ...candidate.source_scores },
    merged_asset_ids: [candidate.asset_id],
    representative_contribution: strongestContribution(candidate),
  }
}

function combineCandidates(left: MergeCandidate, right: MergeCandidate): MergeCandidate {
  // source_scores 对同一 source 取 max，表示保留最强信号；sum/average 会被窗口数量扭曲。
  const rightIsStronger = right.representative_contribution > left.representative_contribution
  return {
    asset_id: rightIsStronger ? right.asset_id : left.asset_id,
    file_id: left.file_id,
    media_type: left.media_type,
    path: left.path,
    start_time_seconds: minNullable(left.start_time_seconds, right.start_time_seconds),
    end_time_seconds: maxNullable(left.end_time_seconds, right.end_time_seconds),
    scene_id: left.scene_id === right.scene_id ? left.scene_id : null,
    reasons: uniqueReasons([...left.reasons, ...right.reasons]),
    source_scores: mergeSourceScores(left.source_scores, right.source_scores),
    merged_asset_ids: uniqueStrings([...left.merged_asset_ids, ...right.merged_asset_ids]),
    representative_contribution: Math.max(
      left.representative_contribution,
      right.representative_contribution,
    ),
  }
}

function rankCandidate(candidate: MergeCandidate): HybridSearchResult {
  const { score, primaryReason } = scoreCandidate(candidate)
  const { representative_contribution: _representativeContribution, ...result } = candidate
  return {
    ...result,
    score,
    score_kind: 'hybrid_score',
    primary_reason: primaryReason,
    confidence: confidenceForCandidate(candidate),
  }
}

function scoreCandidate(candidate: HybridCandidateInput) {
  // 不做 per-query min-max，避免单个低分结果被放大到 1。
  // 向量分数按 raw cosine clamp，FTS rank 用饱和映射，再按 source 权重累加。
  const contributions = new Map<HybridReason, number>()
  let score = 0
  for (const [sourceKey, rawScore] of Object.entries(candidate.source_scores)) {
    const contribution = weightedSourceScore(sourceKey, rawScore)
    const reason = reasonForSource(sourceKey, candidate.reasons)
    contributions.set(reason, Math.max(contributions.get(reason) ?? 0, contribution))
    score += contribution
  }
  if (uniqueReasons(candidate.reasons).length > 1) {
    score += MULTI_SIGNAL_BONUS
  }
  return {
    score: clamp(score, 0, 1),
    primaryReason: primaryReason(contributions),
  }
}

function strongestContribution(candidate: HybridCandidateInput) {
  return Math.max(
    0,
    ...Object.entries(candidate.source_scores).map(([sourceKey, rawScore]) =>
      weightedSourceScore(sourceKey, rawScore),
    ),
  )
}

function weightedSourceScore(sourceKey: string, rawScore: number) {
  return sourceWeight(sourceKey) * normalizeSourceScore(sourceKey, rawScore)
}

function normalizeSourceScore(sourceKey: string, rawScore: number) {
  if (sourceKey === 'text_search') {
    return rawScore <= 0 ? 0 : rawScore / (rawScore + 1)
  }
  return clamp(rawScore, 0, 1)
}

function sourceWeight(sourceKey: string) {
  return sourceKey === 'text_search' ? TEXT_SOURCE_WEIGHT : VECTOR_SOURCE_WEIGHT
}

function reasonForSource(sourceKey: string, reasons: HybridReason[]): HybridReason {
  if (sourceKey !== 'text_search') {
    return 'vector_match'
  }
  if (reasons.includes('transcript_match')) {
    return 'transcript_match'
  }
  if (reasons.includes('ocr_match')) {
    return 'ocr_match'
  }
  return 'transcript_match'
}

function primaryReason(contributions: Map<HybridReason, number>): HybridReason {
  // primary_reason 解释“哪个来源对 hybrid_score 贡献最大”，不是 raw score 最大的来源。
  // raw cosine 与 ts_rank_cd 尺度不同，只能比较加权归一化后的贡献。
  let selected: HybridReason = 'vector_match'
  let selectedContribution = -1
  for (const reason of REASON_TIE_BREAK_ORDER) {
    const contribution = contributions.get(reason) ?? -1
    if (contribution > selectedContribution) {
      selected = reason
      selectedContribution = contribution
    }
  }
  return selected
}

function mergeSourceScores(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const merged = { ...left }
  for (const [sourceKey, score] of Object.entries(right)) {
    merged[sourceKey] = Math.max(merged[sourceKey] ?? Number.NEGATIVE_INFINITY, score)
  }
  return merged
}

function uniqueReasons(reasons: HybridReason[]) {
  return REASON_TIE_BREAK_ORDER.filter((reason) => reasons.includes(reason)).sort(
    (left, right) => reasonSortOrder(left) - reasonSortOrder(right),
  )
}

function reasonSortOrder(reason: HybridReason) {
  if (reason === 'vector_match') {
    return 0
  }
  if (reason === 'transcript_match') {
    return 1
  }
  return 2
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function sortMergedAssetIds(candidate: MergeCandidate, assetOrder: Map<string, number>) {
  return {
    ...candidate,
    merged_asset_ids: [...candidate.merged_asset_ids].sort(
      (left, right) => (assetOrder.get(left) ?? 0) - (assetOrder.get(right) ?? 0),
    ),
  }
}

function compareRankedResults(left: HybridSearchResult, right: HybridSearchResult) {
  if (left.score !== right.score) {
    return right.score - left.score
  }
  if (left.file_id !== right.file_id) {
    return left.file_id.localeCompare(right.file_id)
  }
  return (
    (left.start_time_seconds ?? Number.MAX_SAFE_INTEGER) -
    (right.start_time_seconds ?? Number.MAX_SAFE_INTEGER)
  )
}

function confidenceForCandidate(candidate: HybridCandidateInput): HybridSearchResult['confidence'] {
  if (candidate.reasons.some((reason) => reason !== 'vector_match')) {
    return 'high'
  }
  return strongestRawVectorScore(candidate.source_scores) >= MIN_VECTOR_ONLY_RAW_SCORE ? 'high' : 'low'
}

function strongestRawVectorScore(sourceScores: Record<string, number>) {
  return Math.max(
    0,
    ...Object.entries(sourceScores)
      .filter(([sourceKey]) => sourceKey !== 'text_search')
      .map(([, score]) => score),
  )
}

function minNullable(left: number | null, right: number | null) {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.min(left, right)
}

function maxNullable(left: number | null, right: number | null) {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
