export type EvaluationSignal = 'visual' | 'caption' | 'lexical'

export interface EvaluationRankingCandidate {
  candidateKey: string
  sourceRanks: Partial<Record<EvaluationSignal, number>>
}

export interface RrfRankingResult extends EvaluationRankingCandidate {
  rank: number
  score: number
  contributions: Partial<Record<EvaluationSignal, number>>
  primarySignal: EvaluationSignal
}

export interface EvaluationMetrics {
  precisionAt5: number | null
  precisionAt10: number | null
  ndcgAt10: number | null
  ndcgAt20: number | null
  hitAt5: number | null
  hitAt10: number | null
  hitAt20: number | null
  reciprocalRank: number | null
  unjudgeableCount: number
}

const RRF_K = 60
const SIGNAL_ORDER: EvaluationSignal[] = ['visual', 'caption', 'lexical']

export function rankByRrf(candidates: EvaluationRankingCandidate[]): RrfRankingResult[] {
  return candidates
    .map((candidate) => {
      const contributions: Partial<Record<EvaluationSignal, number>> = {}
      for (const signal of SIGNAL_ORDER) {
        const rank = candidate.sourceRanks[signal]
        if (rank !== undefined) {
          if (!Number.isInteger(rank) || rank < 1) {
            throw new Error(`invalid source rank signal=${signal} rank=${rank}`)
          }
          contributions[signal] = 1 / (RRF_K + rank)
        }
      }
      const entries = Object.entries(contributions) as [EvaluationSignal, number][]
      if (!entries.length) {
        throw new Error(`candidate has no source ranks candidate_key=${candidate.candidateKey}`)
      }
      const primarySignal = entries.reduce((selected, current) =>
        current[1] > selected[1] ? current : selected,
      )[0]
      return {
        ...candidate,
        rank: 0,
        score: entries.reduce((sum, [, contribution]) => sum + contribution, 0),
        contributions,
        primarySignal,
      }
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.candidateKey.localeCompare(right.candidateKey),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

export function calculateRankingMetrics(
  rankedCandidateKeys: string[],
  judgments: Map<string, 0 | 1 | 2 | null>,
  options: { knownTargetKey: string | null },
): EvaluationMetrics {
  const unjudgeableCount = [...judgments.values()].filter((value) => value === null).length
  if (options.knownTargetKey !== null) {
    const targetIndex = rankedCandidateKeys.indexOf(options.knownTargetKey)
    const targetRank = targetIndex < 0 ? null : targetIndex + 1
    return {
      precisionAt5: null,
      precisionAt10: null,
      ndcgAt10: null,
      ndcgAt20: null,
      hitAt5: targetRank !== null && targetRank <= 5 ? 1 : 0,
      hitAt10: targetRank !== null && targetRank <= 10 ? 1 : 0,
      hitAt20: targetRank !== null && targetRank <= 20 ? 1 : 0,
      reciprocalRank: targetRank === null ? 0 : 1 / targetRank,
      unjudgeableCount,
    }
  }

  const judged = rankedCandidateKeys.flatMap((key) => {
    const value = judgments.get(key)
    return value === undefined || value === null ? [] : [value]
  })
  return {
    precisionAt5: precisionAt(judged, 5),
    precisionAt10: precisionAt(judged, 10),
    ndcgAt10: ndcgAt(judged, 10),
    ndcgAt20: ndcgAt(judged, 20),
    hitAt5: null,
    hitAt10: null,
    hitAt20: null,
    reciprocalRank: null,
    unjudgeableCount,
  }
}

function precisionAt(relevance: number[], k: number) {
  const visible = relevance.slice(0, k)
  if (!visible.length) {
    return null
  }
  return visible.filter((value) => value > 0).length / visible.length
}

function ndcgAt(relevance: number[], k: number) {
  const visible = relevance.slice(0, k)
  if (!visible.length) {
    return null
  }
  const dcg = discountedGain(visible)
  const ideal = discountedGain([...visible].sort((left, right) => right - left))
  return ideal === 0 ? 0 : dcg / ideal
}

function discountedGain(relevance: number[]) {
  return relevance.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0)
}
