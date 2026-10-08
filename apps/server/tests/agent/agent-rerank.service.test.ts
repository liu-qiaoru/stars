import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import sharp from 'sharp'
import { asc, eq } from 'drizzle-orm'
import { createTestDatabase } from '../database/test-db.js'
import { createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import {
  AgentRerankService,
  RERANK_SAFE_REQUEST_BYTES,
  encodeEvidenceWithinBudget,
  planEvidenceBudgets,
} from '../../src/agent/agent-rerank.service.js'
import {
  agentRerankRankings,
  agentRerankRuns,
  agentRunCandidates,
  agentRuns,
  libraries,
  mediaAssets,
  mediaFiles,
} from '../../src/database/schema.js'
import type { AgentRerankProvider } from '../../src/agent/agent-rerank.provider.js'
import { AGENT_RERANK_POLICY } from '../../src/agent/agent-rerank.policy.js'

let testDb: Awaited<ReturnType<typeof createTestDatabase>> | undefined
let fixtureDirectory: string | undefined

afterEach(async () => {
  await testDb?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  testDb = undefined
  fixtureDirectory = undefined
})

describe('Agent product rerank', () => {
  test('指定任务推进重排时不会领取更早的其他任务', async () => {
    testDb = await createTestDatabase()
    const runs = []
    for (const prompt of ['更早任务', '指定任务']) {
      const run = await createDurableAgentRun(testDb.db, { prompt, allowExternalText: true,
        allowExternalVisual: true, libraryIds: [], mediaTypes: ['image'] })
      await testDb.db.insert(agentRerankRuns).values({ id: randomUUID(), agentRunId: run.id,
        attemptNo: 1, completionStatus: 'succeeded', protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
        maxCostCny: String(AGENT_RERANK_POLICY.maximumCostCny) })
      runs.push(run)
    }
    const service = new AgentRerankService(testDb.db, { available: false, rerank: vi.fn() },
      { agentRerankTimeoutMs: 5_000, agentExecutorIntervalMs: 60_000 }, { createEvidence: vi.fn() } as never)
    await service.tick(runs[1]!.id)
    expect((await service.getForAgentRun(runs[0]!.id))?.status).toBe('preparing_evidence')
    expect((await service.getForAgentRun(runs[1]!.id))?.status).toBe('failed')
  })

  test('保留 RRF Top-20，并保存独立的 Rerank Top-10', async () => {
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
      .set({ status: 'ranking', nextStep: 'reranking' })
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

    await testDb.db.insert(agentRerankRuns).values({
      id: randomUUID(),
      agentRunId: run.id,
      attemptNo: 1,
      completionStatus: 'succeeded',
      protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
      maxCostCny: String(AGENT_RERANK_POLICY.maximumCostCny),
    })

    const provider: AgentRerankProvider = {
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

    const started = await service.getForAgentRun(run.id)
    expect(started?.status).toBe('preparing_evidence')
    // 追加额度前必须给出可审查的实际请求摘要；预检不能提前派发或改变任务状态。
    const preflight = await service.preflightForAgentRun(run.id)
    expect(preflight).toMatchObject({ model: 'qwen3-vl-rerank', query: '找一个人抱着一束花',
      candidate_count: 20, external_calls: 0, maximum_estimated_cost_cny: 0.216 })
    expect(preflight.request_bytes).toBeGreaterThan(0)
    expect(preflight.request_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(preflight.evidence_sha256).toHaveLength(20)
    expect(provider.rerank).not.toHaveBeenCalled()
    expect((await service.getForAgentRun(run.id))?.status).toBe('preparing_evidence')
    expect(JSON.stringify(preflight)).not.toContain(fixtureDirectory)
    expect(JSON.stringify(preflight)).not.toContain('image_base64')
    await service.tick()
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
    await testDb.db
      .update(agentRuns)
      .set({ status: 'ranking', nextStep: 'reranking' })
      .where(eq(agentRuns.id, run.id))
    await testDb.db.insert(agentRerankRuns).values({
      id: rerankRunId,
      agentRunId: run.id,
      attemptNo: 1,
      completionStatus: 'succeeded',
      protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
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
    await expect(
      testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'outcome_unknown',
        errorCode: 'AGENT_RERANK_OUTCOME_UNKNOWN_AFTER_RESTART',
      }),
    ])
    service.onModuleDestroy()
  })
})

describe('Rerank 证据压缩与预算', () => {
  test('预算按画面数权重分配：9 帧拼图约为 1 帧的 9 倍，序列化总量不超安全线', () => {
    // 回归 2026-08-18 的 413 失败：20 张 PNG 共 23.15MB 被百炼网关拒收。
    // 预算分配必须保证“权重求和 × 4/3(Base64 膨胀)+ JSON 骨架”永远低于安全线。
    const query = '找一个人抱着一束花'
    const budgets = planEvidenceBudgets([1, 9], query)
    expect(Math.abs(budgets[1]! - budgets[0]! * 9)).toBeLessThanOrEqual(9)

    const skeleton = 8_192 + Buffer.byteLength(query, 'utf8')
    const worstCaseBody = Math.ceil(budgets.reduce((sum, b) => sum + b, 0) * (4 / 3)) + skeleton
    expect(worstCaseBody).toBeLessThanOrEqual(RERANK_SAFE_REQUEST_BYTES)
  })

  test('压缩循环逐级降尺寸，输出 JPEG 且压进预算', async () => {
    // 高斯噪声 PNG 约 1.27MB，JPEG q85 原尺寸约 225KB；给 100KB 预算时
    // 前几档都放不下，循环必须降尺寸档才能返回（实测落在约 83KB 的中间档），
    // 证明预算机制真的会驱动降尺寸，而不是只在最终失败。
    const noisyPng = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        // sharp 类型定义要求 create 必带 background；noise 存在时运行时会忽略它。
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer()
    const encoded = await encodeEvidenceWithinBudget(noisyPng, 100_000)
    // JPEG 文件头固定为 FF D8；PNG 是 89 50，借此证明格式已切换。
    expect(encoded[0]).toBe(0xff)
    expect(encoded[1]).toBe(0xd8)
    expect(encoded.byteLength).toBeLessThanOrEqual(100_000)
  })

  test('最小尺寸档仍超预算时返回最小档结果，把裁决留给总量硬校验', async () => {
    const noisyPng = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        // sharp 类型定义要求 create 必带 background；noise 存在时运行时会忽略它。
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer()
    const encoded = await encodeEvidenceWithinBudget(noisyPng, 1)
    expect(encoded[0]).toBe(0xff)
    expect(encoded[1]).toBe(0xd8)
    expect(encoded.byteLength).toBeGreaterThan(1)
  })

  test('20 张噪声图完整跑通：外发的是 JPEG，序列化总量低于安全线', async () => {
    testDb = await createTestDatabase()
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'stars-agent-rerank-jpeg-'))
    const libraryId = randomUUID()
    await testDb.db.insert(libraries).values({
      id: libraryId,
      name: 'rerank jpeg fixture',
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
      .set({ status: 'ranking', nextStep: 'reranking' })
      .where(eq(agentRuns.id, run.id))

    // 每张约 1.27MB 的噪声 PNG：若按旧逻辑外发 PNG，总量约 25MB，必然 413。
    const noisyPng = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        // sharp 类型定义要求 create 必带 background；noise 存在时运行时会忽略它。
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer()
    for (let rank = 1; rank <= 20; rank += 1) {
      const fileId = randomUUID()
      const assetId = randomUUID()
      const path = join(fixtureDirectory, `${rank}.png`)
      await writeFile(path, noisyPng)
      await testDb.db.insert(mediaFiles).values({
        id: fileId,
        libraryId,
        path,
        relativePath: `${rank}.png`,
        mediaType: 'image',
        sizeBytes: noisyPng.byteLength,
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

    await testDb.db.insert(agentRerankRuns).values({
      id: randomUUID(),
      agentRunId: run.id,
      attemptNo: 1,
      completionStatus: 'succeeded',
      protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
      maxCostCny: String(AGENT_RERANK_POLICY.maximumCostCny),
    })

    const provider: AgentRerankProvider = {
      available: true,
      rerank: vi.fn().mockResolvedValue({
        response: {
          results: Array.from({ length: 10 }, (_, offset) => ({
            index: offset,
            relevance_score: 1 - offset / 10,
          })),
        },
        providerRequestId: 'fake-jpeg-request',
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

    await service.tick()
    await vi.waitFor(
      async () => {
        expect((await service.getForAgentRun(run.id))?.status).toBe('succeeded')
      },
      { timeout: 10_000 },
    )

    const rerankCall = vi.mocked(provider.rerank).mock.calls[0]!
    for (const document of rerankCall[0].documents) {
      const bytes = Buffer.from(document.image_base64, 'base64')
      expect(bytes[0]).toBe(0xff)
      expect(bytes[1]).toBe(0xd8)
    }
    const [storedRun] = await testDb.db
      .select({ requestBytes: agentRerankRuns.requestBytes })
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.agentRunId, run.id))
    expect(storedRun!.requestBytes!).toBeLessThanOrEqual(RERANK_SAFE_REQUEST_BYTES)
    service.onModuleDestroy()
  })
})
