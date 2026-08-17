import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  evaluationVlmBlindCases,
  evaluationVlmBlindDatasets,
  evaluationVlmBlindLabelingSessions,
} from '../../src/database/schema.js'
import { DATABASE } from '../../src/database/database.module.js'
import { SETTINGS } from '../../src/config/settings.js'
import { VlmBlindCapabilityService } from '../../src/evaluation/vlm-blind-capability.service.js'
import { QwenVlmReviewProviderError } from '../../src/evaluation/qwen-vlm-review.provider.js'
import { VLM_REAL_REVIEW_PROVIDER } from '../../src/evaluation/qwen-vlm-review.provider.js'
import { VlmBlindLabelingService } from '../../src/evaluation/vlm-blind-labeling.service.js'
import type { VlmReviewProvider } from '../../src/evaluation/vlm-review.provider.js'
import { createTestDatabase } from '../database/test-db.js'

describe('Phase F real VLM capability orchestration', () => {
  let context: Awaited<ReturnType<typeof createTestDatabase>>
  let fixture: Awaited<ReturnType<typeof seedCapabilityFixture>>

  beforeEach(async () => {
    context = await createTestDatabase()
    fixture = await seedCapabilityFixture(context.db)
  })

  afterEach(async () => {
    await context.close()
  })

  test('preflight constructs all 84 real request bodies without calling Provider or writing a run', async () => {
    const provider = successfulExternalFake()
    const service = createService(context.db, fixture, provider)

    const preview = await service.preflight(fixture.datasetId)

    expect(preview).toMatchObject({
      candidate_count: 60,
      normal_call_count: 60,
      stability_case_count: 12,
      stability_extra_call_count: 24,
      maximum_call_count: 84,
      total_image_count: 84,
      external_call_count: 0,
      visual_authorization_exists: false,
    })
    expect(preview.total_request_bytes).toBeGreaterThan(84)
    expect(provider.review).not.toHaveBeenCalled()
    await expect(service.listRuns(fixture.datasetId)).resolves.toEqual({ items: [] })
  })

  test('Nest injects the labeling service explicitly in tsx runtime', async () => {
    const provider = successfulExternalFake()
    const labeling = {
      prepareCapabilityInput: vi.fn().mockResolvedValue(fixture.input),
      prepareCapabilityInputForRun: vi.fn().mockResolvedValue(fixture.input),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        VlmBlindCapabilityService,
        { provide: DATABASE, useValue: context.db },
        {
          provide: SETTINGS,
          useValue: {
            allowExternalLlm: true,
            rightCodeBaseUrl: 'https://provider.example/v1',
            rightCodeApiKey: 'secret',
            vlmReviewProvider: 'rightapi',
            vlmReviewMaxCalls: 84,
            vlmReviewMaxCostCny: 5,
          },
        },
        { provide: VLM_REAL_REVIEW_PROVIDER, useValue: provider },
        { provide: VlmBlindLabelingService, useValue: labeling },
      ],
    }).compile()
    try {
      await expect(
        moduleRef.get(VlmBlindCapabilityService).preflight(fixture.datasetId),
      ).resolves.toMatchObject({ maximum_call_count: 84, external_call_count: 0 })
      expect(labeling.prepareCapabilityInput).toHaveBeenCalledWith(fixture.datasetId)
    } finally {
      await moduleRef.close()
    }
  })

  test('reads historical reports from PostgreSQL without rebuilding evidence requests', async () => {
    const prepareCapabilityInput = vi.fn(() => {
      throw new Error('history must not read evidence')
    })
    const service = new VlmBlindCapabilityService(
      context.db,
      {} as never,
      successfulExternalFake(),
      { prepareCapabilityInput } as never,
    )

    await expect(service.listRuns(fixture.datasetId)).resolves.toEqual({ items: [] })
    expect(prepareCapabilityInput).not.toHaveBeenCalled()
  })

  test('requires a matching independent visual authorization, then persists 84 fake external attempts', async () => {
    const provider = successfulExternalFake()
    const service = createService(context.db, fixture, provider)
    await expect(service.start(fixture.datasetId)).rejects.toThrow(/视觉授权/)
    const preview = await service.preflight(fixture.datasetId)
    const authorization = await service.authorize(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: preview.preflight_fingerprint,
      max_calls: 84,
      max_cost_cny: 5,
      expires_in_minutes: 60,
    })
    expect(authorization).toMatchObject({ maxCalls: 84, status: 'active' })

    const run = await service.start(fixture.datasetId)
    const result = await service.executePending(run.id)

    expect(provider.review).toHaveBeenCalledTimes(84)
    expect(result).toMatchObject({
      status: 'succeeded',
      external_call_count: 84,
      succeeded_count: 84,
      failed_count: 0,
      unknown_count: 0,
    })
    expect(result.attempts).toHaveLength(84)
    expect(JSON.stringify(result)).not.toContain('ZmFrZQ==')
  })

  test('stops immediately on outcome_unknown and never auto-replays the dispatched request', async () => {
    const review = vi
      .fn()
      .mockRejectedValue(
        new QwenVlmReviewProviderError('VLM_REVIEW_OUTCOME_UNKNOWN', 'sanitized', true),
      )
    const provider = externalProvider(review)
    const service = createService(context.db, fixture, provider)
    const preview = await service.preflight(fixture.datasetId)
    await service.authorize(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: preview.preflight_fingerprint,
      max_calls: 84,
      max_cost_cny: 5,
    })
    const run = await service.start(fixture.datasetId)

    const result = await service.executePending(run.id)

    expect(review).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: 'outcome_unknown',
      external_call_count: 1,
      unknown_count: 1,
    })
    expect(result.attempts.filter((item) => item.status === 'pending')).toHaveLength(83)
  })

  test('only explicit retry creates a new step attempt and retries that unknown slot first', async () => {
    const review = vi
      .fn()
      .mockRejectedValueOnce(
        new QwenVlmReviewProviderError('VLM_REVIEW_OUTCOME_UNKNOWN', 'sanitized', true),
      )
      .mockImplementation(async (request) => successfulProviderResult(request))
    const service = createService(context.db, fixture, externalProvider(review))
    const preview = await service.preflight(fixture.datasetId)
    await service.authorize(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: preview.preflight_fingerprint,
      max_calls: 84,
      max_cost_cny: 5,
    })
    const run = await service.start(fixture.datasetId)
    await service.executePending(run.id)

    const retried = await service.retryUnknown(run.id, {
      confirmed: true,
      reason: '用户明确确认重试未知结果',
    })
    expect(retried.attempts.filter((item) => item.attempt_number === 2)).toHaveLength(1)
    const completed = await service.executePending(run.id)

    expect(review.mock.calls[1]![0].candidate_key).toBe(review.mock.calls[0]![0].candidate_key)
    expect(completed.external_call_count).toBe(84)
    expect(completed.attempts.filter((item) => item.status === 'superseded_unknown')).toHaveLength(
      1,
    )
  })
})

