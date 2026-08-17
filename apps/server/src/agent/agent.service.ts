import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  agentExportSelectionInputSchema,
  cancelAgentRunInputSchema,
  confirmAgentExportInputSchema,
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
  confirmAgentExport,
  createDurableAgentRun,
  getDurableAgentRun,
  resumeWaitingAgentRun,
  retryUnknownAgentRun,
  selectAgentExport,
} from './agent-run.repository.js'
import { agentSideEffects, agentToolCalls, jobs } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { AGENT_STEP_HANDLER, type AgentStepHandler } from './agent.types.js'
import { AgentRuntimeConfigService } from './agent-runtime-config.service.js'
import { AgentRerankService } from './agent-rerank.service.js'

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
    @Optional() private readonly runtimeConfig?: AgentRuntimeConfigService,
    @Optional() private readonly rerankService?: AgentRerankService,
  ) {}

  getCapabilities() {
    const deploymentEnabled = this.settings.allowExternalLlm
    const configured = Boolean(this.settings.rightCodeBaseUrl && this.settings.rightCodeApiKey)
    const runtimeEnabled =
      this.runtimeConfig?.values().enabled ?? this.settings.agentExecutorEnabled
    const stepHandlerReady = runtimeEnabled && this.stepHandler.isReady()
    const runCreationAvailable = deploymentEnabled && configured && stepHandlerReady
    const unavailableReasons: string[] = []
    if (!deploymentEnabled) unavailableReasons.push('external_text_deployment_disabled')
    if (!configured) unavailableReasons.push('rightapi_not_configured')
    if (!stepHandlerReady) unavailableReasons.push('agent_executor_or_step_handler_not_ready')

    return {
      // Agent 固定意图/检索协议仍是 Phase C；Rerank 是可选后处理，不改写主 run 协议。
      phase: 'C',
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
      external_visual: {
        deployment_enabled: this.settings.agentRerankProvider === 'dashscope',
        configured: Boolean(this.settings.dashscopeWorkspaceId && this.settings.dashscopeApiKey),
        available: this.rerankService?.available ?? false,
        allowed_fields: ['full_user_query', 'rrf_top20_derived_pngs'],
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
        message: 'Agent V1 外部文本能力或 Server 执行器未就绪。',
        reasons: capabilities.unavailable_reasons,
      })
    }
    if (!parsed.allow_external_text) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_TEXT_AUTHORIZATION_REQUIRED',
        message: '创建 Agent V1 run 前必须授权发送本次用户输入。',
      })
    }
    if (parsed.allow_external_visual && !this.rerankService?.available) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_VISUAL_NOT_AVAILABLE',
        message: '产品 Rerank 未启用，不能接受本次视觉外发授权。',
      })
    }
    if (parsed.allow_external_visual && parsed.media_types.some((type) => type === 'audio')) {
      throw new BadRequestException({
        code: 'AGENT_RERANK_VISUAL_SCOPE_REQUIRED',
        message: '开启 Rerank 时媒体范围只能包含 image 和 video。',
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
    const toolCalls = await this.db
      .select()
      .from(agentToolCalls)
      .where(eq(agentToolCalls.runId, runId))
    const [exportFact] = await this.db
      .select({
        jobId: agentSideEffects.jobId,
        status: agentSideEffects.status,
        confirmation: agentSideEffects.confirmationJson,
        jobStatus: jobs.status,
        jobProgress: jobs.progress,
        jobResult: jobs.resultJson,
        jobError: jobs.errorMessage,
      })
      .from(agentSideEffects)
      .leftJoin(jobs, eq(agentSideEffects.jobId, jobs.id))
      .where(eq(agentSideEffects.runId, runId))
      .limit(1)
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
        review_status: 'not_run',
        // Phase C 没有 VLM 条件复核；检索召回不能证明 must-have/exclusion 成立。
        unverified_condition_ids: parsedConditions.success
          ? parsedConditions.data.map((condition) => condition.condition_id)
          : [],
      })),
      tool_calls: toolCalls.map((toolCall) => ({
        tool_call_id: toolCall.toolCallId,
        name: toolCall.toolName,
        status: toolCall.status,
        summary:
          toolCall.toolName === 'export_clip'
            ? '已由 Server 校验的剪辑导出预览'
            : toolCall.toolName,
        requires_confirmation: toolCall.requiresConfirmation && !toolCall.confirmedAt,
        preview: toolCall.inputJson,
      })),
      export_job: exportFact?.jobId
        ? {
            id: exportFact.jobId,
            status: exportFact.jobStatus,
            progress: exportFact.jobProgress,
            result: exportFact.jobResult,
            error_message: exportFact.jobError,
          }
        : null,
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

  async exportSelection(runId: string, input: z.input<typeof agentExportSelectionInputSchema>) {
    const parsed = this.parseInput(agentExportSelectionInputSchema, input)
    const result = await selectAgentExport(this.db, {
      runId,
      candidateKey: parsed.candidate_key,
      startTimeSeconds: parsed.start_time_seconds,
      endTimeSeconds: parsed.end_time_seconds,
      outputFormat: parsed.output_format,
      waitingTtlSeconds:
        this.runtimeConfig?.values().waiting_ttl_seconds ?? this.settings.agentWaitingTtlSeconds,
    })
    if (result.kind === 'not_found') throw new NotFoundException('Agent run not found')
    if (result.kind === 'expired') {
      throw new GoneException({ code: 'AGENT_WAITING_EXPIRED', message: '候选选择已过期。' })
    }
    if (result.kind === 'stale') {
      throw new ConflictException({
        code: 'AGENT_CANDIDATE_STALE',
        message: '候选 generation 已过期。',
      })
    }
    if (result.kind === 'scope_invalid') {
      throw new ConflictException({
        code: 'AGENT_ENFORCED_SCOPE_INVALID',
        message: '候选不再属于 Server 范围。',
      })
    }
    if (result.kind === 'range_invalid' || result.kind === 'candidate_invalid') {
      throw new BadRequestException({
        code: 'AGENT_EXPORT_SELECTION_INVALID',
        message: '导出候选或时间范围无效。',
      })
    }
    if (result.kind === 'invalid_state') {
      throw new ConflictException({
        code: 'AGENT_EXPORT_SELECTION_REJECTED',
        message: 'run 当前不能选择导出候选。',
      })
    }
    return {
      run_id: runId,
      status: result.run.status,
      waiting_step_id: result.waitingStepId,
      tool_call_id: result.toolCallId,
      preview: result.preview,
    }
  }

  async confirmExport(runId: string, input: z.input<typeof confirmAgentExportInputSchema>) {
    const parsed = this.parseInput(confirmAgentExportInputSchema, input)
    const result = await confirmAgentExport(this.db, {
      runId,
      waitingStepId: parsed.waiting_step_id,
      toolCallId: parsed.tool_call_id,
      clientRequestId: parsed.client_request_id,
    })
    if (result.kind === 'not_found') throw new NotFoundException('Agent run not found')
    if (result.kind === 'expired') {
      throw new GoneException({ code: 'AGENT_WAITING_EXPIRED', message: '导出确认已过期。' })
    }
    if (result.kind === 'stale') {
      throw new ConflictException({
        code: 'AGENT_CANDIDATE_STALE',
        message: '候选 generation 已过期。',
      })
    }
    if (result.kind === 'scope_invalid' || result.kind === 'invalid_state') {
      throw new ConflictException({
        code: 'AGENT_CONFIRM_REJECTED',
        message: '确认条件守卫未通过。',
      })
    }
    return { job_id: result.job.id, status: result.job.status, run_status: 'succeeded' }
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
