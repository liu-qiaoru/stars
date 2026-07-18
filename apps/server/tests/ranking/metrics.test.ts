import { describe, expect, test } from 'vitest'
import { calculateRankingMetrics } from '../../src/ranking/metrics.js'

describe('calculateRankingMetrics', () => {
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
