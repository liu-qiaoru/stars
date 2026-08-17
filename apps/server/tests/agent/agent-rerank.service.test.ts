import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import sharp from 'sharp'
import { asc, eq } from 'drizzle-orm'
import { createTestDatabase } from '../database/test-db.js'
import { createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import { AgentRerankService } from '../../src/agent/agent-rerank.service.js'
import {
  agentRerankRankings,
  agentRerankRuns,
  agentRunCandidates,
  agentRuns,
  libraries,
  mediaAssets,
  mediaFiles,
} from '../../src/database/schema.js'
import type { ShadowRerankProvider } from '../../src/evaluation/shadow-rerank.provider.js'

let testDb: Awaited<ReturnType<typeof createTestDatabase>> | undefined
let fixtureDirectory: string | undefined

afterEach(async () => {
  await testDb?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  testDb = undefined
  fixtureDirectory = undefined
})

describe('Agent product rerank', () => {
  test('保留 RRF Top-20，保存独立 Top-10，并允许用户改选一条反馈', async () => {
    testDb = await createTestDatabase()
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'stars-agent-rerank-'))
    const libraryId = randomUUID()
    await testDb.db.insert(libraries).values({
      id: libraryId,
      name: 'rerank fixture',
      rootPath: fixtureDirectory,
    })
    const run = await createDurableAgentRun(testDb.db, {
      prompt: '找一个人抱着一束花',
      allowExternalText: true,
      allowExternalVisual: true,
      libraryIds: [libraryId],
      mediaTypes: ['image'],
    })
    await testDb.db
      .update(agentRuns)
      .set({ status: 'waiting_for_export_selection' })
      .where(eq(agentRuns.id, run.id))

    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#cc3355' },
    })
      .png()
      .toBuffer()
    for (let rank = 1; rank <= 20; rank += 1) {
      const fileId = randomUUID()
      const assetId = randomUUID()
      const path = join(fixtureDirectory, `${rank}.png`)
      await writeFile(path, png)
      await testDb.db.insert(mediaFiles).values({
        id: fileId,
        libraryId,
        path,
        relativePath: `${rank}.png`,
        mediaType: 'image',
        sizeBytes: png.byteLength,
        mtimeMs: 1,
        indexStatus: 'indexed',
      })
      await testDb.db.insert(mediaAssets).values({ id: assetId, fileId, assetType: 'image' })
      await testDb.db.insert(agentRunCandidates).values({
        id: randomUUID(),
        runId: run.id,
        candidateKey: `image:${assetId}`,
        fileId,
        fileGeneration: 0,
        assetId,
        rank,
      })
    }

    const provider: ShadowRerankProvider = {
      available: true,
      rerank: vi.fn().mockResolvedValue({
        // 反转前 10 个 index，让测试证明 RRF rank 没有被原地覆盖。
        response: {
          results: Array.from({ length: 10 }, (_, offset) => ({
            index: 9 - offset,
            relevance_score: 1 - offset / 10,
          })),
        },
        providerRequestId: 'fake-request-1',
        responseModel: null,
        modelSnapshot: null,
        region: 'test',
        inputTokens: null,
        outputTokens: null,
        totalTokens: 100,
        billedCostCny: null,
      }),
    }
    const service = new AgentRerankService(
      testDb.db,
      provider,
      { agentRerankTimeoutMs: 5_000, agentExecutorIntervalMs: 60_000 },
      { createEvidence: vi.fn() } as never,
    )

    const started = await service.start(run.id, { confirmed: true, max_cost_cny: 0.216 })
    expect(started.status).toBe('preparing_evidence')
    await vi.waitFor(
      async () => {
        expect((await service.getForAgentRun(run.id))?.status).toBe('succeeded')
      },
      { timeout: 5_000 },
    )

    const original = await testDb.db
      .select({ rank: agentRunCandidates.rank })
      .from(agentRunCandidates)
      .where(eq(agentRunCandidates.runId, run.id))
      .orderBy(asc(agentRunCandidates.rank))
    expect(original.map((item) => item.rank)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
    const rankings = await testDb.db
      .select()
      .from(agentRerankRankings)
      .orderBy(asc(agentRerankRankings.rrfRank))
    expect(rankings).toHaveLength(20)
    expect(rankings[9]?.rerankRank).toBe(1)
    expect(rankings[10]?.rerankRank).toBeNull()

    const firstFeedback = await service.saveFeedback(started.id, { verdict: 'rerank_better' })
    expect(firstFeedback.feedback).toBe('rerank_better')
    const changedFeedback = await service.saveFeedback(started.id, { verdict: 'same' })
    expect(changedFeedback.feedback).toBe('same')
  })

  test('重启只把已外发未落库的请求标成 outcome_unknown，不自动调用 Provider', async () => {
    testDb = await createTestDatabase()
    const run = await createDurableAgentRun(testDb.db, {
      prompt: '找一张花束图片',
      allowExternalText: true,
      allowExternalVisual: true,
      libraryIds: [],
      mediaTypes: ['image'],
    })
    const rerankRunId = randomUUID()
    await testDb.db.insert(agentRerankRuns).values({
      id: rerankRunId,
      agentRunId: run.id,
      protocolVersion: 'qwen3-vl-rerank-top20-v1',
      status: 'running',
      externalCallStatus: 'dispatched',
      maxCostCny: '0.216',
    })
    const rerank = vi.fn()
    const service = new AgentRerankService(
      testDb.db,
      { available: false, rerank },
      { agentRerankTimeoutMs: 5_000, agentExecutorIntervalMs: 60_000 },
      { createEvidence: vi.fn() } as never,
    )

    await service.onModuleInit()
    expect(await service.getForAgentRun(run.id)).toMatchObject({
      status: 'outcome_unknown',
      external_call_status: 'dispatched',
    })
    expect(rerank).not.toHaveBeenCalled()
    service.onModuleDestroy()
  })
})
