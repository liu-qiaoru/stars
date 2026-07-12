import { describe, expect, test } from 'vitest'
import {
  calculateRankingMetrics,
  rankByRrf,
  type EvaluationRankingCandidate,
} from '../../src/evaluation/evaluation-metrics.js'

describe('evaluation metrics', () => {
  test('uses source-local ranks for unweighted RRF without treating raw scores as comparable', () => {
    const candidates: EvaluationRankingCandidate[] = [
      {
        candidateKey: 'visual-only',
        sourceRanks: { visual: 1 },
      },
      {
        candidateKey: 'multi-source',
        sourceRanks: { visual: 20, caption: 20 },
      },
    ]

    const ranked = rankByRrf(candidates)

    expect(ranked.map((item) => item.candidateKey)).toEqual(['multi-source', 'visual-only'])
    expect(ranked[0]?.score).toBeCloseTo(1 / 80 + 1 / 80, 8)
    expect(ranked[1]?.score).toBeCloseTo(1 / 61, 8)
    expect(ranked[0]?.contributions).toEqual({ visual: 1 / 80, caption: 1 / 80 })
  })

  test('keeps one strongest rank per independent signal and uses stable tie-breaking', () => {
    const ranked = rankByRrf([
      { candidateKey: 'b', sourceRanks: { visual: 1 } },
      { candidateKey: 'a', sourceRanks: { visual: 1 } },
    ])

    expect(ranked.map((item) => item.candidateKey)).toEqual(['a', 'b'])
    expect(ranked.every((item) => item.score < 0.02)).toBe(true)
  })

  test('calculates graded discovery metrics and excludes unjudgeable candidates', () => {
    const metrics = calculateRankingMetrics(
      ['high', 'unknown', 'partial', 'irrelevant'],
      new Map([
        ['high', 2],
        ['unknown', null],
        ['partial', 1],
        ['irrelevant', 0],
      ]),
      { knownTargetKey: null },
    )

    expect(metrics.precisionAt5).toBeCloseTo(2 / 3, 8)
    expect(metrics.unjudgeableCount).toBe(1)
    expect(metrics.ndcgAt10).toBeCloseTo(1, 8)
  })

  test('calculates known-target hit and reciprocal rank', () => {
    const metrics = calculateRankingMetrics(['first', 'target', 'third'], new Map(), {
      knownTargetKey: 'target',
    })

    expect(metrics.hitAt5).toBe(1)
    expect(metrics.hitAt10).toBe(1)
    expect(metrics.hitAt20).toBe(1)
    expect(metrics.reciprocalRank).toBe(0.5)
  })
})
