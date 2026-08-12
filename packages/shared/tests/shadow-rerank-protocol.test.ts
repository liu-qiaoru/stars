import { describe, expect, test } from 'vitest'
import { shadowRerankRequestSchema, shadowRerankResponseSchema } from '../schemas/index.js'

const documents = Array.from({ length: 20 }, (_, index) => ({
  index,
  candidate_key: `video:scene-${index}`,
  evidence_sha256: 'a'.repeat(64),
  image_base64: 'cG5n',
}))

describe('Phase E shadow rerank protocol', () => {
  test('accepts exactly one complete Top-20 request and a unique Top-10 response', () => {
    expect(
      shadowRerankRequestSchema.parse({
        model: 'qwen3-vl-rerank',
        query: '红色汽车经过桥下',
        top_n: 10,
        documents,
      }).documents,
    ).toHaveLength(20)
    expect(
      shadowRerankResponseSchema.parse({
        results: Array.from({ length: 10 }, (_, index) => ({
          index: 19 - index,
          relevance_score: 1 - index / 10,
        })),
      }).results,
    ).toHaveLength(10)
  })

  test.each([
    ['illegal index', [{ index: 20, relevance_score: 0.5 }]],
    [
      'duplicate index',
      [
        { index: 0, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.4 },
      ],
    ],
    ['non-finite score', [{ index: 0, relevance_score: Number.NaN }]],
  ])('rejects %s', (_label, prefix) => {
    const results = [
      ...prefix,
      ...Array.from({ length: Math.max(0, 10 - prefix.length) }, (_, offset) => ({
        index: offset + 1,
        relevance_score: 0.3 - offset / 100,
      })),
    ]
    expect(shadowRerankResponseSchema.safeParse({ results }).success).toBe(false)
  })

  test('rejects an incomplete Top-N response', () => {
    expect(
      shadowRerankResponseSchema.safeParse({
        results: [{ index: 0, relevance_score: 0.5 }],
      }).success,
    ).toBe(false)
  })

  test('rejects a Top-10 whose array order contradicts relevance scores', () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      index,
      relevance_score: 1 - index / 10,
    }))
    results[1]!.relevance_score = 2

    expect(() => shadowRerankResponseSchema.parse({ results })).toThrow(/non-increasing/)
  })

  test('rejects requests with duplicated or missing candidate indices', () => {
    const invalid = documents.map((document) => ({ ...document }))
    invalid[19]!.index = 18
    expect(
      shadowRerankRequestSchema.safeParse({
        model: 'qwen3-vl-rerank',
        query: '红色汽车经过桥下',
        top_n: 10,
        documents: invalid,
      }).success,
    ).toBe(false)
  })
})
