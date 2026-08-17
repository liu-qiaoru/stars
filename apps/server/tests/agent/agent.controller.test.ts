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
import {
  agentRunCandidates,
  agentRunInputs,
  agentRuns,
  agentSideEffects,
  agentToolCalls,
  jobs,
  libraries,
  mediaAssets,
  mediaFiles,
  videoScenes,
} from '../../src/database/schema.js'
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
    agentWebPollIntervalMs: 2000,
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

async function seedExportCandidate(runId: string) {
  const libraryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const sceneId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const assetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  await db.insert(libraries).values({
    id: libraryId,
    name: '导出素材库',
    rootPath: '/media',
  })
  await db.insert(mediaFiles).values({
    id: fileId,
    libraryId,
    path: '/media/source.mp4',
    relativePath: 'source.mp4',
    mediaType: 'video',
    sizeBytes: 100,
    mtimeMs: 100,
    durationSeconds: '60',
    indexGeneration: 3,
  })
  await db.insert(videoScenes).values({
    id: sceneId,
    fileId,
    sceneKey: 'scene-1',
    startTimeSeconds: '10',
    endTimeSeconds: '30',
    detectionStrategy: 'fixture',
    strategyFingerprint: 'fixture-v1',
    indexGeneration: 3,
  })
  await db.insert(mediaAssets).values({
    id: assetId,
    fileId,
    assetType: 'video_frame',
    sceneId,
    frameTimeSeconds: '15',
  })
  await db.insert(agentRunCandidates).values({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    runId,
    candidateKey: `video:${sceneId}`,
    fileId,
    fileGeneration: 3,
    assetId,
    sceneId,
    sceneStartSeconds: '10',
    sceneEndSeconds: '30',
    rank: 1,
    retrievalJson: {
      score: 0.031,
      score_kind: 'rrf_score',
      reasons: ['vector_match'],
      review_status: 'not_run',
    },
  })
  await db
    .update(agentRuns)
    .set({
      status: 'waiting_for_export_selection',
      enforcedScopeJson: { library_ids: [libraryId], media_types: ['video'] },
      waitingStepId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      waitingExpiresAt: new Date('2026-08-19T00:00:00.000Z'),
    })
    .where(eq(agentRuns.id, runId))
  return { libraryId, fileId, sceneId, assetId, candidateKey: `video:${sceneId}` }
}

afterEach(closeCurrentModule)

