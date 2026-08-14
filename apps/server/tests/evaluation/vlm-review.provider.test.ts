import { describe, expect, test } from 'vitest'
import {
  deriveVlmReviewStatus,
  FakeVlmReviewProvider,
  runVlmCandidateReview,
} from '../../src/evaluation/vlm-review.provider.js'

const request = {
  protocol_version: 'vlm-review-v1' as const,
  model: 'qwen3.7-plus' as const,
  original_query: '有人在海边走路',
  candidate_key: 'video:scene-1',
  conditions: [
    { condition_id: 'must-1', kind: 'must_have' as const, source_text: '画面中有人' },
    { condition_id: 'exclude-1', kind: 'exclusion' as const, source_text: '人物没有走路' },
  ],
  evidence_frames: [
    {
      frame_id: '11111111-1111-4111-8111-111111111111',
      image_base64: 'ZmFrZQ==',
    },
  ],
}

describe('Phase F fake VLM Provider', () => {
  test('records the request and returns only strictly validated output', async () => {
    const fake = new FakeVlmReviewProvider(() => ({
      candidate_key: 'video:scene-1',
      conditions: [
        {
          condition_id: 'must-1',
          verdict: 'yes',
          evidence_frame_ids: ['11111111-1111-4111-8111-111111111111'],
        },
        {
          condition_id: 'exclude-1',
          verdict: 'no',
          evidence_frame_ids: ['11111111-1111-4111-8111-111111111111'],
        },
      ],
    }))

    const result = await runVlmCandidateReview(fake, request)

    expect(result.status).toBe('passed')
    expect(fake.requests).toEqual([request])
    expect(fake.externalCallCount).toBe(0)
  })

  test('returns review_failed when a fake response invents a condition', async () => {
    const fake = new FakeVlmReviewProvider(() => ({
      candidate_key: 'video:scene-1',
      conditions: [{ condition_id: 'invented', verdict: 'yes', evidence_frame_ids: [] }],
    }))
    await expect(runVlmCandidateReview(fake, request)).resolves.toMatchObject({
      status: 'review_failed',
      output: null,
      error: { code: 'VLM_REVIEW_OUTPUT_INVALID' },
    })
  })

  test('returns review_not_applicable without calling Provider when decisive conditions are empty', async () => {
    const fake = new FakeVlmReviewProvider(() => {
      throw new Error('must not be called')
    })
    await expect(
      runVlmCandidateReview(fake, {
        ...request,
        conditions: [{ condition_id: 'optional-1', kind: 'optional', source_text: '有海鸥' }],
      }),
    ).resolves.toMatchObject({ status: 'review_not_applicable', output: null })
    expect(fake.requests).toEqual([])
  })

  test('derives the final state on the Server and ignores optional conditions', () => {
    expect(
      deriveVlmReviewStatus([
        { kind: 'must_have', verdict: 'no' },
        { kind: 'exclusion', verdict: 'no' },
      ]),
    ).toBe('rejected')
    expect(
      deriveVlmReviewStatus([
        { kind: 'must_have', verdict: 'yes' },
        { kind: 'exclusion', verdict: 'yes' },
      ]),
    ).toBe('rejected')
    expect(
      deriveVlmReviewStatus([
        { kind: 'must_have', verdict: 'uncertain' },
        { kind: 'optional', verdict: 'yes' },
      ]),
    ).toBe('insufficient_evidence')
    expect(deriveVlmReviewStatus([{ kind: 'optional', verdict: 'no' }])).toBe(
      'review_not_applicable',
    )
  })
})
