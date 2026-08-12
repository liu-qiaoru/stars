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
} from '../../src/database/schema.js'
import type {
  ShadowRerankProvider,
  ShadowRerankProviderResult,
} from '../../src/evaluation/shadow-rerank.provider.js'
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
    expect(recovered).toMatchObject({ status: 'failed' })
    expect(recovered.attempts[0]).toMatchObject({
      status: 'outcome_unknown',
      external_call_status: 'outcome_unknown',
    })
    expect(rerank).not.toHaveBeenCalled()
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
