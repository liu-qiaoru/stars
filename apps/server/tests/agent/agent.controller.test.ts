import { Test } from '@nestjs/testing'
import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentController } from '../../src/agent/agent.controller.js'
import { AgentModule } from '../../src/agent/agent.module.js'
import {
  claimNextAgentRun,
  markAgentExternalCallDispatched,
  recoverExpiredAgentRuns,
} from '../../src/agent/agent-run.repository.js'
import { AGENT_STEP_HANDLER, type AgentStepHandler } from '../../src/agent/agent.types.js'
import { SETTINGS, type Settings } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import { agentRunInputs, agentRuns } from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

let closeDb: () => Promise<void>
let closeModule: () => Promise<void>
let agentController: AgentController
let db: Awaited<ReturnType<typeof createTestDatabase>>['db']

const prepareStep = vi.fn<AgentStepHandler['prepare']>()

function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    serverHost: '127.0.0.1',
    serverPort: 4000,
    databaseUrl: 'postgres://user:pass@localhost:5432/media_agent_test',
    qdrantUrl: 'http://localhost:6333',
    modelServiceUrl: 'http://127.0.0.1:4020',
    modelServiceTimeoutMs: 10000,
    allowExternalLlm: false,
    anthropicApiKey: undefined,
    agentModel: 'disabled',
    agentMaxSteps: 4,
    agentToolTimeoutMs: 10000,
    rightCodeBaseUrl: undefined,
    rightCodeApiKey: undefined,
    agentExecutorEnabled: false,
    agentExecutorIntervalMs: 2000,
    agentLeaseDurationMs: 130000,
    agentActivityTimeoutMs: 120000,
    agentWaitingTtlSeconds: 604800,
    jobCoordinatorEnabled: false,
    jobCoordinatorIntervalMs: 5000,
    jobCoordinatorEmbeddingLimit: 100,
    queryExpansionProvider: 'none',
    queryExpansionTimeoutMs: 10000,
    queryExpansionMaxVariants: 3,
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekApiKey: undefined,
    deepseekModel: 'deepseek-v4-flash',
    captionIndexingEnabled: false,
    captionSearchEnabled: false,
    localVlmEnabled: false,
    localVlmServiceUrl: 'http://127.0.0.1:4030',
    searchRerankMode: 'off',
    searchRerankTopK: 10,
    searchRerankTimeoutMs: 30000,
    frameCacheEnabled: false,
    frameCacheMaxBytes: 1073741824,
    frameCacheImageMaxWidth: 512,
    ...overrides,
  }
}

async function compileAgentModule(
  settings = testSettings(),
  handler: AgentStepHandler = {
    isReady: () => false,
    prepare: prepareStep,
  },
) {
  const testDb = await createTestDatabase()
  db = testDb.db
  closeDb = testDb.close
  prepareStep.mockReset()

  const moduleRef = await Test.createTestingModule({ imports: [AgentModule] })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(settings)
    .overrideProvider(AGENT_STEP_HANDLER)
    .useValue(handler)
    .compile()

  agentController = moduleRef.get(AgentController)
  closeModule = () => moduleRef.close()
}

async function closeCurrentModule() {
  await closeModule?.()
  await closeDb?.()
}

afterEach(closeCurrentModule)