describe('Agent V1 API', () => {
  beforeEach(async () => {
    await compileAgentModule()
  })

  test('Phase B 处理器或 RightAPI 未就绪时，capabilities 明确不可用且创建前拒绝', async () => {
    expect(agentController.getCapabilities()).toMatchObject({
      phase: 'C',
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

  test('设置 API 只读展示冻结协议和 Key 配置状态，保存 allowlist 并校验租约关系', async () => {
    await closeCurrentModule()
    await compileAgentModule(
      testSettings({
        rightCodeBaseUrl: 'https://secret-provider.example.test',
        rightCodeApiKey: 'super-secret-key',
      }),
    )

    const initial = agentController.getSettings()
    expect(initial).toMatchObject({
      provider: 'rightapi',
      model: 'qwen3.7-plus',
      prompt_version: 'agent-intent-v1',
      schema_version: 'agent-intent-schema-v1',
      api_key: { configured: true },
      frozen: { provider: true, model: true, provider_url_editable: false },
    })
    expect(JSON.stringify(initial)).not.toContain('super-secret-key')
    expect(JSON.stringify(initial)).not.toContain('secret-provider.example.test')

    expect(
      agentController.saveSettings({
        enabled: true,
        tool_timeout_ms: 20_000,
        lease_duration_ms: 35_000,
        activity_timeout_ms: 30_000,
        waiting_ttl_seconds: 86_400,
        executor_interval_ms: 2_000,
        web_poll_interval_ms: 2_500,
      }),
    ).toMatchObject({ editable: { enabled: true, web_poll_interval_ms: 2_500 } })
    expect(agentController.getSettings()).toMatchObject({
      editable: { enabled: true, web_poll_interval_ms: 2_500 },
    })
    expect(() =>
      agentController.saveSettings({
        enabled: true,
        tool_timeout_ms: 20_000,
        lease_duration_ms: 34_999,
        activity_timeout_ms: 30_000,
        waiting_ttl_seconds: 86_400,
        executor_interval_ms: 2_000,
        web_poll_interval_ms: 2_500,
      }),
    ).toThrow('Agent 运行配置不符合 Server allowlist。')
    expect(() =>
      agentController.saveSettings({
        ...initial.editable,
        arbitrary_provider_url: 'https://attacker.invalid',
      } as never),
    ).toThrow('Agent 运行配置不符合 Server allowlist。')
  })

  test.each([
    [
      '部署开关关闭',
      {
        allowExternalLlm: false,
        rightCodeBaseUrl: 'https://right.example.test',
        rightCodeApiKey: 'test-key',
      },
    ],
    [
      'RightAPI 缺少配置',
      { allowExternalLlm: true, rightCodeBaseUrl: undefined, rightCodeApiKey: undefined },
    ],
  ])('%s 时在创建 run 前拒绝，数据库写入为 0', async (_case, overrides) => {
    await closeCurrentModule()
    const handler: AgentStepHandler = { isReady: () => false, prepare: prepareStep }
    await compileAgentModule(testSettings({ ...overrides, agentExecutorEnabled: true }), handler)

    await expect(
      agentController.createRun({ prompt: '找视频', allow_external_text: true }),
    ).rejects.toMatchObject({ status: 503 })
    const [{ total }] = await db.select({ total: count() }).from(agentRuns)
    expect(total).toBe(0)
  })

  test('未授予本次外部文本授权时在创建 run 前拒绝，数据库写入为 0', async () => {
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

    await expect(
      agentController.createRun({ prompt: '找视频', allow_external_text: false }),
    ).rejects.toMatchObject({ status: 400 })
    const [{ total }] = await db.select({ total: count() }).from(agentRuns)
    expect(total).toBe(0)
  })

  test('Phase B 不支持 document 媒体范围时在创建 run 前拒绝', async () => {
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

    await expect(
      agentController.createRun({
        prompt: '找文档',
        allow_external_text: true,
        media_types: ['document'],
      }),
    ).rejects.toMatchObject({ status: 400 })
    const [{ total }] = await db.select({ total: count() }).from(agentRuns)
    expect(total).toBe(0)
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
      response: 'continue_as_read_only_search_with_resolved_scope',
    } as const

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

  test('resume 在共享 Schema 层拒绝自由文本，不保存也不重新排队', async () => {
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
    const waitingStepId = '99999999-9999-4999-8999-999999999999'
    await db
      .update(agentRuns)
      .set({
        status: 'waiting_for_user_input',
        nextStep: 'searching',
        waitingStepId,
        waitingExpiresAt: new Date('2026-08-19T00:00:00.000Z'),
      })
      .where(eq(agentRuns.id, created.run_id))

    await expect(
      agentController.resumeRun(created.run_id, {
        waiting_step_id: waitingStepId,
        client_request_id: 'resume-free-text',
        response: '随便继续吧',
      } as never),
    ).rejects.toMatchObject({ status: 400 })
    const [{ total }] = await db
      .select({ total: count() })
      .from(agentRunInputs)
      .where(eq(agentRunInputs.runId, created.run_id))
    expect(total).toBe(0)
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
        response: 'continue_as_read_only_search_with_resolved_scope',
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

  test('outcome_unknown 可以由用户幂等放弃并写入明确结束时间', async () => {
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
    await db
      .update(agentRuns)
      .set({
        status: 'outcome_unknown',
        currentStepAttemptId: '11111111-1111-4111-8111-111111111111',
        externalCallStatus: 'outcome_unknown',
        errorCode: 'AGENT_INTENT_OUTCOME_UNKNOWN',
        errorMessage: '请求结果未知',
        finishedAt: null,
      })
      .where(eq(agentRuns.id, created.run_id))
    const input = {
      client_request_id: 'abandon-unknown-001',
      reason: '用户放弃结果未知的任务',
    }

    const first = await agentController.cancelRun(created.run_id, input)
    const duplicate = await agentController.cancelRun(created.run_id, input)

    expect(first).toMatchObject({ run_id: created.run_id, status: 'cancelled' })
    expect(duplicate).toEqual(first)
    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      status: 'cancelled',
      finished_at: expect.any(String),
    })
    const [{ total }] = await db
      .select({ total: count() })
      .from(agentRunInputs)
      .where(eq(agentRunInputs.runId, created.run_id))
    expect(total).toBe(1)
  })

  test('选择当前 run 的视频候选后生成只读预览，并拒绝场景外时间范围', async () => {
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
      prompt: '找出并导出红色汽车片段',
      allow_external_text: true,
      media_types: ['video'],
    })
    const candidate = await seedExportCandidate(created.run_id)
    await db
      .update(agentRuns)
      .set({ enforcedScopeJson: { library_ids: [42], media_types: ['video'] } })
      .where(eq(agentRuns.id, created.run_id))
    await expect(
      agentController.exportSelection(created.run_id, {
        candidate_key: candidate.candidateKey,
        start_time_seconds: 12,
        end_time_seconds: 18,
        output_format: 'mp4',
      }),
    ).rejects.toMatchObject({ status: 409 })
    // createAgentRun 的空 media_types 表示“未额外限制”，与 Phase B resolveScope 的
    // wildcard 语义一致；Phase C 不能把它误读为“禁止视频”。
    await db
      .update(agentRuns)
      .set({ enforcedScopeJson: { library_ids: [], media_types: [] } })
      .where(eq(agentRuns.id, created.run_id))

    await expect(
      agentController.exportSelection(created.run_id, {
        candidate_key: candidate.candidateKey,
        start_time_seconds: 12,
        end_time_seconds: 18,
        output_format: 'mp4',
      }),
    ).resolves.toMatchObject({
      run_id: created.run_id,
      status: 'waiting_for_confirmation',
      waiting_step_id: expect.any(String),
      tool_call_id: expect.any(String),
      preview: {
        file_id: candidate.fileId,
        scene_id: candidate.sceneId,
        start_time_seconds: 12,
        end_time_seconds: 18,
        output_format: 'mp4',
        requires_confirmation: true,
      },
    })

    await db
      .update(agentRuns)
      .set({
        status: 'waiting_for_export_selection',
        waitingStepId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      })
      .where(eq(agentRuns.id, created.run_id))
    await expect(
      agentController.exportSelection(created.run_id, {
        candidate_key: candidate.candidateKey,
        start_time_seconds: 9,
        end_time_seconds: 18,
        output_format: 'mp4',
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('stale generation 阻止选择，重复与并发确认最多创建一个 Job 并返回同一 job_id', async () => {
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
      prompt: '导出汽车片段',
      allow_external_text: true,
      media_types: ['video'],
    })
    const candidate = await seedExportCandidate(created.run_id)
    await db
      .update(mediaFiles)
      .set({ indexGeneration: 4 })
      .where(eq(mediaFiles.id, candidate.fileId))
    await expect(
      agentController.exportSelection(created.run_id, {
        candidate_key: candidate.candidateKey,
        start_time_seconds: 12,
        end_time_seconds: 18,
      }),
    ).rejects.toMatchObject({ status: 409 })

    await db
      .update(mediaFiles)
      .set({ indexGeneration: 3 })
      .where(eq(mediaFiles.id, candidate.fileId))
    const selection = await agentController.exportSelection(created.run_id, {
      candidate_key: candidate.candidateKey,
      start_time_seconds: 12,
      end_time_seconds: 18,
    })
    const confirmation = {
      waiting_step_id: selection.waiting_step_id,
      tool_call_id: selection.tool_call_id,
      client_request_id: 'confirm-export-1',
    }
    // 确认必须重新核对“当前 run 的冻结候选”与预览身份完全一致。仅按
    // candidate_key 找到一行还不够，否则异常数据可能把同一预览指向另一个场景。
    await db
      .update(agentRunCandidates)
      .set({ sceneId: null })
      .where(eq(agentRunCandidates.runId, created.run_id))
    await expect(agentController.confirmExport(created.run_id, confirmation)).rejects.toMatchObject(
      { status: 409 },
    )
    await db
      .update(agentRunCandidates)
      .set({ sceneId: candidate.sceneId })
      .where(eq(agentRunCandidates.runId, created.run_id))

    const [first, concurrentDuplicate] = await Promise.all([
      agentController.confirmExport(created.run_id, confirmation),
      agentController.confirmExport(created.run_id, confirmation),
    ])
    const replay = await agentController.confirmExport(created.run_id, confirmation)

    expect(concurrentDuplicate.job_id).toBe(first.job_id)
    expect(replay.job_id).toBe(first.job_id)
    await expect(
      agentController.confirmExport(created.run_id, {
        ...confirmation,
        waiting_step_id: '11111111-1111-4111-8111-111111111111',
        client_request_id: 'confirm-with-wrong-step',
      }),
    ).rejects.toMatchObject({ status: 409 })
    const [{ jobCount }] = await db.select({ jobCount: count() }).from(jobs)
    const [{ effectCount }] = await db.select({ effectCount: count() }).from(agentSideEffects)
    const [{ toolCount }] = await db.select({ toolCount: count() }).from(agentToolCalls)
    expect({ jobCount, effectCount, toolCount }).toEqual({
      jobCount: 1,
      effectCount: 1,
      toolCount: 1,
    })
    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      status: 'succeeded',
      export_job: { id: first.job_id, status: 'queued' },
    })
  })
})
