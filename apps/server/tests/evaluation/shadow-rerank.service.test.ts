import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  candidateEvidence,
  agentRunCandidates,
  agentRuns,
  evaluationCandidates,
  evaluationQueries,
  evaluationRuns,
  evaluationSets,
  evaluationShadowAttempts,
  evaluationShadowRankings,
  evaluationShadowRuns,
  evaluationVersions,
  libraries,
  mediaAssets,
  mediaFiles,
  vectorRefs,
  videoScenes,
} from '../../src/database/schema.js'
import type {
  ShadowRerankProvider,
  ShadowRerankProviderResult,
} from '../../src/evaluation/shadow-rerank.provider.js'
import { ShadowRerankProviderResponseError } from '../../src/evaluation/shadow-rerank.provider.js'
import { ShadowRerankService } from '../../src/evaluation/shadow-rerank.service.js'
import { createTestDatabase } from '../database/test-db.js'

let context: Awaited<ReturnType<typeof createTestDatabase>>
let artifactDirectory: string

beforeEach(async () => {
  context = await createTestDatabase()
  artifactDirectory = await mkdtemp(join(tmpdir(), 'phase-e-shadow-'))
})

afterEach(async () => {
  await context.close()
  await rm(artifactDirectory, { recursive: true, force: true })
})

