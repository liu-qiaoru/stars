import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  cancelAgentRunInputSchema,
  createAgentRunInputSchema,
  resumeAgentRunInputSchema,
  retryUnknownAgentRunInputSchema,
  agentIntentSchema,
} from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  cancelDurableAgentRun,
  createDurableAgentRun,
  getDurableAgentRun,
  resumeWaitingAgentRun,
  retryUnknownAgentRun,
} from './agent-run.repository.js'
import { AGENT_STEP_HANDLER, type AgentStepHandler } from './agent.types.js'

const persistedAgentConditionSchema = z
  .object({
    condition_id: z.string().uuid(),
    source_text: z.string(),
    normalized_source_text: z.string(),
    kind: z.enum(['must_have', 'optional', 'exclusion']),
    evidence_type: z.enum(['visual', 'spoken', 'metadata', 'unknown']),
  })
  .strict()

const persistedResolvedScopeSchema = z
  .object({
    search_scope: z.enum(['visual', 'spoken', 'all']),
    media_types: z.array(z.enum(['image', 'video', 'audio'])),
    library_ids: z.array(z.string().uuid()),
  })
  .strict()

/**
 * Agent V1 的 HTTP 用例层。创建接口只校验授权并持久化 queued run；真正的
 * RightAPI 意图识别和本地 SearchService 搜索由后台执行器异步完成。
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AGENT_STEP_HANDLER) private readonly stepHandler: AgentStepHandler,
  ) {}

  getCapabilities() {
    const deploymentEnabled = this.settings.allowExternalLlm
    const configured = Boolean(this.settings.rightCodeBaseUrl && this.settings.rightCodeApiKey)
    const stepHandlerReady = this.settings.agentExecutorEnabled && this.stepHandler.isReady()
    const runCreationAvailable = deploymentEnabled && configured && stepHandlerReady
    const unavailableReasons: string[] = []
    if (!deploymentEnabled) unavailableReasons.push('external_text_deployment_disabled')
    if (!configured) unavailableReasons.push('rightapi_not_configured')
    if (!stepHandlerReady) unavailableReasons.push('phase_b_step_handler_not_ready')

    return {
      phase: 'B',
      provider: 'rightapi',
      model: 'qwen3.7-plus',
      run_creation_available: runCreationAvailable,
      external_text: {
        deployment_enabled: deploymentEnabled,
        configured,
        step_handler_ready: stepHandlerReady,
        available: runCreationAvailable,
        allowed_fields: ['user_prompt', 'deidentified_capability_boundary'],
      },
      // 视觉授权只是数据库协议的独立字段；Phase B 没有任何发图入口。
      external_visual: {
        deployment_enabled: false,
        configured: false,
        available: false,
        allowed_fields: [],
      },
      unavailable_reasons: unavailableReasons,
    }
  }

  async createRun(input: z.input<typeof createAgentRunInputSchema>) {
    const parsed = this.parseInput(createAgentRunInputSchema, input)
    const capabilities = this.getCapabilities()
    if (!capabilities.run_creation_available) {
      throw new ServiceUnavailableException({
        code: 'AGENT_V1_UNAVAILABLE',
        message: 'Agent V1 外部文本能力或 Phase B 步骤处理器未就绪。',
        reasons: capabilities.unavailable_reasons,
      })
    }
    if (!parsed.allow_external_text) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_TEXT_AUTHORIZATION_REQUIRED',
        message: '创建 Agent V1 run 前必须授权发送本次用户输入。',
      })
    }
    if (parsed.allow_external_visual) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_VISUAL_NOT_AVAILABLE',
        message: 'Phase B 不接收视觉外发授权，也不会发送候选图片。',
      })
    }
    if (parsed.media_types.includes('document')) {
      throw new BadRequestException({
        code: 'AGENT_MEDIA_SCOPE_UNSUPPORTED',
        message: 'Phase B 只支持 image、video 和 audio 检索，不能创建 document run。',
      })
    }

    const run = await createDurableAgentRun(this.db, {
      prompt: parsed.prompt,
      allowExternalText: parsed.allow_external_text,
      allowExternalVisual: parsed.allow_external_visual,
      libraryIds: parsed.library_ids,
      mediaTypes: parsed.media_types,
    })
    return { run_id: run.id, status: run.status }
  }

  async getRun(runId: string) {
    const value = await getDurableAgentRun(this.db, runId)
    if (!value) throw new NotFoundException('Agent run not found')
    const { run, authorization, steps, events, candidates } = value
    const committedIntent = [...steps]
      .reverse()
      .find(
        (step) => step.stepKind === 'extracting_intent' && step.status === 'completed',
      )?.outputJson
    const intentRecord =
      committedIntent && typeof committedIntent === 'object'
        ? (committedIntent as Record<string, unknown>)
        : undefined
    const parsedIntent = agentIntentSchema.safeParse(intentRecord?.intent)
    const parsedConditions = z
      .array(persistedAgentConditionSchema)
      .safeParse(intentRecord?.conditions)
    const parsedResolvedScope = persistedResolvedScopeSchema.safeParse(intentRecord?.enforced_scope)
    return {
      id: run.id,
      status: run.status,
      next_step: run.nextStep,
      prompt: run.prompt,
      summary: run.summary,
      enforced_scope: run.enforcedScopeJson,
      lease_version: run.leaseVersion,
      attempt_count: run.attemptCount,
      waiting_step_id: run.waitingStepId,
      waiting_expires_at: run.waitingExpiresAt?.toISOString() ?? null,
      error:
        run.errorCode && run.errorMessage
          ? { code: run.errorCode, message: run.errorMessage }
          : null,
      intent: parsedIntent.success ? parsedIntent.data : null,
      conditions: parsedConditions.success ? parsedConditions.data : [],
      resolved_scope: parsedResolvedScope.success ? parsedResolvedScope.data : null,
      authorization: authorization
        ? {
            allow_external_text: authorization.allowExternalText,
            allow_external_visual: authorization.allowExternalVisual,
            granted_at: authorization.grantedAt.toISOString(),
          }
        : null,
      steps: steps.map((step) => ({
        step_attempt_id: step.stepAttemptId,
        step: step.stepKind,
        status: step.status,
        external_call_status: step.externalCallStatus,
        input_fingerprint: step.inputFingerprint,
        started_at: step.startedAt.toISOString(),
        finished_at: step.finishedAt?.toISOString() ?? null,
      })),
      candidates: candidates.map((candidate) => ({
        candidate_key: candidate.candidateKey,
        file_id: candidate.fileId,
        file_generation: candidate.fileGeneration,
        asset_id: candidate.assetId,
        scene_id: candidate.sceneId,
        scene_start_seconds:
          candidate.sceneStartSeconds !== null ? Number(candidate.sceneStartSeconds) : null,
        scene_end_seconds:
          candidate.sceneEndSeconds !== null ? Number(candidate.sceneEndSeconds) : null,
        rank: candidate.rank,
        retrieval: candidate.retrievalJson,
      })),
      events: events.map((event) => ({
        event_id: event.id,
        type: event.eventType,
        tool_call_id: event.toolCallId,
        created_at: event.createdAt.toISOString(),
        payload: event.payloadJson,
      })),
      created_at: run.createdAt.toISOString(),
      updated_at: run.updatedAt.toISOString(),
      finished_at: run.finishedAt?.toISOString() ?? null,
    }
  }

  async resumeRun(runId: string, input: z.input<typeof resumeAgentRunInputSchema>) {
    const parsed = this.parseInput(resumeAgentRunInputSchema, input)
    const result = await resumeWaitingAgentRun(this.db, {
      runId,
      waitingStepId: parsed.waiting_step_id,
      clientRequestId: parsed.client_request_id,
      response: parsed.response,
    })
    return this.userInputResult(runId, result, 'AGENT_RESUME_REJECTED')
  }

  async cancelRun(runId: string, input: z.input<typeof cancelAgentRunInputSchema>) {
    const parsed = this.parseInput(cancelAgentRunInputSchema, input)
    const result = await cancelDurableAgentRun(this.db, {
      runId,
      clientRequestId: parsed.client_request_id,
      reason: parsed.reason,
    })
    return this.userInputResult(runId, result, 'AGENT_CANCEL_REJECTED')
  }

  async retryUnknown(runId: string, input: z.input<typeof retryUnknownAgentRunInputSchema>) {
    const parsed = this.parseInput(retryUnknownAgentRunInputSchema, input)
    const result = await retryUnknownAgentRun(this.db, {
      runId,
      stepAttemptId: parsed.step_attempt_id,
      clientRequestId: parsed.client_request_id,
    })
    return this.userInputResult(runId, result, 'AGENT_UNKNOWN_RETRY_REJECTED')
  }

  private userInputResult(
    runId: string,
    result:
      | { kind: 'accepted' | 'duplicate'; run: { status: string } }
      | { kind: 'not_found' | 'invalid_state' | 'step_mismatch' | 'expired' },
    errorCode: string,
  ) {
    if (result.kind === 'not_found') throw new NotFoundException('Agent run not found')
    if (result.kind === 'expired') {
      throw new GoneException({ code: 'AGENT_WAITING_EXPIRED', message: 'Agent 等待步骤已过期。' })
    }
    if (result.kind === 'invalid_state' || result.kind === 'step_mismatch') {
      throw new ConflictException({
        code: errorCode,
        message: 'Agent run 当前状态或步骤身份与请求不匹配。',
      })
    }
    if ('run' in result) {
      return { run_id: runId, status: result.run.status }
    }
    throw new Error(`Unhandled Agent input result: ${result.kind}`)
  }

  private parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
    const parsed = schema.safeParse(input)
    if (parsed.success) return parsed.data
    throw new BadRequestException({
      code: 'AGENT_INVALID_REQUEST',
      message: 'Agent 请求不符合协议。',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
}
