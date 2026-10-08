import { describe, expect, test } from 'vitest'
import {
  claimNextAgentRun,
  cancelDurableAgentRun,
  commitAgentStep,
  createDurableAgentRun,
  markAgentExternalCallDispatched,
  finalizeCancelledAgentRuns,
  recoverExpiredAgentRuns,
} from '../../src/agent/agent-run.repository.js'
import {
  agentRunAuthorizations,
  agentRunCandidates,
  agentRunEvents,
  agentRunSteps,
  agentRuns,
  agentRerankRuns,
} from '../../src/database/schema.js'
import { AGENT_RERANK_POLICY } from '../../src/agent/agent-rerank.policy.js'
import { createTestDatabase } from '../database/test-db.js'
import { count, eq } from 'drizzle-orm'

describe('Agent run 租约仓库', () => {
  test('创建 run 时原子保存排队状态、单 run 授权和开始事件', async () => {
    const testDb = await createTestDatabase()
    try {
      const createdAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '帮我找红色汽车的视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        createdAt,
      )

      expect(run).toMatchObject({
        status: 'queued',
        nextStep: 'extracting_intent',
        leaseOwner: null,
        leaseVersion: 0,
        attemptCount: 0,
      })
      await expect(
        testDb.db
          .select()
          .from(agentRunAuthorizations)
          .where(eq(agentRunAuthorizations.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          allowExternalText: true,
          allowExternalVisual: false,
        }),
      ])
      await expect(
        testDb.db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          eventType: 'run_queued',
        }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('两个执行器并发领取时只有一个获得新租约和步骤尝试', async () => {
    const testDb = await createTestDatabase()
    try {
      const now = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找发布会视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        now,
      )

      const claims = await Promise.all([
        claimNextAgentRun(testDb.db, { leaseOwner: 'server-a', leaseDurationMs: 30_000, now }),
        claimNextAgentRun(testDb.db, { leaseOwner: 'server-b', leaseDurationMs: 30_000, now }),
      ])
      const successful = claims.filter((claim) => claim !== undefined)

      expect(successful).toHaveLength(1)
      expect(successful[0]).toMatchObject({
        run: {
          id: run.id,
          status: 'extracting_intent',
          leaseVersion: 1,
          attemptCount: 1,
        },
        step: {
          stepKind: 'extracting_intent',
          status: 'running',
          externalCallStatus: 'not_dispatched',
        },
      })
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toHaveLength(1)
    } finally {
      await testDb.close()
    }
  })

  test('租约过期被接管后，旧 lease_version 的迟到结果无法写入', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找海边视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const first = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-a',
        leaseDurationMs: 1_000,
        now: startedAt,
      })
      expect(first).toBeDefined()

      const takeoverAt = new Date('2026-08-12T01:00:02.000Z')
      const second = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-b',
        leaseDurationMs: 30_000,
        now: takeoverAt,
      })
      expect(second?.run.leaseVersion).toBe(2)

      const late = await commitAgentStep(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'server-a',
          leaseVersion: first!.run.leaseVersion,
          stepAttemptId: first!.step.stepAttemptId,
          currentStatus: 'extracting_intent',
          transition: { status: 'searching', nextStep: 'searching' },
          outputJson: { intent: 'stale' },
          candidates: [
            {
              candidateKey: 'video:33333333-3333-4333-8333-333333333333',
              fileId: '11111111-1111-4111-8111-111111111111',
              fileGeneration: 1,
              assetId: '22222222-2222-4222-8222-222222222222',
              sceneId: '33333333-3333-4333-8333-333333333333',
              sceneStartSeconds: 0,
              sceneEndSeconds: 1,
              rank: 1,
              retrievalJson: { score: 1 },
            },
          ],
        },
        takeoverAt,
      )
      expect(late).toBeUndefined()
      const [{ total: staleCandidateCount }] = await testDb.db
        .select({ total: count() })
        .from(agentRunCandidates)
        .where(eq(agentRunCandidates.runId, run.id))
      expect(staleCandidateCount).toBe(0)

      const committed = await commitAgentStep(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'server-b',
          leaseVersion: second!.run.leaseVersion,
          stepAttemptId: second!.step.stepAttemptId,
          currentStatus: 'extracting_intent',
          transition: { status: 'searching', nextStep: 'searching' },
          outputJson: { intent: 'current' },
        },
        takeoverAt,
      )
      expect(committed).toMatchObject({ status: 'searching', leaseOwner: null })
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          stepAttemptId: first!.step.stepAttemptId,
          status: 'lease_expired',
        }),
        expect.objectContaining({
          stepAttemptId: second!.step.stepAttemptId,
          status: 'completed',
        }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('搜索提交会原子冻结候选、创建产品 Rerank 尝试并进入 ranking', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-21T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找海边日落的视频',
          allowExternalText: true,
          allowExternalVisual: true,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const intentClaim = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-a',
        leaseDurationMs: 30_000,
        now: startedAt,
      })
      await commitAgentStep(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'server-a',
          leaseVersion: intentClaim!.run.leaseVersion,
          stepAttemptId: intentClaim!.step.stepAttemptId,
          currentStatus: 'extracting_intent',
          transition: { status: 'searching', nextStep: 'searching' },
          outputJson: { intent: 'search' },
        },
        startedAt,
      )
      const searchClaim = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-a',
        leaseDurationMs: 30_000,
        now: new Date(startedAt.getTime() + 1),
      })

      const committed = await commitAgentStep(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'server-a',
          leaseVersion: searchClaim!.run.leaseVersion,
          stepAttemptId: searchClaim!.step.stepAttemptId,
          currentStatus: 'searching',
          transition: { status: 'ranking', nextStep: 'reranking' },
          outputJson: { candidate_count: 1 },
          candidates: [
            {
              candidateKey: 'video:33333333-3333-4333-8333-333333333333',
              fileId: '11111111-1111-4111-8111-111111111111',
              fileGeneration: 1,
              assetId: '22222222-2222-4222-8222-222222222222',
              sceneId: '33333333-3333-4333-8333-333333333333',
              sceneStartSeconds: 10,
              sceneEndSeconds: 20,
              rank: 1,
              retrievalJson: { rrf_score: 0.0328 },
            },
          ],
          rerankAttempt: {
            attemptNo: 1,
            completionStatus: 'succeeded',
            protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
            maxCostCny: AGENT_RERANK_POLICY.maximumCostCny,
          },
        },
        new Date(startedAt.getTime() + 2),
      )

      expect(committed).toMatchObject({ status: 'ranking', nextStep: 'reranking' })
      await expect(
        testDb.db.select().from(agentRunCandidates).where(eq(agentRunCandidates.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({ candidateKey: 'video:33333333-3333-4333-8333-333333333333' }),
      ])
      await expect(
        testDb.db.select().from(agentRerankRuns).where(eq(agentRerankRuns.agentRunId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          attemptNo: 1,
          completionStatus: 'succeeded',
          status: 'preparing_evidence',
          externalCallStatus: 'not_dispatched',
        }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('外部请求已派发但结果不明时，过期恢复进入 outcome_unknown', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找红色汽车',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: [],
        },
        startedAt,
      )
      const claim = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-a',
        leaseDurationMs: 1_000,
        now: startedAt,
      })
      await markAgentExternalCallDispatched(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'server-a',
          leaseVersion: claim!.run.leaseVersion,
          stepAttemptId: claim!.step.stepAttemptId,
          currentStatus: 'extracting_intent',
          inputFingerprint: 'sha256:test-input',
        },
        startedAt,
      )

      const recovered = await recoverExpiredAgentRuns(
        testDb.db,
        new Date('2026-08-12T01:00:02.000Z'),
      )

      expect(recovered).toEqual({ requeued: 0, outcomeUnknown: 1 })
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'outcome_unknown',
          leaseOwner: null,
          externalCallStatus: 'outcome_unknown',
          errorCode: 'AGENT_EXTERNAL_OUTCOME_UNKNOWN',
        }),
      ])
      expect(
        await claimNextAgentRun(testDb.db, {
          leaseOwner: 'server-b',
          leaseDurationMs: 30_000,
          now: new Date('2026-08-12T01:00:03.000Z'),
        }),
      ).toBeUndefined()
    } finally {
      await testDb.close()
    }
  })

  test('活动步骤取消后旧结果失去写权，租约到期后进入 cancelled', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找海边视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const claim = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'server-a',
        leaseDurationMs: 1_000,
        now: startedAt,
      })
      await expect(
        cancelDurableAgentRun(
          testDb.db,
          { runId: run.id, clientRequestId: 'cancel-active', reason: '用户停止' },
          new Date(startedAt.getTime() + 100),
        ),
      ).resolves.toMatchObject({ kind: 'accepted', run: { status: 'cancel_requested' } })

      await expect(
        commitAgentStep(
          testDb.db,
          {
            runId: run.id,
            leaseOwner: 'server-a',
            leaseVersion: claim!.run.leaseVersion,
            stepAttemptId: claim!.step.stepAttemptId,
            currentStatus: 'extracting_intent',
            transition: { status: 'searching', nextStep: 'searching' },
            outputJson: { stale: true },
          },
          new Date(startedAt.getTime() + 200),
        ),
      ).resolves.toBeUndefined()

      expect(
        await finalizeCancelledAgentRuns(testDb.db, new Date(startedAt.getTime() + 1_100)),
      ).toBe(1)
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'cancelled',
          leaseOwner: null,
          finishedAt: expect.any(Date),
        }),
      ])
    } finally {
      await testDb.close()
    }
  })
})
