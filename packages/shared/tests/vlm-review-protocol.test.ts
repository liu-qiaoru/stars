import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  parseVlmCandidateReviewOutput,
  vlmBlindCandidateReviewPacketSchema,
  vlmBlindConditionLabelInputSchema,
  vlmBlindLabelStageSchema,
  vlmCandidateReviewRequestSchema,
} from '../schemas/index.js'

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

describe('Phase F VLM review protocol', () => {
  test('accepts only the three explicit human-label stages and strict verdict input', () => {
    expect(vlmBlindLabelStageSchema.options).toEqual(['first', 'second', 'final'])
    expect(vlmBlindConditionLabelInputSchema.parse({ verdict: 'uncertain' })).toEqual({
      verdict: 'uncertain',
    })
    expect(() =>
      vlmBlindConditionLabelInputSchema.parse({ verdict: 'yes', invented: true }),
    ).toThrow()
  })
  test('accepts only the frozen qwen3.7-plus request contract', () => {
    expect(vlmCandidateReviewRequestSchema.parse(request)).toEqual(request)
    expect(() =>
      vlmCandidateReviewRequestSchema.parse({ ...request, model: 'qwen3-vl-rerank' }),
    ).toThrow()
    expect(
      vlmCandidateReviewRequestSchema.parse({ ...request, conditions: [] }).conditions,
    ).toEqual([])
  })

  test('rejects missing, duplicated, rewritten conditions and unknown evidence frames', () => {
    const valid = {
      candidate_key: 'video:scene-1',
      conditions: [
        {
          condition_id: 'must-1',
          verdict: 'yes' as const,
          evidence_frame_ids: ['11111111-1111-4111-8111-111111111111'],
        },
        {
          condition_id: 'exclude-1',
          verdict: 'no' as const,
          evidence_frame_ids: ['11111111-1111-4111-8111-111111111111'],
        },
      ],
    }
    expect(parseVlmCandidateReviewOutput(request, valid)).toEqual(valid)
    expect(() =>
      parseVlmCandidateReviewOutput(request, {
        ...valid,
        conditions: [valid.conditions[0]],
      }),
    ).toThrow(/conditions/i)
    expect(() =>
      parseVlmCandidateReviewOutput(request, {
        ...valid,
        conditions: [valid.conditions[0], valid.conditions[0]],
      }),
    ).toThrow(/conditions/i)
    expect(() =>
      parseVlmCandidateReviewOutput(request, {
        ...valid,
        conditions: [
          valid.conditions[0],
          {
            ...valid.conditions[1],
            evidence_frame_ids: ['22222222-2222-4222-8222-222222222222'],
          },
        ],
      }),
    ).toThrow(/evidence/i)
  })

  test('requires exactly 60 review proposals with 12 suggestions per group', () => {
    const groups = [
      'exact_match',
      'missing_must_have',
      'exclusion_hit',
      'partial_relevance',
      'insufficient_evidence',
    ] as const
    const proposals = groups.flatMap((group, groupIndex) =>
      Array.from({ length: 12 }, (_, itemIndex) => ({
        proposal_id: `phase-f-${groupIndex + 1}-${itemIndex + 1}`,
        source_evaluation_run_id: '11111111-1111-4111-8111-111111111111',
        source_candidate_id: `00000000-0000-4000-8000-${String(groupIndex * 12 + itemIndex + 1).padStart(12, '0')}`,
        query_text: '有人在海边走路',
        candidate_key: `video:${groupIndex}-${itemIndex}`,
        file_id: '22222222-2222-4222-8222-222222222222',
        scene_id: '33333333-3333-4333-8333-333333333333',
        start_time_seconds: itemIndex,
        end_time_seconds: itemIndex + 1,
        proposed_group: group,
        selection_basis: 'deterministic local proposal; human review required',
        conditions: [
          {
            condition_id: `condition-${groupIndex}-${itemIndex}`,
            kind: 'must_have',
            source_text: '画面中有人',
          },
        ],
      })),
    )
    const packet = {
      schema_version: 'phase-f-vlm-candidate-review-v1',
      proposals,
    }
    expect(vlmBlindCandidateReviewPacketSchema.parse(packet).proposals).toHaveLength(60)
    expect(() =>
      vlmBlindCandidateReviewPacketSchema.parse({ ...packet, proposals: proposals.slice(1) }),
    ).toThrow(/60/)
  })

  test('validates the generated local review packet and excludes private media fields', async () => {
    const raw = await readFile(
      resolve('../../apps/web/data/phase-f-vlm-candidate-review.json'),
      'utf8',
    )
    const parsed = vlmBlindCandidateReviewPacketSchema.parse(JSON.parse(raw))
    expect(parsed.proposals).toHaveLength(60)
    expect(raw).not.toMatch(
      /absolute_path|relative_path|artifact_path|file_name|caption|transcript|image_base64/i,
    )
  })
})