describe('Agent V1 Phase A API', () => {
  beforeEach(async () => {
    await compileAgentModule()
  })

  test('Phase B 处理器或 RightAPI 未就绪时，capabilities 明确不可用且创建前拒绝', async () => {
    expect(agentController.getCapabilities()).toMatchObject({
      phase: 'A',
      provider: 'rightapi',
      model: 'qwen3.7-plus',
      run_creation_available: false,
      external_text: {
        deployment_enabled: false,
        configured: false,
        step_handler_ready: false,
      },
      external_visual: { available: false },
    })

    await expect(
      agentController.createRun({
        prompt: '找红色汽车的视频',
        allow_external_text: true,
      }),
    ).rejects.toMatchObject({ status: 503 })
    const [{ total }] = await db.select({ total: count() }).from(agentRuns)
    expect(total).toBe(0)
  })

  test('请求不符合 Agent Schema 时返回 400，不把客户端输入错误包装成 500', async () => {
    await expect(
      agentController.createRun({ prompt: '', allow_external_text: true }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('能力就绪时创建接口只持久化并立即返回 queued，不同步执行步骤', async () => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => true, prepare: prepareStep }
    await compileAgentModule(
      testSettings({
        allowExternalLlm: true,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
        agentExecutorEnabled: true,
      }),
      handler,
    )

    const created = await agentController.createRun({
      prompt: '找红汽车的视频',
      allow_external_text: true,
      allow_external_visual: false,
      media_types: ['video'],
    })

    expect(created).toMatchObject({ run_id: expect.any(String), status: 'queued' })
    expect(prepareStep).not.toHaveBeenCalled()
    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      id: created.run_id,
      status: 'queued',
      next_step: 'extracting_intent',
      authorization: {
        allow_external_text: true,
        allow_external_visual: false,
      },
      steps: [],
    })
  })

  test('resume 事务校验等待步骤并对重复 client_request_id 只保存一次输入', async () => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => true, prepare: prepareStep }
    await compileAgentModule(
      testSettings({
        allowExternalLlm: true,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
        agentExecutorEnabled: true,
      }),
      handler,
    )
    const created = await agentController.createRun({
      prompt: '找视频',
      allow_external_text: true,
    })
    const waitingStepId = '11111111-1111-4111-8111-111111111111'
    await db
      .update(agentRuns)
      .set({
        status: 'waiting_for_user_input',
        nextStep: 'searching',
        waitingStepId,
        waitingExpiresAt: new Date('2026-08-19T00:00:00.000Z'),
      })
      .where(eq(agentRuns.id, created.run_id))
    const input = {
      waiting_step_id: waitingStepId,
      client_request_id: 'resume-001',
      response: '搜索全部已授权素材库',
    }

    const first = await agentController.resumeRun(created.run_id, input)
    const duplicate = await agentController.resumeRun(created.run_id, input)

    expect(first).toMatchObject({ run_id: created.run_id, status: 'queued' })
    expect(duplicate).toEqual(first)
    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      status: 'queued',
      next_step: 'searching',
    })
    // 幂等键只能重放相同动作；复用同一键指向另一个等待步骤必须显式冲突，
    // 否则客户端会误以为新的澄清内容已经保存。
    await expect(
      agentController.resumeRun(created.run_id, {
        ...input,
        waiting_step_id: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ status: 409 })
    const [{ total }] = await db
      .select({ total: count() })
      .from(agentRunInputs)
      .where(eq(agentRunInputs.runId, created.run_id))
    expect(total).toBe(1)
  })

  test('澄清等待超过 waiting_expires_at 后明确进入 expired，不会静默重新排队', async () => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => true, prepare: prepareStep }
    await compileAgentModule(
      testSettings({
        allowExternalLlm: true,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
        agentExecutorEnabled: true,
      }),
      handler,
    )
    const created = await agentController.createRun({
      prompt: '找视频',
      allow_external_text: true,
    })
    const waitingStepId = '22222222-2222-4222-8222-222222222222'
    await db
      .update(agentRuns)
      .set({
        status: 'waiting_for_user_input',
        nextStep: 'searching',
        waitingStepId,
        waitingExpiresAt: new Date('2026-08-11T00:00:00.000Z'),
      })
      .where(eq(agentRuns.id, created.run_id))

    await expect(
      agentController.resumeRun(created.run_id, {
        waiting_step_id: waitingStepId,
        client_request_id: 'resume-expired',
        response: '搜索全部素材库',
      }),
    ).rejects.toMatchObject({ status: 410 })
    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      status: 'expired',
      error: { code: 'AGENT_WAITING_EXPIRED' },
    })
  })

  test('cancel 在 queued 安全边界直接结束，且不会调用步骤处理器', async () => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => true, prepare: prepareStep }
    await compileAgentModule(
      testSettings({
        allowExternalLlm: true,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
        agentExecutorEnabled: true,
      }),
      handler,
    )
    const created = await agentController.createRun({
      prompt: '找视频',
      allow_external_text: true,
    })

    await expect(
      agentController.cancelRun(created.run_id, {
        client_request_id: 'cancel-001',
        reason: '用户不再需要',
      }),
    ).resolves.toMatchObject({ status: 'cancelled' })
    expect(prepareStep).not.toHaveBeenCalled()
  })

  test('outcome_unknown 只能通过独立幂等入口重新排队', async () => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => true, prepare: prepareStep }
    await compileAgentModule(
      testSettings({
        allowExternalLlm: true,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
        agentExecutorEnabled: true,
        agentLeaseDurationMs: 5000,
      }),
      handler,
    )
    const created = await agentController.createRun({
      prompt: '找视频',
      allow_external_text: true,
    })
    const startedAt = new Date(Date.now() + 1_000)
    const claim = await claimNextAgentRun(db, {
      leaseOwner: 'server-a',
      leaseDurationMs: 5000,
      now: startedAt,
    })
    await markAgentExternalCallDispatched(
      db,
      {
        runId: created.run_id,
        leaseOwner: 'server-a',
        leaseVersion: claim!.run.leaseVersion,
        stepAttemptId: claim!.step.stepAttemptId,
        currentStatus: 'extracting_intent',
        inputFingerprint: 'sha256:test',
      },
      startedAt,
    )
    await recoverExpiredAgentRuns(db, new Date(startedAt.getTime() + 6_000))
    const input = {
      step_attempt_id: claim!.step.stepAttemptId,
      client_request_id: 'retry-001',
    }

    const first = await agentController.retryUnknown(created.run_id, input)
    const duplicate = await agentController.retryUnknown(created.run_id, input)

    expect(first).toMatchObject({ run_id: created.run_id, status: 'queued' })
    expect(duplicate).toEqual(first)
    const [{ total }] = await db
      .select({ total: count() })
      .from(agentRunInputs)
      .where(eq(agentRunInputs.runId, created.run_id))
    expect(total).toBe(1)
  })
})
