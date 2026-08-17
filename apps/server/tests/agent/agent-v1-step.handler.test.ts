import { eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import { AgentExecutorService } from '../../src/agent/agent-executor.service.js'
import { AgentService } from '../../src/agent/agent.service.js'
import {
  claimNextAgentRun,
  createDurableAgentRun,
  markAgentExternalCallDispatched,
  recoverExpiredAgentRuns,
  resumeWaitingAgentRun,
  retryUnknownAgentRun,
} from '../../src/agent/agent-run.repository.js'
import { AgentV1StepHandler } from '../../src/agent/agent-v1-step.handler.js'
import {
  AgentIntentRunnerError,
  type AgentIntentRunner,
} from '../../src/agent/qwen-agent-intent.runner.js'
import { createSettings } from '../../src/config/settings.js'
import {
  agentRunCandidates,
  agentRunAuthorizations,
  agentRunSteps,
  agentRuns,
  libraries,
  mediaAssets,
  mediaFiles,
  videoScenes,
} from '../../src/database/schema.js'
import type { SearchService } from '../../src/search/search.service.js'
import { createTestDatabase } from '../database/test-db.js'

function settings() {
  return createSettings({
    DATABASE_URL: 'postgres://test:test@localhost/test',
    QDRANT_URL: 'http://localhost:6333',
    ALLOW_EXTERNAL_LLM: 'true',
    RIGHT_CODE_BASE_URL: 'https://right.example.test/v1',
    RIGHT_CODE_API_KEY: 'test-key',
    AGENT_EXECUTOR_ENABLED: 'true',
    AGENT_LEASE_DURATION_MS: '130000',
  })
}

function validatedIntent(input: {
  searchScope: 'visual' | 'spoken' | 'all'
  mediaTypes?: Array<'image' | 'video' | 'audio' | 'document'>
  libraryReferences?: string[]
}) {
  return {
    intent: {
      goal: 'search' as const,
      search_scope: input.searchScope,
      media_types: input.mediaTypes ?? [],
      library_references: input.libraryReferences ?? [],
      conditions: [],
      needs_clarification: false,
      clarification_reason: null as string | null,
      requested_effect: null,
    },
    conditions: [],
    provider: {
      model: 'qwen3.7-plus',
      prompt_version: 'agent-intent-v1',
      schema_version: 'agent-intent-schema-v1',
      request_id: 'msg_test',
      input_tokens: 100,
      output_tokens: 80,
    },
  }
}

describe('AgentV1StepHandler', () => {
  test('后台派发前重新核对逐 run 文本授权，授权损坏时 Provider 调用为 0', async () => {
    const testDb = await createTestDatabase()
    try {
      const extract = vi.fn()
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:unauthorized',
        extract,
      }
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search: vi.fn(),
      } as unknown as SearchService)
      const startedAt = new Date('2026-08-12T03:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      // 模拟异步执行前授权事实被撤销或损坏；Executor 必须在 dispatched 前快速失败。
      await testDb.db
        .update(agentRunAuthorizations)
        .set({ allowExternalText: false, textScopeJson: { fields: [] } })
        .where(eq(agentRunAuthorizations.runId, run.id))

      await new AgentExecutorService(testDb.db, settings(), handler).runOnce(startedAt)

      expect(extract).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'failed',
          errorCode: 'AGENT_EXTERNAL_TEXT_AUTHORIZATION_INVALID',
        }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('普通 run 只识别一次意图并用完整原文搜索一次，随后冻结完整候选身份与证据', async () => {
    const testDb = await createTestDatabase()
    try {
      const libraryId = '11111111-1111-4111-8111-111111111111'
      const fileId = '22222222-2222-4222-8222-222222222222'
      const sceneId = '33333333-3333-4333-8333-333333333333'
      const assetId = '44444444-4444-4444-8444-444444444444'
      await testDb.db.insert(libraries).values({
        id: libraryId,
        name: '旅行素材',
        rootPath: '/test/travel',
      })
      await testDb.db.insert(mediaFiles).values({
        id: fileId,
        libraryId,
        path: '/test/travel/bridge.mp4',
        relativePath: 'bridge.mp4',
        mediaType: 'video',
        sizeBytes: 123,
        mtimeMs: 456,
        indexStatus: 'indexed',
        indexGeneration: 7,
      })
      await testDb.db.insert(videoScenes).values({
        id: sceneId,
        fileId,
        sceneKey: 'scene-001',
        startTimeSeconds: '12.5',
        endTimeSeconds: '19.75',
        detectionStrategy: 'pyscenedetect-v1',
        strategyFingerprint: 'sha256:test',
        indexGeneration: 7,
      })
      await testDb.db.insert(mediaAssets).values({
        id: assetId,
        fileId,
        assetType: 'video_frame',
        sceneId,
        frameTimeSeconds: '15',
      })

      const extract = vi.fn(async () => ({
        intent: {
          goal: 'search' as const,
          search_scope: 'visual' as const,
          media_types: ['video' as const],
          library_references: ['旅行素材'],
          conditions: [
            {
              source_text: '红色汽车',
              kind: 'must_have' as const,
              evidence_type: 'visual' as const,
            },
          ],
          needs_clarification: false,
          clarification_reason: null,
          requested_effect: null,
        },
        conditions: [
          {
            source_text: '红色汽车',
            normalized_source_text: '红色汽车',
            kind: 'must_have' as const,
            evidence_type: 'visual' as const,
          },
        ],
        provider: {
          model: 'qwen3.7-plus',
          prompt_version: 'agent-intent-v1',
          schema_version: 'agent-intent-schema-v1',
          request_id: 'msg_test',
          input_tokens: 100,
          output_tokens: 80,
        },
      }))
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:intent-input',
        extract,
      }
      const search = vi.fn(async () => ({
        limit: 20,
        offset: 0,
        groups: [],
        results: [
          {
            asset_id: assetId,
            merged_asset_ids: [assetId],
            file_id: fileId,
            media_type: 'video',
            path: 'bridge.mp4',
            start_time_seconds: 12.5,
            end_time_seconds: 19.75,
            scene_id: sceneId,
            best_frame_time_seconds: 15,
            score: 0.0325,
            score_kind: 'rrf_score' as const,
            primary_reason: 'vector_match' as const,
            reasons: ['vector_match' as const, 'caption_match' as const],
            source_scores: { video_frame_vectors: 0.81, caption_text_vectors: 0.72 },
          },
        ],
      }))
      const searchService = { search } as unknown as SearchService
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, searchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const prompt = '请在旅行素材里找红色汽车经过桥下的视频'
      const startedAt = new Date('2026-08-12T04:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt,
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [libraryId],
          mediaTypes: ['video'],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)
      // 用新执行器实例模拟 Server 在 AgentIntent 已提交后重启；搜索步骤必须只读取
      // PostgreSQL 的最后提交状态，不能依赖旧进程内存或再次调用 Provider。
      const restartedExecutor = new AgentExecutorService(testDb.db, settings(), handler)
      await restartedExecutor.runOnce(new Date(startedAt.getTime() + 1_000))

      expect(extract).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith({
        query: prompt,
        query_expansion_mode: 'original',
        ranking_mode: 'rrf',
        search_scope: 'visual',
        media_types: ['video'],
        library_ids: [libraryId],
        limit: 20,
        offset: 0,
        include_diagnostics: false,
      })
      await expect(
        testDb.db.select().from(agentRunCandidates).where(eq(agentRunCandidates.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          candidateKey: `video:${sceneId}`,
          fileId,
          fileGeneration: 7,
          assetId,
          sceneId,
          sceneStartSeconds: '12.5',
          sceneEndSeconds: '19.75',
          rank: 1,
          retrievalJson: {
            media_type: 'video',
            score: 0.0325,
            score_kind: 'rrf_score',
            primary_reason: 'vector_match',
            reasons: ['vector_match', 'caption_match'],
            source_scores: { video_frame_vectors: 0.81, caption_text_vectors: 0.72 },
            best_frame_time_seconds: 15,
          },
        }),
      ])
      const api = new AgentService(testDb.db, settings(), handler)
      await expect(api.getRun(run.id)).resolves.toMatchObject({
        status: 'succeeded',
        intent: expect.objectContaining({ search_scope: 'visual', media_types: ['video'] }),
        conditions: [
          expect.objectContaining({
            condition_id: expect.any(String),
            source_text: '红色汽车',
            normalized_source_text: '红色汽车',
          }),
        ],
        resolved_scope: {
          search_scope: 'visual',
          media_types: ['video'],
          library_ids: [libraryId],
        },
        candidates: [
          expect.objectContaining({
            file_id: fileId,
            file_generation: 7,
            asset_id: assetId,
            scene_id: sceneId,
            rank: 1,
            retrieval: expect.objectContaining({ score_kind: 'rrf_score' }),
          }),
        ],
      })
    } finally {
      await testDb.close()
    }
  })

  test('明确导出意图在搜索后等待用户选择，不把候选阶段误报为 succeeded', async () => {
    const testDb = await createTestDatabase()
    try {
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:export-intent',
        extract: vi.fn(async () => ({
          ...validatedIntent({ searchScope: 'visual', mediaTypes: ['video'] }),
          intent: {
            ...validatedIntent({ searchScope: 'visual', mediaTypes: ['video'] }).intent,
            goal: 'export_clip' as const,
            requested_effect: { type: 'export_clip' as const },
          },
        })),
      }
      const search = vi.fn(async () => ({ limit: 20, offset: 0, groups: [], results: [] }))
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const startedAt = new Date('2026-08-12T04:30:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找视频并导出片段',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )

      await new AgentExecutorService(testDb.db, settings(), handler).runOnce(startedAt)
      await new AgentExecutorService(testDb.db, settings(), handler).runOnce(
        new Date(startedAt.getTime() + 1_000),
      )

      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'waiting_for_export_selection',
          waitingStepId: expect.any(String),
          waitingExpiresAt: expect.any(Date),
        }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test('真实澄清链只有固定动作能把歧义覆盖为只读搜索，且不二次识别意图', async () => {
    const testDb = await createTestDatabase()
    try {
      const extract = vi.fn(async () => {
        const result = validatedIntent({ searchScope: 'all' })
        result.intent.needs_clarification = true
        result.intent.clarification_reason = '目标可能包含导出副作用'
        return result
      })
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:clarification',
        extract,
      }
      const search = vi.fn(async () => ({ results: [], groups: [], limit: 20, offset: 0 }))
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T04:30:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '处理一下这些素材',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: [],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)
      const [waiting] = await testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
      expect(waiting).toMatchObject({ status: 'waiting_for_user_input' })
      await expect(
        retryUnknownAgentRun(testDb.db, {
          runId: run.id,
          stepAttemptId: '11111111-1111-4111-8111-111111111111',
          clientRequestId: 'wrong-endpoint',
        }),
      ).resolves.toMatchObject({ kind: 'invalid_state' })
      await expect(
        resumeWaitingAgentRun(
          testDb.db,
          {
            runId: run.id,
            waitingStepId: waiting!.waitingStepId!,
            clientRequestId: 'clarify-read-only',
            response: 'continue_as_read_only_search_with_resolved_scope',
          },
          new Date(startedAt.getTime() + 500),
        ),
      ).resolves.toMatchObject({ kind: 'accepted' })
      await executor.runOnce(new Date(startedAt.getTime() + 1_000))

      expect(extract).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledTimes(1)
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([expect.objectContaining({ status: 'succeeded' })])
    } finally {
      await testDb.close()
    }
  })

  test('Provider 超时后不自动重放；显式 retry-unknown 才创建新尝试并再次调用', async () => {
    const testDb = await createTestDatabase()
    try {
      const extract = vi.fn(async () => {
        if (extract.mock.calls.length === 1) {
          throw new AgentIntentRunnerError(
            'AGENT_INTENT_OUTCOME_UNKNOWN',
            'RightAPI 请求已派发，但结果不明。',
            true,
          )
        }
        return validatedIntent({ searchScope: 'visual', mediaTypes: ['video'] })
      })
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:timeout-input',
        extract,
      }
      const search = vi.fn(async () => ({ results: [], groups: [], limit: 20, offset: 0 }))
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T05:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找红色汽车视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)
      await executor.runOnce(new Date(startedAt.getTime() + 1_000))

      expect(extract).toHaveBeenCalledTimes(1)
      expect(search).not.toHaveBeenCalled()
      const [stored] = await testDb.db
        .select()
        .from(agentRunCandidates)
        .where(eq(agentRunCandidates.runId, run.id))
      expect(stored).toBeUndefined()
      const [storedRun] = await testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
      expect(storedRun).toMatchObject({
        status: 'outcome_unknown',
        externalCallStatus: 'outcome_unknown',
        errorCode: 'AGENT_INTENT_OUTCOME_UNKNOWN',
      })

      const [unknownStep] = await testDb.db
        .select()
        .from(agentRunSteps)
        .where(eq(agentRunSteps.runId, run.id))
      await expect(
        retryUnknownAgentRun(
          testDb.db,
          {
            runId: run.id,
            stepAttemptId: unknownStep!.stepAttemptId,
            clientRequestId: 'retry-phase-b-001',
          },
          new Date(startedAt.getTime() + 1_500),
        ),
      ).resolves.toMatchObject({ kind: 'accepted', run: { status: 'queued' } })

      await executor.runOnce(new Date(startedAt.getTime() + 2_000))
      await executor.runOnce(new Date(startedAt.getTime() + 3_000))

      expect(extract).toHaveBeenCalledTimes(2)
      expect(search).toHaveBeenCalledTimes(1)
      const steps = await testDb.db
        .select()
        .from(agentRunSteps)
        .where(eq(agentRunSteps.runId, run.id))
      expect(steps).toHaveLength(3)
      expect(steps[1]!.stepAttemptId).not.toBe(unknownStep!.stepAttemptId)
      expect(steps.map((step) => step.status)).toEqual([
        'outcome_unknown',
        'completed',
        'completed',
      ])
    } finally {
      await testDb.close()
    }
  })

  test('Provider 已调用但进程在提交前崩溃时，租约恢复后不会自动再次调用', async () => {
    const testDb = await createTestDatabase()
    try {
      const extract = vi.fn(async () =>
        validatedIntent({ searchScope: 'visual', mediaTypes: ['video'] }),
      )
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:crash-after-dispatch',
        extract,
      }
      const search = vi.fn()
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const startedAt = new Date('2026-08-12T05:30:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const claim = await claimNextAgentRun(testDb.db, {
        leaseOwner: 'crashed-server',
        leaseDurationMs: 1_000,
        now: startedAt,
      })
      const prepared = await handler.prepare({
        runId: run.id,
        prompt: run.prompt,
        step: 'extracting_intent',
        stepAttemptId: claim!.step.stepAttemptId,
        leaseOwner: 'crashed-server',
        leaseVersion: claim!.run.leaseVersion,
        enforcedScope: run.enforcedScopeJson,
      })
      await markAgentExternalCallDispatched(
        testDb.db,
        {
          runId: run.id,
          leaseOwner: 'crashed-server',
          leaseVersion: claim!.run.leaseVersion,
          stepAttemptId: claim!.step.stepAttemptId,
          currentStatus: 'extracting_intent',
          inputFingerprint: prepared.inputFingerprint!,
        },
        startedAt,
      )
      // Provider 已返回，但模拟进程在 commitAgentStep 前退出；结果只存在旧进程内存中。
      await prepared.execute()
      expect(extract).toHaveBeenCalledTimes(1)

      await recoverExpiredAgentRuns(testDb.db, new Date(startedAt.getTime() + 2_000))
      await new AgentExecutorService(testDb.db, settings(), handler).runOnce(
        new Date(startedAt.getTime() + 3_000),
      )

      expect(extract).toHaveBeenCalledTimes(1)
      expect(search).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([expect.objectContaining({ status: 'outcome_unknown' })])
    } finally {
      await testDb.close()
    }
  })

  test.each([
    ['visual', ['image', 'video']],
    ['spoken', ['audio', 'video']],
    ['all', ['image', 'video', 'audio']],
  ] as const)('%s 范围映射为固定的 SearchService 媒体通道', async (scope, mediaTypes) => {
    const testDb = await createTestDatabase()
    try {
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => `sha256:${scope}`,
        extract: vi.fn(async () => validatedIntent({ searchScope: scope })),
      }
      const search = vi.fn(async () => ({ results: [], groups: [], limit: 20, offset: 0 }))
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T06:00:00.000Z')
      await createDurableAgentRun(
        testDb.db,
        {
          prompt: `测试 ${scope}`,
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: [],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)
      await executor.runOnce(new Date(startedAt.getTime() + 1_000))

      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ search_scope: scope, media_types: mediaTypes }),
      )
    } finally {
      await testDb.close()
    }
  })

  test('模型扩大 Server 保存的媒体范围时明确失败且搜索次数为 0', async () => {
    const testDb = await createTestDatabase()
    try {
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:expanded-media',
        extract: vi.fn(async () =>
          validatedIntent({ searchScope: 'all', mediaTypes: ['image', 'video'] }),
        ),
      }
      const search = vi.fn()
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T07:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '只在视频里找内容',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)

      expect(search).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([expect.objectContaining({ status: 'failed' })])
    } finally {
      await testDb.close()
    }
  })

  test('模型 spoken 与 Server image 硬范围不相容时明确失败', async () => {
    const testDb = await createTestDatabase()
    try {
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:incompatible-scope',
        extract: vi.fn(async () => validatedIntent({ searchScope: 'spoken' })),
      }
      const search = vi.fn()
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const startedAt = new Date('2026-08-12T07:30:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '在图片里找说话内容',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: ['image'],
        },
        startedAt,
      )

      await new AgentExecutorService(testDb.db, settings(), handler).runOnce(startedAt)

      expect(search).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({ status: 'failed', errorCode: 'AGENT_MEDIA_SCOPE_INVALID' }),
      ])
    } finally {
      await testDb.close()
    }
  })

  test.each([
    ['不存在', []],
    ['重名', ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666']],
  ])('模型引用%s素材库时明确失败且不猜测', async (_case, libraryIds) => {
    const testDb = await createTestDatabase()
    try {
      for (const [index, libraryId] of libraryIds.entries()) {
        await testDb.db.insert(libraries).values({
          id: libraryId,
          name: '同名素材',
          rootPath: `/test/duplicate-${index}`,
        })
      }
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:library-reference',
        extract: vi.fn(async () =>
          validatedIntent({ searchScope: 'visual', libraryReferences: ['同名素材'] }),
        ),
      }
      const search = vi.fn()
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T08:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '在同名素材里找视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [],
          mediaTypes: [],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)

      expect(search).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([expect.objectContaining({ status: 'failed' })])
    } finally {
      await testDb.close()
    }
  })

  test('模型把素材库扩大到 Server enforced_scope 之外时明确失败', async () => {
    const testDb = await createTestDatabase()
    try {
      const allowedLibraryId = '77777777-7777-4777-8777-777777777777'
      const outsideLibraryId = '88888888-8888-4888-8888-888888888888'
      await testDb.db.insert(libraries).values([
        { id: allowedLibraryId, name: '允许素材', rootPath: '/test/allowed' },
        { id: outsideLibraryId, name: '越权素材', rootPath: '/test/outside' },
      ])
      const runner: AgentIntentRunner = {
        isReady: () => true,
        fingerprint: () => 'sha256:outside-library',
        extract: vi.fn(async () =>
          validatedIntent({ searchScope: 'visual', libraryReferences: ['越权素材'] }),
        ),
      }
      const search = vi.fn()
      const handler = new AgentV1StepHandler(testDb.db, settings(), runner, {
        search,
      } as unknown as SearchService)
      const executor = new AgentExecutorService(testDb.db, settings(), handler)
      const startedAt = new Date('2026-08-12T09:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '去越权素材里找视频',
          allowExternalText: true,
          allowExternalVisual: false,
          libraryIds: [allowedLibraryId],
          mediaTypes: [],
        },
        startedAt,
      )

      await executor.runOnce(startedAt)

      expect(search).not.toHaveBeenCalled()
      await expect(
        testDb.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({ status: 'failed', errorCode: 'AGENT_ENFORCED_SCOPE_EXCEEDED' }),
      ])
    } finally {
      await testDb.close()
    }
  })
})