describe('Phase E Evaluation shadow rerank', () => {
  test('previews exact outbound request facts without dispatching or creating a shadow run', async () => {
    const fixture = await createReportedRun()
    const rerank = vi.fn()
    const service = new ShadowRerankService(context.db, { available: false, rerank })

    const preview = await service.preview(fixture.runId)

    expect(preview).toMatchObject({
      evaluation_run_id: fixture.runId,
      provider: 'dashscope',
      requested_model: 'qwen3-vl-rerank',
      region: 'cn-beijing',
      protocol_version: 'qwen3-vl-rerank-top20-v1',
      external_call_count: 0,
      items: [
        {
          query_id: fixture.queryId,
          candidate_count: 20,
          document_count: 20,
          request_bytes: expect.any(Number),
          query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          evidence_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    })
    expect(preview.items[0]!.request_bytes).toBeGreaterThan(0)
    expect(rerank).not.toHaveBeenCalled()
    expect(await context.db.select().from(evaluationShadowRuns)).toHaveLength(0)
  })

  test('previews a caption-only frame anchor but rejects replacing a frozen frame candidate with another frame', async () => {
    const fixture = await createReportedRun()
    const [candidate] = await context.db
      .select()
      .from(evaluationCandidates)
      .where(eq(evaluationCandidates.runId, fixture.runId))
      .orderBy(evaluationCandidates.rrfRank)
      .limit(1)
    const [evidence] = await context.db
      .select()
      .from(candidateEvidence)
      .where(eq(candidateEvidence.sourceId, candidate!.id))
    const libraryId = randomUUID()
    await context.db.insert(libraries).values({
      id: libraryId,
      name: 'Caption anchor fixture',
      rootPath: artifactDirectory,
    })
    await context.db.insert(mediaFiles).values({
      id: candidate!.fileId,
      libraryId,
      path: join(artifactDirectory, 'caption-anchor.mp4'),
      relativePath: 'caption-anchor.mp4',
      mediaType: 'video',
      sizeBytes: 1,
      mtimeMs: 1,
      indexGeneration: candidate!.fileGeneration,
    })
    await context.db.insert(videoScenes).values({
      id: candidate!.sceneId!,
      fileId: candidate!.fileId,
      sceneKey: 'caption-anchor-scene',
      startTimeSeconds: '0',
      endTimeSeconds: '10',
      detectionStrategy: 'fixture',
      strategyFingerprint: 'fixture',
      indexGeneration: candidate!.fileGeneration,
    })
    const captionAssetId = randomUUID()
    const frameAssetId = randomUUID()
    await context.db.insert(mediaAssets).values([
      {
        id: captionAssetId,
        fileId: candidate!.fileId,
        sceneId: candidate!.sceneId,
        assetType: 'caption',
        textContent: '有人在海边走路',
        contentHash: 'caption-anchor',
        metadataJson: { prompt_version: 'scene-caption-v2', stale: false },
      },
      {
        id: frameAssetId,
        fileId: candidate!.fileId,
        sceneId: candidate!.sceneId,
        assetType: 'video_frame',
        frameTimeSeconds: '1',
        contentHash: 'frame-anchor',
        metadataJson: { stale: false },
      },
    ])
    await context.db.insert(vectorRefs).values({
      id: randomUUID(),
      assetId: frameAssetId,
      fileId: candidate!.fileId,
      libraryId,
      collectionName: 'video_frame_vectors',
      pointId: randomUUID(),
      modelName: 'siglip2',
      modelVersion: 'fixture',
      vectorKind: 'video_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'frame-anchor',
      indexProfile: 'fixture',
      status: 'indexed',
    })
    await context.db
      .update(evaluationCandidates)
      .set({ assetId: captionAssetId })
      .where(eq(evaluationCandidates.id, candidate!.id))
    await context.db
      .update(candidateEvidence)
      .set({ assetId: frameAssetId })
      .where(eq(candidateEvidence.id, evidence!.id))
    const service = new ShadowRerankService(context.db, { available: false, rerank: vi.fn() })

    const preview = await service.preview(fixture.runId)

    expect(preview.items[0]).toMatchObject({ candidate_count: 20, document_count: 20 })

    const replacementFrameId = randomUUID()
    await context.db.insert(mediaAssets).values({
      id: replacementFrameId,
      fileId: candidate!.fileId,
      sceneId: candidate!.sceneId,
      assetType: 'video_frame',
      frameTimeSeconds: '2',
      contentHash: 'replacement-frame',
      metadataJson: { stale: false },
    })
    await context.db.insert(vectorRefs).values({
      id: randomUUID(),
      assetId: replacementFrameId,
      fileId: candidate!.fileId,
      libraryId,
      collectionName: 'video_frame_vectors',
      pointId: randomUUID(),
      modelName: 'siglip2',
      modelVersion: 'fixture',
      vectorKind: 'video_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'replacement-frame',
      indexProfile: 'fixture',
      status: 'indexed',
    })
    await context.db
      .update(evaluationCandidates)
      .set({ assetId: frameAssetId })
      .where(eq(evaluationCandidates.id, candidate!.id))
    await context.db
      .update(candidateEvidence)
      .set({ assetId: replacementFrameId })
      .where(eq(candidateEvidence.id, evidence!.id))

    await expect(service.preview(fixture.runId)).rejects.toMatchObject({
      code: 'SHADOW_EVIDENCE_IDENTITY_MISMATCH',
    })
  })

  test('sends one complete Top-20 request and persists all RRF/shadow ranks without changing candidates', async () => {
    const fixture = await createReportedRun()
    const agentRunId = randomUUID()
    await context.db.insert(agentRuns).values({
      id: agentRunId,
      prompt: '普通 Agent 排序不得改变',
      status: 'succeeded',
      nextStep: 'searching',
    })
    for (let rank = 1; rank <= 3; rank += 1) {
      await context.db.insert(agentRunCandidates).values({
        id: randomUUID(),
        runId: agentRunId,
        candidateKey: `agent-candidate-${rank}`,
        fileId: randomUUID(),
        fileGeneration: 1,
        assetId: randomUUID(),
        rank,
      })
    }
    const rerank = vi.fn(
      async (_request): Promise<ShadowRerankProviderResult> => ({
        response: {
          results: Array.from({ length: 10 }, (_, offset) => ({
            index: 19 - offset,
            relevance_score: 0.99 - offset / 100,
          })),
        },
        providerRequestId: 'request-fake-1',
        responseModel: 'qwen3-vl-rerank',
        modelSnapshot: 'fake-snapshot-v1',
        region: 'test-local',
        inputTokens: 200,
        outputTokens: 10,
        totalTokens: 210,
        billedCostCny: 0.01,
      }),
    )
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank,
    } satisfies ShadowRerankProvider)

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)
    const candidatesAfter = await context.db
      .select()
      .from(evaluationCandidates)
      .orderBy(evaluationCandidates.rrfRank)
    const agentCandidatesAfter = await context.db
      .select()
      .from(agentRunCandidates)
      .orderBy(agentRunCandidates.rank)

    expect(rerank).toHaveBeenCalledTimes(1)
    expect(rerank.mock.calls[0]![0]).toMatchObject({
      model: 'qwen3-vl-rerank',
      query: '红色汽车经过桥下',
      top_n: 10,
    })
    expect(rerank.mock.calls[0]![0].documents).toHaveLength(20)
    expect(completed).toMatchObject({
      status: 'succeeded',
      succeeded_count: 1,
      failed_count: 0,
      actual_sample_count: 1,
      review_status: 'not_run',
      metric_summary: {
        successful_samples: {
          n: 1,
          rrf: { reciprocalRank: 1 },
          shadow: { reciprocalRank: 1 / 11 },
        },
        full_product_samples: {
          n: 1,
          shadow_with_rrf_fallback: { reciprocalRank: 1 / 11 },
        },
      },
    })
    expect(completed.attempts[0]).toMatchObject({
      provider_request_id: 'request-fake-1',
      actual_candidate_count: 20,
      actual_result_count: 10,
      total_tokens: 210,
      metrics: {
        rrf: { hitAt10: 1, reciprocalRank: 1 },
        shadow: { hitAt10: 0, reciprocalRank: 1 / 11 },
      },
    })
    expect(completed.attempts[0]!.rankings).toHaveLength(20)
    expect(completed.attempts[0]!.rankings.find((item) => item.shadow_rank === 1)).toMatchObject({
      rrf_rank: 20,
      relevance_score: 0.99,
    })
    expect(candidatesAfter.map((candidate) => candidate.rrfRank)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
    expect(
      agentCandidatesAfter.map((candidate) => [candidate.candidateKey, candidate.rank]),
    ).toEqual([
      ['agent-candidate-1', 1],
      ['agent-candidate-2', 2],
      ['agent-candidate-3', 3],
    ])
  })

  test('rejects an invalid Provider response as a whole and writes no partial ranking', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi.fn().mockResolvedValue({
        response: {
          results: Array.from({ length: 10 }, () => ({ index: 0, relevance_score: 0.5 })),
        },
        providerRequestId: 'bad-response',
        responseModel: 'qwen3-vl-rerank',
        modelSnapshot: null,
        region: 'test-local',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        billedCostCny: 0,
      }),
    })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)
    const rankings = await context.db.select().from(evaluationShadowRankings)

    expect(completed.status).toBe('failed')
    expect(completed.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'completed',
      provider_request_id: 'bad-response',
      actual_result_count: 10,
      error: { code: 'SHADOW_PROVIDER_RESPONSE_INVALID' },
    })
    expect(completed.attempts[0]!.response_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(rankings).toHaveLength(0)
  })

  test('accepts the official DashScope audit shape without inventing unavailable metadata', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi.fn().mockResolvedValue({
        ...validProviderResult(),
        providerRequestId: 'dashscope-request-1',
        responseModel: null,
        modelSnapshot: null,
        region: 'cn-beijing',
        inputTokens: null,
        outputTokens: null,
        totalTokens: 321,
        billedCostCny: null,
      } satisfies ShadowRerankProviderResult),
    })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed).toMatchObject({
      status: 'succeeded',
      response_model: null,
      region: 'cn-beijing',
      input_tokens: null,
      output_tokens: null,
      total_tokens: 321,
      billed_cost_cny: null,
      estimated_cost_cny: 0.0005778,
    })
    expect(completed.attempts[0]).toMatchObject({
      status: 'succeeded',
      external_call_status: 'completed',
      provider_request_id: 'dashscope-request-1',
      response_model: null,
      region: 'cn-beijing',
      input_tokens: null,
      output_tokens: null,
      total_tokens: 321,
      billed_cost_cny: null,
      estimated_cost_cny: 0.0005778,
    })
  })

  test.each([
    ['missing Top-20 candidate', 'candidate', 'SHADOW_TOP20_INCOMPLETE'],
    ['missing frozen evidence', 'evidence', 'SHADOW_EVIDENCE_INCOMPLETE'],
    ['mismatched frozen evidence identity', 'identity', 'SHADOW_EVIDENCE_IDENTITY_MISMATCH'],
  ] as const)('fails before dispatch for %s', async (_label, defect, expectedCode) => {
    const fixture = await createReportedRun()
    const [candidate] = await context.db
      .select()
      .from(evaluationCandidates)
      .orderBy(evaluationCandidates.rrfRank)
      .limit(1)
    if (defect === 'candidate') {
      await context.db
        .delete(evaluationCandidates)
        .where(eq(evaluationCandidates.id, candidate!.id))
    } else if (defect === 'evidence') {
      await context.db
        .delete(candidateEvidence)
        .where(eq(candidateEvidence.sourceId, candidate!.id))
    } else {
      await context.db
        .update(candidateEvidence)
        .set({ fileGeneration: 2 })
        .where(eq(candidateEvidence.sourceId, candidate!.id))
    }
    const rerank = vi.fn()
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'not_dispatched',
      error: { code: expectedCode },
    })
    expect(rerank).not.toHaveBeenCalled()
  })

  test('reuses the same run under concurrent starts and dispatches the Provider at most once', async () => {
    const fixture = await createReportedRun()
    const rerank = vi.fn().mockResolvedValue(validProviderResult())
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const [left, right] = await Promise.all([
      service.start(fixture.runId),
      service.start(fixture.runId),
    ])
    await Promise.all([service.executePending(left.id), service.executePending(right.id)])
    const attempts = await context.db.select().from(evaluationShadowAttempts)

    expect(left.id).toBe(right.id)
    expect(attempts).toHaveLength(1)
    expect(rerank).toHaveBeenCalledTimes(1)
  })

  test('dispatches only the first visual query under the default one-call smoke authorization', async () => {
    const fixture = await createReportedRun()
    await addSecondVisualQuery(fixture.runId, fixture.queryId)
    const rerank = vi.fn().mockResolvedValue(validProviderResult())
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(rerank).toHaveBeenCalledTimes(1)
    expect(completed).toMatchObject({
      status: 'completed_with_errors',
      succeeded_count: 1,
      failed_count: 1,
    })
    expect(completed.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'succeeded', external_call_status: 'completed' }),
        expect.objectContaining({
          status: 'failed',
          external_call_status: 'not_dispatched',
          error: expect.objectContaining({ code: 'SHADOW_RERANK_CALL_LIMIT_REACHED' }),
        }),
      ]),
    )
  })

  test('shares the smoke call limit across separate Evaluation runs', async () => {
    const firstFixture = await createReportedRun()
    const secondFixture = await createReportedRun()
    const rerank = vi.fn().mockResolvedValue(validProviderResult())
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const first = await service.start(firstFixture.runId)
    const second = await service.start(secondFixture.runId)
    await service.executePending(first.id)
    const blocked = await service.executePending(second.id)

    expect(rerank).toHaveBeenCalledTimes(1)
    expect(blocked.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'not_dispatched',
      error: expect.objectContaining({ code: 'SHADOW_RERANK_CALL_LIMIT_REACHED' }),
    })
  })

  test('reopens a policy-blocked non-dispatched query after a later larger authorization', async () => {
    const fixture = await createReportedRun()
    await addSecondVisualQuery(fixture.runId, fixture.queryId)
    const rerank = vi.fn().mockResolvedValue(validProviderResult())
    const firstAuthorization = new ShadowRerankService(context.db, { available: true, rerank })

    const started = await firstAuthorization.start(fixture.runId)
    await firstAuthorization.executePending(started.id)

    const laterAuthorization = new ShadowRerankService(
      context.db,
      { available: true, rerank },
      { shadowRerankMaxCalls: 2, shadowRerankMaxCostCny: 0.5 },
    )
    const resumed = await laterAuthorization.start(fixture.runId)
    const completed = await laterAuthorization.executePending(resumed.id)

    expect(rerank).toHaveBeenCalledTimes(2)
    expect(completed).toMatchObject({ status: 'succeeded', succeeded_count: 2, failed_count: 0 })
    expect(completed.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'succeeded', external_call_status: 'completed' }),
      ]),
    )
  })

  test('stops before a second call when the first dispatched attempt has unknown usage', async () => {
    const fixture = await createReportedRun()
    await addSecondVisualQuery(fixture.runId, fixture.queryId)
    const rerank = vi.fn().mockResolvedValue({
      ...validProviderResult(),
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      billedCostCny: null,
    } satisfies ShadowRerankProviderResult)
    const service = new ShadowRerankService(
      context.db,
      { available: true, rerank },
      {
        shadowRerankMaxCalls: 4,
        shadowRerankMaxCostCny: 0.5,
      },
    )

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(rerank).toHaveBeenCalledTimes(1)
    expect(completed.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failed',
          external_call_status: 'not_dispatched',
          error: expect.objectContaining({ code: 'SHADOW_RERANK_BUDGET_UNKNOWN' }),
        }),
      ]),
    )
    expect(completed).toMatchObject({
      total_tokens: null,
      estimated_cost_cny: null,
    })
    expect(completed.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'succeeded',
          total_tokens: null,
          estimated_cost_cny: null,
          rankings: expect.arrayContaining([
            expect.objectContaining({ shadow_rank: 1, relevance_score: 1 }),
          ]),
        }),
      ]),
    )
  })

  test('uses a separately sourced console reconciliation to unlock the next authorized call', async () => {
    const firstFixture = await createReportedRun()
    const invalidFirstResponse = validProviderResult()
    const invalidRankingBody = invalidFirstResponse.response as {
      results: Array<{ index: number; relevance_score: number }>
    }
    invalidRankingBody.results = invalidRankingBody.results.slice(0, 9)
    const rerank = vi
      .fn()
      .mockResolvedValueOnce({
        ...invalidFirstResponse,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        billedCostCny: null,
      } satisfies ShadowRerankProviderResult)
      .mockResolvedValueOnce(validProviderResult())
    const firstAuthorization = new ShadowRerankService(context.db, { available: true, rerank })
    const first = await firstAuthorization.start(firstFixture.runId)
    const firstCompleted = await firstAuthorization.executePending(first.id)
    const firstAttempt = firstCompleted.attempts[0]!

    const reconciled = await firstAuthorization.reconcileUsage(firstAttempt.id, {
      source: 'aliyun_model_monitor',
      providerRequestId: 'fake-request',
      totalTokens: 25_640,
      textInputTokens: 1_200,
      imageInputTokens: 24_440,
    })

    expect(reconciled.usage_reconciliation).toMatchObject({
      source: 'aliyun_model_monitor',
      total_tokens: 25_640,
      text_input_tokens: 1_200,
      image_input_tokens: 24_440,
      estimated_cost_cny: 0.044832,
    })
    expect(reconciled.total_tokens).toBeNull()

    // execution 2 先被旧的一次调用授权拦截；它仍保存冻结指纹。扩大到两次调用后，
    // execution 3 应能继续，而不是把上一条 not_dispatched 的 null 当作指纹漂移。
    const restrictedAuthorization = new ShadowRerankService(context.db, {
      available: true,
      rerank,
    })
    const blocked = await restrictedAuthorization.retry(firstFixture.runId)
    const blockedCompleted = await restrictedAuthorization.executePending(blocked.id)
    expect(blockedCompleted.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'not_dispatched',
      error: expect.objectContaining({ code: 'SHADOW_RERANK_CALL_LIMIT_REACHED' }),
    })

    const secondAuthorization = new ShadowRerankService(
      context.db,
      { available: true, rerank },
      { shadowRerankMaxCalls: 2, shadowRerankMaxCostCny: 0.5 },
    )
    // 第二次 smoke 必须继续使用同一个 Evaluation run 的冻结 Top-20，同时创建新的
    // shadow run/attempt 保存独立 request ID，不能覆盖第一次失败调用的审计事实。
    const second = await secondAuthorization.retry(firstFixture.runId)
    const secondCompleted = await secondAuthorization.executePending(second.id)

    expect(rerank).toHaveBeenCalledTimes(2)
    expect(secondCompleted.attempts[0]).toMatchObject({
      status: 'succeeded',
      external_call_status: 'completed',
    })
    expect(second.id).not.toBe(first.id)
    expect(second.execution_number).toBe(3)
    expect(firstCompleted.execution_number).toBe(1)

    const preservedFirst = await firstAuthorization.get(first.id)
    expect(preservedFirst.attempts[0]).toMatchObject({
      id: firstAttempt.id,
      provider_request_id: 'fake-request',
      total_tokens: null,
    })
    const latestWithHistory = await secondAuthorization.findByEvaluationRun(firstFixture.runId)
    expect(latestWithHistory?.execution_history).toHaveLength(3)
    expect(latestWithHistory?.execution_history?.[2]?.attempts[0]).toMatchObject({
      provider_request_id: 'fake-request',
      usage_reconciliation: expect.objectContaining({ total_tokens: 25_640 }),
    })
  })

  test('reconciliation is idempotent but rejects conflicting console facts', async () => {
    const fixture = await createReportedRun()
    const provider = {
      available: true,
      rerank: vi.fn().mockResolvedValue({
        ...validProviderResult(),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    }
    const service = new ShadowRerankService(context.db, provider)
    const run = await service.start(fixture.runId)
    const completed = await service.executePending(run.id)
    const attempt = completed.attempts[0]!
    const input = {
      source: 'aliyun_model_monitor' as const,
      providerRequestId: 'fake-request',
      totalTokens: 25_640,
      textInputTokens: 1_200,
      imageInputTokens: 24_440,
    }

    await expect(service.reconcileUsage(attempt.id, input)).resolves.toMatchObject({
      usage_reconciliation: expect.objectContaining({ total_tokens: 25_640 }),
    })
    await expect(service.reconcileUsage(attempt.id, input)).resolves.toMatchObject({
      usage_reconciliation: expect.objectContaining({ total_tokens: 25_640 }),
    })
    await expect(
      service.reconcileUsage(attempt.id, { ...input, textInputTokens: 1_201, totalTokens: 25_641 }),
    ).rejects.toThrow('usage reconciliation already exists with other facts')
  })

  test('persists a spoken query as not applicable and never dispatches it', async () => {
    const fixture = await createReportedRun('spoken')
    const rerank = vi.fn()
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed).toMatchObject({
      status: 'not_applicable',
      query_count: 1,
      not_applicable_count: 1,
      actual_sample_count: 0,
    })
    expect(completed.attempts[0]).toMatchObject({
      status: 'not_applicable',
      external_call_status: 'not_dispatched',
      applicability_reason: '只有冻结 search_scope=visual 的查询可进入影子重排',
    })
    expect(rerank).not.toHaveBeenCalled()
  })

  test('resizes a frozen image candidate while video candidates keep contact_sheet_v1 evidence', async () => {
    const fixture = await createReportedRun('visual', 1)
    const rerank = vi.fn().mockResolvedValue(validProviderResult())
    const service = new ShadowRerankService(context.db, { available: true, rerank })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed.attempts[0]?.error).toBeNull()
    expect(completed.status).toBe('succeeded')
    const request = rerank.mock.calls[0]![0]
    expect(request.documents).toHaveLength(20)
    expect(
      Buffer.from(request.documents[0]!.image_base64, 'base64').subarray(1, 4).toString(),
    ).toBe('PNG')
  })

  test('refuses an unavailable real Provider before creating billable run facts', async () => {
    const fixture = await createReportedRun()
    const rerank = vi.fn()
    const service = new ShadowRerankService(context.db, { available: false, rerank })

    await expect(service.startAndSchedule(fixture.runId)).rejects.toThrow(/授权/)

    expect(await context.db.select().from(evaluationShadowRuns)).toHaveLength(0)
    expect(await context.db.select().from(evaluationShadowAttempts)).toHaveLength(0)
    expect(rerank).not.toHaveBeenCalled()
  })

  test('persists a run-level scheduler failure instead of silently leaving a pending run', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi.fn(),
    })
    vi.spyOn(service, 'executePending').mockRejectedValueOnce(
      new Error('database projection failed'),
    )

    const started = await service.startAndSchedule(fixture.runId)

    await vi.waitFor(async () => {
      expect(await service.get(started.id)).toMatchObject({
        status: 'failed',
        error: { code: 'SHADOW_RERANK_SCHEDULER_FAILED' },
      })
    })
  })

  test('rejects inconsistent Provider token metadata through a structured runtime boundary', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi.fn().mockResolvedValue({ ...validProviderResult(), totalTokens: 999 }),
    })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'completed',
      provider_request_id: 'fake-request',
      response_model: 'qwen3-vl-rerank',
      region: 'test-local',
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: null,
      billed_cost_cny: 0,
      actual_result_count: 10,
      latency_ms: expect.any(Number),
      response_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      error: { code: 'SHADOW_PROVIDER_RESPONSE_INVALID' },
    })
  })

  test('marks dispatched work outcome_unknown after restart and never replays it', async () => {
    const fixture = await createReportedRun()
    const rerank = vi.fn()
    const service = new ShadowRerankService(context.db, { available: true, rerank })
    const started = await service.start(fixture.runId)
    const [attempt] = await context.db.select().from(evaluationShadowAttempts)
    await context.db
      .update(evaluationShadowAttempts)
      .set({ status: 'running', externalCallStatus: 'dispatched' })
      .where(eq(evaluationShadowAttempts.id, attempt!.id))

    expect(await service.recoverInterrupted()).toBe(1)
    const recovered = await service.get(started.id)
    expect(recovered).toMatchObject({
      status: 'failed',
      total_tokens: null,
      latency_ms: null,
      billed_cost_cny: null,
      estimated_cost_cny: null,
    })
    expect(recovered.attempts[0]).toMatchObject({
      status: 'outcome_unknown',
      external_call_status: 'outcome_unknown',
    })
    expect(rerank).not.toHaveBeenCalled()
  })

  test('persists a definite Provider HTTP rejection as completed failure without raw message', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi
        .fn()
        .mockRejectedValue(
          new ShadowRerankProviderResponseError(
            'SHADOW_PROVIDER_HTTP_ERROR',
            400,
            'Arrearage',
            'dashscope-rejected-1',
            'cn-beijing',
            { code: 'Arrearage', message: 'sensitive provider message' },
          ),
        ),
    })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed.status).toBe('failed')
    expect(completed.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'completed',
      provider_request_id: 'dashscope-rejected-1',
      region: 'cn-beijing',
      actual_result_count: 0,
      error: {
        code: 'SHADOW_PROVIDER_HTTP_ERROR',
        details: { http_status: 400, provider_code: 'Arrearage' },
      },
    })
    expect(completed.attempts[0]!.response_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(completed)).not.toContain('sensitive provider message')
  })

  test('persists only field paths and issue codes for an invalid Provider success body', async () => {
    const fixture = await createReportedRun()
    const service = new ShadowRerankService(context.db, {
      available: true,
      rerank: vi
        .fn()
        .mockRejectedValue(
          new ShadowRerankProviderResponseError(
            'SHADOW_PROVIDER_RESPONSE_INVALID',
            200,
            null,
            'dashscope-invalid-1',
            'cn-beijing',
            { output: { results: [{ index: 'sensitive-invalid-value' }] } },
            [{ path: 'output.results.0.index', code: 'invalid_type' }],
          ),
        ),
    })

    const started = await service.start(fixture.runId)
    const completed = await service.executePending(started.id)

    expect(completed.attempts[0]).toMatchObject({
      status: 'failed',
      external_call_status: 'completed',
      error: {
        code: 'SHADOW_PROVIDER_RESPONSE_INVALID',
        details: {
          http_status: 200,
          provider_code: null,
          schema_issues: [{ path: 'output.results.0.index', code: 'invalid_type' }],
        },
      },
    })
    expect(JSON.stringify(completed)).not.toContain('sensitive-invalid-value')
  })
})

