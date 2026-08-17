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

  test('selects one deterministic candidate per frozen group and keeps smoke authorization isolated', async () => {
    const provider = successfulExternalFake()
    const service = createService(context.db, fixture, provider)

    const preview = await service.smokePreflight(fixture.datasetId)

    expect(preview).toMatchObject({
      execution_mode: 'smoke',
      protocol_version: 'vlm-review-smoke-v1',
      candidate_count: 5,
      normal_call_count: 5,
      stability_extra_call_count: 0,
      maximum_call_count: 5,
      total_image_count: 5,
      budget: { max_calls: 5, max_cost_cny: 0.5 },
      external_call_count: 0,
    })
    expect(preview.items.map((item) => item.group)).toEqual([
      'exact_match',
      'missing_must_have',
      'exclusion_hit',
      'partial_relevance',
      'insufficient_evidence',
    ])
    expect(new Set(preview.items.map((item) => item.case_id)).size).toBe(5)
    expect(provider.review).not.toHaveBeenCalled()

    await service.authorizeSmoke(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: preview.preflight_fingerprint,
      max_calls: 5,
      max_cost_cny: 0.5,
    })
    await expect(service.start(fixture.datasetId)).rejects.toThrow(/视觉授权/)

    const run = await service.start(fixture.datasetId, 'smoke')
    const completed = await service.executePending(run.id)
    expect(provider.review).toHaveBeenCalledTimes(5)
    expect(completed).toMatchObject({
      protocol_version: 'vlm-review-smoke-v1',
      status: 'succeeded',
      case_count: 5,
      planned_call_count: 5,
      external_call_count: 5,
      metrics: {
        smoke_only: true,
        case_total: 5,
        eligible_for_real_top3_simulation: false,
      },
    })
  })

  test('creates a separate four-call recovery run without overwriting the unknown source attempt', async () => {
    const review = vi
      .fn()
      .mockImplementationOnce(async (request) => successfulProviderResult(request))
      .mockRejectedValueOnce(
        new QwenVlmReviewProviderError('VLM_REVIEW_OUTCOME_UNKNOWN', 'sanitized', true),
      )
      .mockImplementation(async (request) => successfulProviderResult(request))
    const service = createService(context.db, fixture, externalProvider(review))
    const smokePreview = await service.smokePreflight(fixture.datasetId)
    await service.authorizeSmoke(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: smokePreview.preflight_fingerprint,
      max_calls: 5,
      max_cost_cny: 0.5,
    })
    const sourceRun = await service.start(fixture.datasetId, 'smoke')
    const stopped = await service.executePending(sourceRun.id)
    expect(stopped).toMatchObject({
      status: 'outcome_unknown',
      external_call_count: 2,
      succeeded_count: 1,
      unknown_count: 1,
      metrics: { case_total: 1, planned_case_total: 5 },
    })

    const recoveryPreview = await service.smokeRecoveryPreflight(sourceRun.id)
    expect(recoveryPreview).toMatchObject({
      source_run_id: sourceRun.id,
      execution_mode: 'smoke_recovery',
      protocol_version: 'vlm-review-smoke-recovery-v1',
      candidate_count: 4,
      maximum_call_count: 4,
      total_image_count: 4,
      budget: { max_calls: 4, max_cost_cny: 0.4 },
      external_call_count: 0,
    })
    expect(recoveryPreview.items.map((item) => item.recovery_reason)).toEqual([
      'retry_outcome_unknown',
      'previously_not_dispatched',
      'previously_not_dispatched',
      'previously_not_dispatched',
    ])
    await service.authorizeSmokeRecovery(sourceRun.id, {
      confirmed: true,
      preflight_fingerprint: recoveryPreview.preflight_fingerprint,
      max_calls: 4,
      max_cost_cny: 0.4,
    })
    const recoveryRun = await service.startSmokeRecovery(sourceRun.id)
    const completed = await service.executePending(recoveryRun.id)

    expect(review).toHaveBeenCalledTimes(6)
    expect(completed).toMatchObject({
      protocol_version: 'vlm-review-smoke-recovery-v1',
      status: 'succeeded',
      planned_call_count: 4,
      external_call_count: 4,
      succeeded_count: 4,
      metrics: {
        smoke_only: true,
        case_total: 4,
        audit: { all_planned_calls_succeeded: true },
        eligible_for_real_top3_simulation: false,
      },
    })
    expect(completed.attempts[0].retry_of_attempt_id).toBeTruthy()
    await expect(service.getRun(sourceRun.id)).resolves.toMatchObject({
      status: 'outcome_unknown',
      external_call_count: 2,
      unknown_count: 1,
    })
  })

  test('chains a two-call recovery after the first recovery stops on another unknown', async () => {
    const unknown = () =>
      new QwenVlmReviewProviderError('VLM_REVIEW_OUTCOME_UNKNOWN', 'sanitized', true)
    const review = vi
      .fn()
      // 原 smoke：第一条成功，第二条超时，后三条保持未派发。
      .mockImplementationOnce(async (request) => successfulProviderResult(request))
      .mockRejectedValueOnce(unknown())
      // 第一级 recovery：前两条成功，第三条再次超时，最后一条保持未派发。
      .mockImplementationOnce(async (request) => successfulProviderResult(request))
      .mockImplementationOnce(async (request) => successfulProviderResult(request))
      .mockRejectedValueOnce(unknown())
      // 第二级 recovery：显式重试 unknown，再执行最后一条未派发案例。
      .mockImplementation(async (request) => successfulProviderResult(request))
    const service = createService(context.db, fixture, externalProvider(review))

    const smokePreview = await service.smokePreflight(fixture.datasetId)
    await service.authorizeSmoke(fixture.datasetId, {
      confirmed: true,
      preflight_fingerprint: smokePreview.preflight_fingerprint,
      max_calls: 5,
      max_cost_cny: 0.5,
    })
    const smokeRun = await service.start(fixture.datasetId, 'smoke')
    await service.executePending(smokeRun.id)

    const firstPreview = await service.smokeRecoveryPreflight(smokeRun.id)
    await service.authorizeSmokeRecovery(smokeRun.id, {
      confirmed: true,
      preflight_fingerprint: firstPreview.preflight_fingerprint,
      max_calls: 4,
      max_cost_cny: 0.4,
    })
    const firstRecovery = await service.startSmokeRecovery(smokeRun.id)
    const firstStopped = await service.executePending(firstRecovery.id)
    expect(firstStopped).toMatchObject({
      status: 'outcome_unknown',
      planned_call_count: 4,
      external_call_count: 3,
      succeeded_count: 2,
      unknown_count: 1,
    })

    const secondPreview = await service.smokeRecoveryPreflight(firstRecovery.id)
    expect(secondPreview).toMatchObject({
      source_run_id: firstRecovery.id,
      protocol_version: 'vlm-review-smoke-recovery-v1',
      candidate_count: 2,
      maximum_call_count: 2,
      total_image_count: 2,
      budget: { max_calls: 2, max_cost_cny: 0.4 },
      external_call_count: 0,
    })
    expect(secondPreview.items.map((item) => item.recovery_reason)).toEqual([
      'retry_outcome_unknown',
      'previously_not_dispatched',
    ])
    await service.authorizeSmokeRecovery(firstRecovery.id, {
      confirmed: true,
      preflight_fingerprint: secondPreview.preflight_fingerprint,
      max_calls: 2,
      max_cost_cny: 0.2,
    })
    const secondRecovery = await service.startSmokeRecovery(firstRecovery.id)
    const completed = await service.executePending(secondRecovery.id)

    expect(review).toHaveBeenCalledTimes(7)
    expect(completed).toMatchObject({
      status: 'succeeded',
      planned_call_count: 2,
      external_call_count: 2,
      succeeded_count: 2,
      unknown_count: 0,
      metrics: {
        smoke_only: true,
        case_total: 2,
        planned_case_total: 2,
        audit: { all_planned_calls_succeeded: true },
      },
    })
    // 两个来源 run 保留原来的 unknown/pending 事实，第二级恢复只新增审计行。
    await expect(service.getRun(firstRecovery.id)).resolves.toMatchObject({
      status: 'outcome_unknown',
      external_call_count: 3,
      unknown_count: 1,
    })
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
      metrics: {
        gates: { p95_latency_at_most_180000_ms: true },
      },
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
      vlmReviewTimeoutMs: 180_000,
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
