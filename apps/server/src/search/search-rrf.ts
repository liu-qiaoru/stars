import {
  rankByRrf,
  type RankingSignal,
  type RrfRankingResult,
} from '../ranking/rrf.js'
import type { HybridReason } from './search-hybrid.js'

/**
 * PostgreSQL 回表后的单通道候选。
 *
 * `source_score` 只在所属通道内用于生成连续名次，不能跨视觉、Caption 和全文检索直接比较。
 * `source_signal` 对应公共 RRF 的三个独立通道；`source_key` 保留真实 Collection 名，
 * 供响应展示原始分数和排错。
 */
export interface RrfSourceCandidate {
  asset_id: string
  file_id: string
  media_type: string
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  scene_id: string | null
  best_frame_time_seconds: number | null
  reason: HybridReason
  source_signal: RankingSignal
  source_key: string
  source_score: number
}

export interface RrfSearchResult {
  asset_id: string
  merged_asset_ids: string[]
  file_id: string
  media_type: string
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  scene_id: string | null
  best_frame_time_seconds: number | null
  score: number
  score_kind: 'rrf_score'
  primary_reason: HybridReason
  reasons: HybridReason[]
  source_scores: Record<string, number>
  ranking_diagnostics?: {
    source_ranks: Partial<Record<RankingSignal, number>>
    rrf_contributions: Partial<Record<RankingSignal, number>>
    primary_signal: RankingSignal
  }
}

type RankedSourceCandidate = RrfSourceCandidate & {
  candidateKey: string
  sourceRank: number
}

type MergedCandidate = {
  candidateKey: string
  bySignal: Partial<Record<RankingSignal, RankedSourceCandidate>>
}

const SIGNAL_ORDER: RankingSignal[] = ['visual', 'caption', 'lexical']
const SUPPORTED_SIGNALS = new Set<RankingSignal>(SIGNAL_ORDER)

/**
 * 把已完成 PostgreSQL 过滤的召回结果转换成正式生产 RRF 排序。
 *
 * 处理顺序不能交换：
 * 1. 每个通道按原始分数排序，并在过滤后重新生成连续的 `sourceRank=1..N`。
 * 2. 图片使用 Asset ID，正式视频场景使用 scene UUID 形成稳定语义身份。
 * 3. 同一身份跨通道合并后调用公共 `rankByRrf`，最后才执行 offset/limit 分页。
 *
 * 这样 Qdrant 中已经过期但被 PostgreSQL 拒绝的 Point 不会在名次中留下空洞，Caption
 * 和视觉也能通过同一个正式 scene_id 给同一场景贡献两次，而不是重复占据结果列表。
 */
export function buildRrfSearchResults(
  candidates: RrfSourceCandidate[],
  options: { limit: number; offset: number; includeDiagnostics: boolean },
): RrfSearchResult[] {
  const rankedBySignal = rankWithinSignals(candidates)
  const merged = mergeBySemanticIdentity(rankedBySignal)
  const detailsByKey = new Map(merged.map((candidate) => [candidate.candidateKey, candidate]))
  const ranked = rankByRrf(
    merged.map((candidate) => ({
      candidateKey: candidate.candidateKey,
      sourceRanks: Object.fromEntries(
        SIGNAL_ORDER.flatMap((signal) => {
          const source = candidate.bySignal[signal]
          return source ? [[signal, source.sourceRank] as const] : []
        }),
      ),
    })),
  )

  return ranked
    .slice(options.offset, options.offset + options.limit)
    .map((ranking) =>
      toSearchResult(detailsByKey.get(ranking.candidateKey), ranking, options.includeDiagnostics),
    )
}

function rankWithinSignals(candidates: RrfSourceCandidate[]): RankedSourceCandidate[] {
  for (const candidate of candidates) {
    if (!SUPPORTED_SIGNALS.has(candidate.source_signal)) {
      throw new Error(`unsupported RRF source signal: ${String(candidate.source_signal)}`)
    }
  }

  return SIGNAL_ORDER.flatMap((signal) => {
    const seenIdentities = new Set<string>()
    return candidates
      .filter((candidate) => candidate.source_signal === signal)
      .map((candidate) => ({ ...candidate, candidateKey: semanticCandidateKey(candidate) }))
      .sort(
        (left, right) =>
          right.source_score - left.source_score ||
          left.candidateKey.localeCompare(right.candidateKey) ||
          left.asset_id.localeCompare(right.asset_id),
      )
      .flatMap((candidate) => {
        // 同一通道偶尔可能因为残留 Point 返回同一场景多次。只保留分数最高且稳定排序
        // 最靠前的一条，避免同一场景占用两个 source rank。
        if (seenIdentities.has(candidate.candidateKey)) {
          return []
        }
        seenIdentities.add(candidate.candidateKey)
        return [candidate]
      })
      .map((candidate, index) => ({ ...candidate, sourceRank: index + 1 }))
  })
}