async function createReportedRun(
  searchScope: 'visual' | 'spoken' | 'all' = 'visual',
  imageCount = 0,
) {
  const setId = randomUUID()
  const versionId = randomUUID()
  const queryId = randomUUID()
  const runId = randomUUID()
  await context.db.insert(evaluationSets).values({ id: setId, name: 'Phase E fixture' })
  await context.db.insert(evaluationVersions).values({
    id: versionId,
    setId,
    version: 1,
    status: 'frozen',
    frozenAt: new Date(),
  })
  await context.db.insert(evaluationQueries).values({
    id: queryId,
    versionId,
    queryText: '红色汽车经过桥下',
    queryType: 'known_target',
    searchScope,
    intentCategory: '视觉',
    mustHaveJson: ['红色汽车'],
  })
  await context.db.insert(evaluationRuns).values({
    id: runId,
    versionId,
    status: 'reported',
    configJson: {},
    reportJson: { generated_at: new Date().toISOString(), queries: [] },
  })
  let targetSceneId: string | null = null
  let targetAssetId: string | null = null
  const libraryId = randomUUID()
  if (imageCount > 0) {
    await context.db.insert(libraries).values({
      id: libraryId,
      name: 'Phase E image fixture',
      rootPath: artifactDirectory,
    })
  }
  for (let index = 0; index < 20; index += 1) {
    const candidateId = randomUUID()
    const assetId = randomUUID()
    const fileId = randomUUID()
    const isImage = index < imageCount
    const sceneId = isImage ? null : randomUUID()
    const candidateKey = isImage ? assetId : sceneId!
    if (isImage) targetAssetId ??= assetId
    else targetSceneId ??= sceneId
    const artifact = Buffer.from(`fake-contact-sheet-${index}`)
    const artifactPath = join(artifactDirectory, `${candidateId}.png`)
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
    if (isImage) {
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#ef4444' },
      })
        .png()
        .toFile(artifactPath)
    } else {
      await writeFile(artifactPath, artifact)
    }
    if (isImage) {
      await context.db.insert(mediaFiles).values({
        id: fileId,
        libraryId,
        path: artifactPath,
        relativePath: `${candidateId}.png`,
        mediaType: 'image',
        sizeBytes: 68,
        mtimeMs: 1,
        indexGeneration: 1,
      })
      await context.db.insert(mediaAssets).values({ id: assetId, fileId, assetType: 'image' })
    }
    await context.db.insert(evaluationCandidates).values({
      id: candidateId,
      runId,
      queryId,
      candidateKey,
      assetId,
      fileId,
      sceneId,
      fileGeneration: 1,
      mediaType: isImage ? 'image' : 'video',
      sourceEvidenceJson: {},
      currentRank: index + 1,
      rrfRank: index + 1,
      blindOrder: index + 1,
    })
    if (!isImage) {
      await context.db.insert(candidateEvidence).values({
        id: randomUUID(),
        sourceType: 'evaluation_candidate',
        sourceId: candidateId,
        candidateKey,
        fileId,
        fileGeneration: 1,
        assetId,
        sceneId: sceneId!,
        strategy: 'contact_sheet_v1',
        protocolVersion: 'candidate-evidence-v1',
        status: 'succeeded',
        inputSha256: 'b'.repeat(64),
        artifactSha256,
        artifactPath,
        retentionClass: 'evaluation_frozen',
        frozenAt: new Date(),
      })
    }
  }
  await context.db
    .update(evaluationQueries)
    .set({ targetSceneId, targetAssetId })
    .where(eq(evaluationQueries.id, queryId))
  return { runId, queryId }
}

