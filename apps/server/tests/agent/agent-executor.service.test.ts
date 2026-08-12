import { eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import { AgentExecutorService } from '../../src/agent/agent-executor.service.js'
import { claimNextAgentRun, createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import type { AgentStepHandler } from '../../src/agent/agent.types.js'
import { createSettings } from '../../src/config/settings.js'
import { agentRunSteps, agentRuns } from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

function executorSettings() {
  return createSettings({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
    QDRANT_URL: 'http://localhost:6333',
    ALLOW_EXTERNAL_LLM: 'true',
    RIGHT_CODE_BASE_URL: 'https://right.example.test',
    RIGHT_CODE_API_KEY: 'test-key',
    AGENT_EXECUTOR_ENABLED: 'true',
    AGENT_LEASE_DURATION_MS: '130000',
  })
}

describe('AgentExecutorService', () => {
  test('Server 重启后新执行器从最后已提交状态继续，不重做上一步', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找发布会视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const firstHandler: AgentStepHandler = {
        isReady: () => true,
        prepare: vi.fn(async ({ step }) => ({
          external: false,
          execute: async () => ({
            transition: { status: 'searching' as const, nextStep: 'searching' as const },
            outputJson: { completed_step: step },
          }),
        })),
      }
      const firstProcess = new AgentExecutorService(testDb.db, executorSettings(), firstHandler)
      await firstProcess.runOnce(startedAt)

      // 用新实例模拟旧 Server 进程退出后重启；新实例没有上一步的内存上下文。
      const secondHandler: AgentStepHandler = {
        isReady: () => true,
        prepare: vi.fn(async ({ step }) => ({
          external: false,
          execute: async () => ({
            transition: { status: 'succeeded' as const },
            outputJson: { completed_step: step },
          }),
        })),
      }
      const restartedProcess = new AgentExecutorService(
        testDb.db,
        executorSettings(),
        secondHandler,
      )
      await restartedProcess.runOnce(new Date(startedAt.getTime() + 1_000))

      expect(firstHandler.prepare).toHaveBeenCalledTimes(1)
      expect(secondHandler.prepare).toHaveBeenCalledTimes(1)
      expect(secondHandler.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id, step: 'searching' }),
      )
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([expect.objectContaining({ status: 'succeeded', attemptCount: 2 })])
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({ externalCallStatus: 'not_dispatched', status: 'completed' }),
        expect.objectContaining({ externalCallStatus: 'not_dispatched', status: 'completed' }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('外部步骤开始等待响应时，dispatched 和输入指纹已在短事务中提交', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找红汽车视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      let releaseExternalCall!: () => void
      const externalCallStarted = new Promise<void>((resolveStarted) => {
        releaseExternalCall = resolveStarted
      })
      let signalExecuteStarted!: () => void
      const executeStarted = new Promise<void>((resolve) => {
        signalExecuteStarted = resolve
      })
      const handler: AgentStepHandler = {
        isReady: () => true,
        prepare: async () => ({
          external: true,
          inputFingerprint: 'sha256:frozen-input',
          execute: async () => {
            signalExecuteStarted()
            await externalCallStarted
            return {
              transition: { status: 'searching', nextStep: 'searching' },
              outputJson: { intent: 'validated' },
            }
          },
        }),
      }
      const executor = new AgentExecutorService(testDb.db, executorSettings(), handler)
      const running = executor.runOnce(startedAt)
      await executeStarted

      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'extracting_intent',
          externalCallStatus: 'dispatched',
        }),
      ])
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          externalCallStatus: 'dispatched',
          inputFingerprint: 'sha256:frozen-input',
        }),
      ])

      releaseExternalCall()
      await running
    } finally {
      await testDb.close()
    }
  })

  test('纯本地活动步骤超过硬上限后原子进入 timed_out，迟到结果失去写权', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找发布会视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      await claimNextAgentRun(testDb.db, {
        leaseOwner: 'stalled-server',
        leaseDurationMs: 130_000,
        now: startedAt,
      })
      const handler: AgentStepHandler = {
        isReady: () => true,
        prepare: vi.fn(),
      }
      const executor = new AgentExecutorService(testDb.db, executorSettings(), handler)

      await executor.runOnce(new Date(startedAt.getTime() + 120_001))

      expect(handler.prepare).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'timed_out',
          leaseOwner: null,
          errorCode: 'AGENT_ACTIVITY_TIMED_OUT',
        }),
      ])
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({ status: 'timed_out', errorCode: 'AGENT_ACTIVITY_TIMED_OUT' }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('同一执行器的本地 execute 挂起时也会在硬上限结束，迟到完成不覆盖终态', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-12T01:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找发布会视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      let releaseLocalCall!: () => void
      const localCall = new Promise<void>((resolve) => {
        releaseLocalCall = resolve
      })
      const handler: AgentStepHandler = {
        isReady: () => true,
        prepare: async () => ({
          external: false,
          execute: async () => {
            await localCall
            return {
              transition: { status: 'searching' as const, nextStep: 'searching' as const },
              outputJson: { result: 'too-late' },
            }
          },
        }),
      }
      const settings = { ...executorSettings(), agentActivityTimeoutMs: 20 }
      const executor = new AgentExecutorService(testDb.db, settings, handler)

      await executor.runOnce(startedAt)
      releaseLocalCall()
      await new Promise((resolve) => setTimeout(resolve, 0))

      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'timed_out',
          errorCode: 'AGENT_ACTIVITY_TIMED_OUT',
        }),
      ])
      await expect(
        testDb.db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'timed_out',
          outputJson: null,
          externalCallStatus: 'not_dispatched',
        }),
      ])
    } finally {
      await testDb.close()
    }
  })
})