function mergeBySemanticIdentity(candidates: RankedSourceCandidate[]): MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>()
  for (const candidate of candidates) {
    const existing = merged.get(candidate.candidateKey) ?? {
      candidateKey: candidate.candidateKey,
      bySignal: {},
    }
    assertCompatibleCandidateFacts(existing, candidate)
    const current = existing.bySignal[candidate.source_signal]
    if (!current || candidate.sourceRank < current.sourceRank) {
      existing.bySignal[candidate.source_signal] = candidate
    }
    merged.set(candidate.candidateKey, existing)
  }
  return [...merged.values()]
}

function assertCompatibleCandidateFacts(
  merged: MergedCandidate,
  candidate: RankedSourceCandidate,
) {
  const existing = SIGNAL_ORDER.flatMap((signal) => {
    const value = merged.bySignal[signal]
    return value ? [value] : []
  })[0]
  if (!existing) {
    return
  }
  const sameFacts =
    existing.file_id === candidate.file_id &&
    existing.media_type === candidate.media_type &&
    existing.path === candidate.path &&
    existing.scene_id === candidate.scene_id &&
    existing.start_time_seconds === candidate.start_time_seconds &&
    existing.end_time_seconds === candidate.end_time_seconds
  if (!sameFacts) {
    // 同一个正式 scene UUID 必须指向同一文件和同一权威播放边界。这里 fail fast，
    // 不能选择某一侧或用 min/max 掩盖跨文件引用、过期场景边界等数据损坏。
    throw new Error(`conflicting facts for RRF candidate ${candidate.candidateKey}`)
  }
}

function semanticCandidateKey(candidate: RrfSourceCandidate) {
  if (candidate.media_type === 'video' && candidate.scene_id) {
    return `video:${candidate.scene_id}`
  }
  // 图片 Caption 在 PostgreSQL 回表时已规范为源图片 Asset ID，因此可与视觉通道稳定合并；
  // 视频 Caption 则通过正式 scene_id 与视觉场景合并。这里不使用 file_id 猜测身份。
  return `${candidate.media_type}:${candidate.asset_id}`
}

function toSearchResult(
  merged: MergedCandidate | undefined,
  ranking: RrfRankingResult,
  includeDiagnostics: boolean,
): RrfSearchResult {
  if (!merged) {
    throw new Error(`missing merged RRF candidate: ${ranking.candidateKey}`)
  }
  // 视觉证据优先作为代表项，因为它携带 SigLIP2 最佳命中帧时间；没有视觉时依次使用
  // Caption 和转录。这个选择只决定展示字段，不改变公共 RRF 分数。
  const representative = SIGNAL_ORDER.flatMap((signal) => {
    const candidate = merged.bySignal[signal]
    return candidate ? [candidate] : []
  })[0]
  if (!representative) {
    throw new Error(`RRF candidate has no representative: ${ranking.candidateKey}`)
  }
  const evidence = SIGNAL_ORDER.flatMap((signal) => {
    const candidate = merged.bySignal[signal]
    return candidate ? [candidate] : []
  })

  return {
    asset_id: representative.asset_id,
    merged_asset_ids: unique(evidence.map((candidate) => candidate.asset_id)),
    file_id: representative.file_id,
    media_type: representative.media_type,
    path: representative.path,
    start_time_seconds: representative.start_time_seconds,
    end_time_seconds: representative.end_time_seconds,
    scene_id: representative.scene_id,
    best_frame_time_seconds:
      merged.bySignal.visual?.best_frame_time_seconds ??
      representative.best_frame_time_seconds,
    score: ranking.score,
    score_kind: 'rrf_score',
    primary_reason: reasonForSignal(ranking.primarySignal),
    reasons: unique(evidence.map((candidate) => candidate.reason)),
    source_scores: Object.fromEntries(
      evidence.map((candidate) => [candidate.source_key, candidate.source_score]),
    ),
    ...(includeDiagnostics
      ? {
          ranking_diagnostics: {
            source_ranks: ranking.sourceRanks,
            rrf_contributions: ranking.contributions,
            primary_signal: ranking.primarySignal,
          },
        }
      : {}),
  }
}

function reasonForSignal(signal: RankingSignal): HybridReason {
  if (signal === 'visual') {
    return 'vector_match'
  }
  if (signal === 'caption') {
    return 'caption_match'
  }
  return 'transcript_match'
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
