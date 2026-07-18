export type HybridReason = 'vector_match' | 'transcript_match' | 'caption_match'

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
  merged_asset_ids?: string[]
  best_frame_time_seconds?: number | null
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

const VECTOR_SOURCE_WEIGHT = 0.55
const TEXT_SOURCE_WEIGHT = 0.45
const MULTI_SIGNAL_BONUS = 0.08
const MIN_HYBRID_SOURCE_SCORE = 0.1
const REASON_TIE_BREAK_ORDER: HybridReason[] = [
  'transcript_match',
  'caption_match',
  'vector_match',
]

// Hybrid reranker 是纯函数，方便用单测固定合并和打分语义。
// 输入候选已经通过 PostgreSQL 补齐事实字段；这里不再访问数据库或 Qdrant。
export function buildHybridResults(
  candidates: HybridCandidateInput[],
  options: { limit: number; offset: number },
): HybridSearchResult[] {
  // 时间完整性必须在弱分过滤和同 asset 合并之前检查；否则异常区间可能被直接丢弃，
  // 或先经 min/max 变成看似合法的范围，导致真正的数据损坏无法追踪。
  for (const candidate of candidates) {
    assertValidTimedWindow(candidate)
  }
  const filteredCandidates = candidates.flatMap((candidate) => {
    const filtered = filterWeakSources(candidate)
    return filtered ? [filtered] : []
  })
  const assetOrder = new Map(
    filteredCandidates.map((candidate, index) => [candidate.asset_id, index]),
  )
  const mergedByAsset = mergeSameAsset(filteredCandidates)
  const mergedWindows = mergeAdjacentVideoWindows(mergedByAsset, assetOrder)

  return mergedWindows
    .map((candidate) => rankCandidate(sortMergedAssetIds(candidate, assetOrder)))
    .sort((left, right) => compareRankedResults(left, right))
    .slice(options.offset, options.offset + options.limit)
}

function filterWeakSources(candidate: HybridCandidateInput): HybridCandidateInput | undefined {
  const sourceScores = Object.fromEntries(
    Object.entries(candidate.source_scores).filter(
      ([sourceKey, rawScore]) =>
        sourceKey === 'text_search' ||
        normalizeSourceScore(sourceKey, rawScore) >= MIN_HYBRID_SOURCE_SCORE,
    ),
  )
  const reasons = uniqueReasons(
    Object.keys(sourceScores).map((sourceKey) => reasonForSource(sourceKey, candidate.reasons)),
  )
  if (!Object.keys(sourceScores).length || !reasons.length) {
    return undefined
  }
  return {
    ...candidate,
    reasons,
    source_scores: sourceScores,
  }
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
  // scene_id 是视频场景的稳定边界。不同场景即使首尾相接也必须保留为两条结果，
  // 否则一个视觉命中会把后续 Caption 串成覆盖数分钟的链式长窗口。
  if (left.scene_id !== null && right.scene_id !== null) {
    return left.scene_id === right.scene_id
  }
  if (isCaptionOnly(left) && isCaptionOnly(right)) {
    return false
  }
  // 转录等历史资产可能没有 scene_id。它们只能在时间真实重叠时参与融合，
  // 不再使用 5 秒空隙兜底，以免跨过真实镜头边界。
  if (hasPositiveTemporalOverlap(left, right)) {
    return true
  }
  return false
}

function isCaptionOnly(candidate: MergeCandidate) {
  return (
    candidate.reasons.length === 1 &&
    candidate.reasons[0] === 'caption_match' &&
    Object.keys(candidate.source_scores).length === 1 &&
    candidate.source_scores.caption_text_vectors !== undefined
  )
}

function toMergeCandidate(candidate: HybridCandidateInput): MergeCandidate {
  return {
    ...candidate,
    reasons: uniqueReasons(candidate.reasons),
    source_scores: { ...candidate.source_scores },
    merged_asset_ids: candidate.merged_asset_ids?.length
      ? [...candidate.merged_asset_ids]
      : [candidate.asset_id],
    representative_contribution: strongestContribution(candidate),
  }
}

