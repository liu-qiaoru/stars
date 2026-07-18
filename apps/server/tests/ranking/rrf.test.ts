import { describe, expect, test } from 'vitest'
import { rankByRrf, type RankingCandidate } from '../../src/ranking/rrf.js'

describe('rankByRrf', () => {
  test('uses source-local ranks for unweighted RRF without treating raw scores as comparable', () => {
    const candidates: RankingCandidate[] = [
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
})