function createService(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  fixture: Awaited<ReturnType<typeof seedCapabilityFixture>>,
  provider: VlmReviewProvider,
) {
  const labeling = {
    prepareCapabilityInput: vi.fn().mockResolvedValue(fixture.input),
    prepareCapabilityInputForRun: vi.fn().mockResolvedValue(fixture.input),
  }
  return new VlmBlindCapabilityService(
    db,
    {
      allowExternalLlm: true,
      rightCodeBaseUrl: 'https://provider.example/v1',
      rightCodeApiKey: 'secret-not-returned',
      vlmReviewProvider: 'rightapi',
      vlmReviewMaxCalls: 84,
      vlmReviewMaxCostCny: 5,
      vlmReviewTimeoutMs: 120_000,
    } as never,
    provider,
    labeling as never,
  )
}

function successfulExternalFake() {
  return externalProvider(vi.fn(async (request) => successfulProviderResult(request)))
}

function successfulProviderResult(request: {
  candidate_key: string
  conditions: Array<{ condition_id: string }>
  evidence_frames: Array<{ frame_id: string }>
}) {
  return {
    output: {
      candidate_key: request.candidate_key,
      conditions: request.conditions.map((condition) => ({
        condition_id: condition.condition_id,
        verdict: 'yes',
        evidence_frame_ids: [request.evidence_frames[0]!.frame_id],
      })),
    },
    audit: {
      provider_request_id: randomUUID(),
      response_model: 'qwen3.7-plus',
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      billed_cost_cny: 0.01,
      response_fingerprint: 'f'.repeat(64),
    },
  }
}

function externalProvider(review: VlmReviewProvider['review']): VlmReviewProvider {
  return {
    provider: 'rightapi',
    available: true,
    external: true,
    review: vi.fn(review),
  }
}

async function seedCapabilityFixture(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const datasetId = randomUUID()
  const sessionId = randomUUID()
  await db.insert(evaluationVlmBlindDatasets).values({
    id: datasetId,
    name: 'real capability fixture',
    schemaVersion: 'phase-f-vlm-candidate-review-v1',
    status: 'frozen',
    targetCaseCount: 60,
    proposalFingerprint: 'a'.repeat(64),
    frozenFingerprint: 'b'.repeat(64),
    frozenAt: new Date(),
  })
  await db.insert(evaluationVlmBlindLabelingSessions).values({
    id: sessionId,
    datasetId,
    status: 'labels_frozen',
    labelsFingerprint: 'c'.repeat(64),
    labelsFrozenAt: new Date(),
  })
  const groups = [
    'exact_match',
    'missing_must_have',
    'exclusion_hit',
    'partial_relevance',
    'insufficient_evidence',
  ] as const
  const cases = Array.from({ length: 60 }, (_, index) => ({
    id: randomUUID(),
    datasetId,
    proposalId: `case-${index + 1}`,
    sourceEvaluationRunId: randomUUID(),
    sourceCandidateId: randomUUID(),
    queryText: `冻结查询 ${index + 1}`,
    candidateKey: `video:${randomUUID()}`,
    fileId: randomUUID(),
    sceneId: randomUUID(),
    startTimeSeconds: '0',
    endTimeSeconds: '5',
    proposedGroup: groups[Math.floor(index / 12)]!,
    reviewedGroup: groups[Math.floor(index / 12)]!,
    reviewStatus: 'accepted',
    selectionBasis: 'test fixture',
  }))
  await db.insert(evaluationVlmBlindCases).values(cases)
  const items = cases.map((candidateCase, index) => {
    const conditionId = `condition-${index + 1}`
    return {
      case: candidateCase,
      group: candidateCase.reviewedGroup,
      request: {
        protocol_version: 'vlm-review-v1' as const,
        model: 'qwen3.7-plus' as const,
        original_query: candidateCase.queryText,
        candidate_key: candidateCase.candidateKey,
        conditions: [
          { condition_id: conditionId, kind: 'must_have' as const, source_text: '有人' },
        ],
        evidence_frames: [{ frame_id: randomUUID(), image_base64: 'ZmFrZQ==' }],
      },
      human_status: 'passed' as const,
      human_conditions: [{ condition_id: conditionId, verdict: 'yes' as const }],
    }
  })
  return {
    datasetId,
    sessionId,
    input: {
      dataset: { id: datasetId, frozenFingerprint: 'b'.repeat(64) },
      session: { id: sessionId, labelsFingerprint: 'c'.repeat(64) },
      evidence_fingerprint: 'd'.repeat(64),
      items,
    },
  }
}