function validProviderResult(): ShadowRerankProviderResult {
  return {
    response: {
      results: Array.from({ length: 10 }, (_, index) => ({
        index,
        relevance_score: 1 - index / 10,
      })),
    },
    providerRequestId: 'fake-request',
    responseModel: 'qwen3-vl-rerank',
    modelSnapshot: null,
    region: 'test-local',
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    billedCostCny: 0,
  }
}

/** 复用第一条查询的冻结媒体事实，只改变 Evaluation 候选身份，用于验证多查询调用闸门。 */
async function addSecondVisualQuery(runId: string, sourceQueryId: string) {
  const [run] = await context.db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId))
  const queryId = randomUUID()
  await context.db.insert(evaluationQueries).values({
    id: queryId,
    versionId: run!.versionId,
    queryText: '第二条视觉查询不得在首次 smoke 外发',
    queryType: 'discovery',
    searchScope: 'visual',
    intentCategory: '视觉',
    mustHaveJson: ['视觉目标'],
  })
  const candidates = await context.db
    .select()
    .from(evaluationCandidates)
    .where(eq(evaluationCandidates.queryId, sourceQueryId))
  for (const candidate of candidates) {
    const candidateId = randomUUID()
    await context.db.insert(evaluationCandidates).values({
      id: candidateId,
      runId,
      queryId,
      candidateKey: candidate.candidateKey,
      assetId: candidate.assetId,
      fileId: candidate.fileId,
      sceneId: candidate.sceneId,
      fileGeneration: candidate.fileGeneration,
      mediaType: candidate.mediaType,
      sourceEvidenceJson: candidate.sourceEvidenceJson,
      currentRank: candidate.currentRank,
      rrfRank: candidate.rrfRank,
      blindOrder: candidate.blindOrder,
    })
    const [evidence] = await context.db
      .select()
      .from(candidateEvidence)
      .where(eq(candidateEvidence.sourceId, candidate.id))
    if (evidence) {
      await context.db.insert(candidateEvidence).values({
        ...evidence,
        id: randomUUID(),
        sourceId: candidateId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
  }
}