function combineCandidates(left: MergeCandidate, right: MergeCandidate): MergeCandidate {
  // source_scores 对同一 source 取 max，表示保留最强信号；sum/average 会被窗口数量扭曲。
  const rightIsStronger = right.representative_contribution > left.representative_contribution
  assertCompatibleSceneBounds(left, right)
  const sceneOwner = sceneBoundOwner(left, right)
  return {
    asset_id: rightIsStronger ? right.asset_id : left.asset_id,
    file_id: left.file_id,
    media_type: left.media_type,
    path: left.path,
    // 当只有一侧拥有稳定场景边界时，以该场景作为最终播放窗口；转录 chunk 只是证据，
    // 不能把场景结果扩展到相邻镜头。两侧都无场景时才合并实际时间范围。
    start_time_seconds: sceneOwner
      ? sceneOwner.start_time_seconds
      : minNullable(left.start_time_seconds, right.start_time_seconds),
    end_time_seconds: sceneOwner
      ? sceneOwner.end_time_seconds
      : maxNullable(left.end_time_seconds, right.end_time_seconds),
    scene_id: sceneOwner?.scene_id ?? (left.scene_id === right.scene_id ? left.scene_id : null),
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
  // 向量分数按 raw cosine clamp，FTS rank 用饱和映射；融合结果以最强单通道为下限，
  // 保证增加一条弱证据不会反向降低原本可靠的 Caption 或视觉结果。
  const contributions = new Map<HybridReason, number>()
  let score = 0
  let totalWeight = 0
  let strongestStandaloneScore = 0
  for (const [sourceKey, rawScore] of Object.entries(candidate.source_scores)) {
    const weight = sourceWeight(sourceKey)
    const normalizedScore = normalizeSourceScore(sourceKey, rawScore)
    const contribution = weightedSourceScore(sourceKey, rawScore)
    const reason = reasonForSource(sourceKey, candidate.reasons)
    contributions.set(reason, Math.max(contributions.get(reason) ?? 0, contribution))
    score += contribution
    totalWeight += weight
    strongestStandaloneScore = Math.max(strongestStandaloneScore, normalizedScore)
  }
  if (totalWeight > 0) {
    score = score / totalWeight
  }
  if (uniqueReasons(candidate.reasons).length > 1) {
    score += MULTI_SIGNAL_BONUS
  }
  return {
    score: clamp(Math.max(score, strongestStandaloneScore), 0, 1),
    primaryReason: primaryReason(contributions),
  }
}

/**
 * 返回合并后必须保留边界的场景候选。
 *
 * 同一场景的两个候选通常拥有相同边界，因此无需指定 owner；只有一侧有 scene_id 时，
 * 另一侧是转录等时间证据，不能让它改变 PostgreSQL 中保存的权威场景范围。
 */
function sceneBoundOwner(left: MergeCandidate, right: MergeCandidate) {
  if (left.scene_id !== null && left.scene_id === right.scene_id) {
    // OCR 帧等证据可以是零时长时间点；若另一侧拥有完整场景窗口，应由完整窗口
    // 提供播放边界。两侧都是时间点时保留排序靠前的一侧，但不会扩大成伪窗口。
    if (!hasPositiveDuration(left) && hasPositiveDuration(right)) {
      return right
    }
    return left
  }
  if (left.scene_id !== null && right.scene_id === null) {
    return left
  }
  if (left.scene_id === null && right.scene_id !== null) {
    return right
  }
  return undefined
}

/**
 * 同一个 scene_id 的边界来自 PostgreSQL 中同一条权威场景记录，理论上必须完全一致。
 * 若 Caption 与视觉候选携带不同范围，继续取 min/max 会掩盖索引完整性问题并跨场景播放，
 * 因此在最终排序前明确失败，让调用方能从 Server 错误日志定位并重新索引异常数据。
 */
function assertCompatibleSceneBounds(left: MergeCandidate, right: MergeCandidate) {
  if (left.scene_id === null || left.scene_id !== right.scene_id) {
    return
  }
  // 零时长候选代表场景内的一个证据时间点，不是另一份“场景边界”，因此不与
  // Caption/视觉场景窗口做边界一致性比较。
  if (!hasPositiveDuration(left) || !hasPositiveDuration(right)) {
    return
  }
  if (
    left.start_time_seconds === right.start_time_seconds &&
    left.end_time_seconds === right.end_time_seconds
  ) {
    return
  }
  throw new Error(
    `Conflicting boundaries for file_id=${left.file_id} scene_id=${left.scene_id}: ` +
      `left=${left.start_time_seconds}-${left.end_time_seconds} ` +
      `right=${right.start_time_seconds}-${right.end_time_seconds}`,
  )
}

/** 负时长区间表示索引数据损坏；零时长则是合法的帧时间点。 */
function assertValidTimedWindow(candidate: HybridCandidateInput) {
  if (candidate.media_type !== 'video') {
    return
  }
  if (
    candidate.start_time_seconds !== null &&
    candidate.end_time_seconds !== null &&
    candidate.end_time_seconds < candidate.start_time_seconds
  ) {
    throw new Error(
      `Invalid video time range for asset_id=${candidate.asset_id}: ` +
        `${candidate.start_time_seconds}-${candidate.end_time_seconds}`,
    )
  }
}

function hasPositiveDuration(candidate: MergeCandidate) {
  return (
    candidate.start_time_seconds !== null &&
    candidate.end_time_seconds !== null &&
    candidate.end_time_seconds > candidate.start_time_seconds
  )
}

function hasPositiveTemporalOverlap(left: MergeCandidate, right: MergeCandidate) {
  if (
    left.start_time_seconds === null ||
    left.end_time_seconds === null ||
    right.start_time_seconds === null ||
    right.end_time_seconds === null
  ) {
    return false
  }
  return (
    Math.max(left.start_time_seconds, right.start_time_seconds) <
    Math.min(left.end_time_seconds, right.end_time_seconds)
  )
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
  if (sourceKey === 'caption_text_vectors') {
    return 'caption_match'
  }
  if (sourceKey !== 'text_search') {
    return 'vector_match'
  }
  if (reasons.includes('transcript_match')) {
    return 'transcript_match'
  }
  if (reasons.includes('caption_match')) {
    return 'caption_match'
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

function confidenceForCandidate(_candidate: HybridCandidateInput): HybridSearchResult['confidence'] {
  return 'high'
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
