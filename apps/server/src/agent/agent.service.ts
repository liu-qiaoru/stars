import { retrievalModel } from './retrieval-model.policy.js'
import { sceneInspectionAuthorized } from './scene-inspection.tool.js'
import { matchedEvidenceAuthorized } from './matched-evidence.tool.js'
import { buildAgentProgress } from './agent-progress.js'
import { SegmentDetailsTool } from './segment-details.tool.js'
import type { RetrievalState } from './retrieval-agent.handler.js'
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
import {
  agentRunTraceSpans,
  agentRerankRankings,
  agentRerankRuns,
  agentSideEffects,
  agentToolCalls,
  jobs,
} from '../database/schema.js'
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
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
    // 开发模式经 tsx(esbuild)转译,不会生成 design:paramtypes 装饰器元数据,
    // NestJS 因此无法“按类型”解析构造参数。可选依赖也必须显式 @Inject 类令牌,
    // 否则 @Optional() 会静默注入 undefined——曾导致已正确配置 DashScope 的
    // Rerank 在 /agent/runs 创建时被误判为“产品 Rerank 未启用”。
    @Optional()
    @Inject(AgentRuntimeConfigService)
    private readonly runtimeConfig?: AgentRuntimeConfigService,
    @Optional()
    @Inject(AgentRerankService)
    private readonly rerankService?: AgentRerankService,
    @Optional()
    @Inject(SegmentDetailsTool)
    private readonly segmentDetails?: SegmentDetailsTool,
  ) {}

  getCapabilities() {
    const deploymentEnabled = this.settings.allowExternalLlm
    const configured = Boolean(this.settings.rightCodeBaseUrl && this.settings.rightCodeApiKey)
    const runtimeEnabled =
      this.runtimeConfig?.values().enabled ?? this.settings.agentExecutorEnabled
    const stepHandlerReady = runtimeEnabled && this.stepHandler.isReady()
    const rerankAvailable = this.rerankService?.available ?? false
    // 多轮文字检索只依赖意图和决策执行器；原有视觉重排在 legacy 创建分支单独校验。
    const runCreationAvailable =
      deploymentEnabled && configured && stepHandlerReady
    const unavailableReasons: string[] = []
    if (!deploymentEnabled) unavailableReasons.push('external_text_deployment_disabled')
    if (!configured) unavailableReasons.push('rightapi_not_configured')
    if (!stepHandlerReady) unavailableReasons.push('agent_executor_or_step_handler_not_ready')
    // 原有视觉重排的可用性独立显示，不再阻止只读文字检索 Agent 创建。

    return {
      provider: 'rightapi',
      model: retrievalModel(this.settings),
      matched_evidence: { available: runCreationAvailable && retrievalModel(this.settings) === 'deepseek-v4-flash' && this.settings.agentRetrievalEvidenceMode === 'matched_multimodal', maximum_candidates: 20, maximum_frames_per_candidate: 1 },
      scene_inspection: { available: runCreationAvailable && retrievalModel(this.settings) === 'deepseek-v4-flash' && Boolean(this.settings.agentSceneInspectionEnabled), provider: 'rightapi', model: 'deepseek-v4-flash', maximum_candidates: 3, maximum_frames_per_candidate: 3 },
      run_creation_available: runCreationAvailable,
      external_text: {
        deployment_enabled: deploymentEnabled,
        configured,
        step_handler_ready: stepHandlerReady,
        available: runCreationAvailable,
        allowed_fields: ['user_prompt', 'deidentified_capability_boundary'],
        optional_separate_authorization: ['retrieval_evidence_text'],
      },
      external_visual: {
        deployment_enabled: this.settings.agentRerankProvider === 'dashscope',
        configured: Boolean(this.settings.dashscopeWorkspaceId && this.settings.dashscopeApiKey),
        available: rerankAvailable,
        allowed_fields: ['full_user_query', 'retrieval_candidate_derived_images'],
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
        message: 'Agent 意图识别、Server 执行器或产品 Rerank 未就绪。',
        reasons: capabilities.unavailable_reasons,
      })
    }
    if (!parsed.allow_external_text) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_TEXT_AUTHORIZATION_REQUIRED',
        message: '创建 Agent V1 run 前必须授权发送本次用户输入。',
      })
    }
    if ((parsed.workflow === 'legacy' && !parsed.allow_external_visual) || (parsed.allow_external_visual && !this.rerankService?.available)) {
      throw new BadRequestException({
        code: 'AGENT_EXTERNAL_VISUAL_AUTHORIZATION_REQUIRED',
        message: '产品检索必须授权发送本次完整查询和候选派生图片用于 Rerank。',
      })
    }
    if (parsed.workflow === 'legacy' && parsed.media_types.some((type) => type === 'audio')) {
      throw new BadRequestException({
        code: 'AGENT_RERANK_VISUAL_SCOPE_REQUIRED',
        message: '当前产品 Rerank 只接受 image 和 video，不能创建 audio 检索。',
      })
    }
    if (parsed.media_types.includes('document')) {
      throw new BadRequestException({
        code: 'AGENT_MEDIA_SCOPE_UNSUPPORTED',
        message: 'Phase B 只支持 image、video 和 audio 检索，不能创建 document run。',
      })
    }

    if (parsed.allow_external_scene_visual && (parsed.workflow !== 'retrieval_agent' || !capabilities.scene_inspection.available)) throw new BadRequestException('场景看图未启用。')
    if (parsed.allow_external_retrieval_visual && (parsed.workflow !== 'retrieval_agent' || !capabilities.matched_evidence.available)) throw new BadRequestException('命中图文判断未启用。')
    const run = await createDurableAgentRun(this.db, {
      prompt: parsed.prompt,
      searchScope: parsed.search_scope,
      allowExternalText: parsed.allow_external_text,
      allowExternalVisual: parsed.allow_external_visual,
      retrievalAgent: parsed.workflow === 'retrieval_agent',
      allowExternalMediaText: parsed.allow_external_media_text,
      allowExternalSceneVisual: parsed.allow_external_scene_visual,
      allowExternalRetrievalVisual: parsed.allow_external_retrieval_visual,
      libraryIds: parsed.library_ids,
      // 空数组过去表示“全部媒体”；产品 Rerank 当前只能消费视觉证据，因此空选择收紧为
      // image + video，不能让 AgentIntent 后续把范围扩大到 audio。
      mediaTypes: parsed.media_types.length ? parsed.media_types : ['image', 'video'],
    })
    return { run_id: run.id, status: run.status }
  }

  async getRun(runId: string) {
    const value = await getDurableAgentRun(this.db, runId)
    if (!value) throw new NotFoundException('Agent run not found')
    const { run, authorization, steps, events, candidates } = value
    // 普通任务详情仅提供安全执行摘要，不返回审计表中的请求/响应正文。
    const traces = await this.db.select({
      spanId: agentRunTraceSpans.spanId, operation: agentRunTraceSpans.operation,
      status: agentRunTraceSpans.status, startedAt: agentRunTraceSpans.startedAt,
      finishedAt: agentRunTraceSpans.finishedAt, attributesJson: agentRunTraceSpans.attributesJson,
    }).from(agentRunTraceSpans).where(eq(agentRunTraceSpans.runId, runId)).orderBy(asc(agentRunTraceSpans.startedAt))
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
    const rerankAttempts = await this.db.select({
      id: agentRerankRuns.id, status: agentRerankRuns.status,
      createdAt: agentRerankRuns.createdAt, dispatchedAt: agentRerankRuns.dispatchedAt,
      finishedAt: agentRerankRuns.finishedAt,
    }).from(agentRerankRuns).where(eq(agentRerankRuns.agentRunId, runId)).orderBy(desc(agentRerankRuns.attemptNo))
    const successfulRerank = rerankAttempts.find(attempt => attempt.status === 'succeeded')
    const finalRankings = successfulRerank
      ? await this.db
          .select({
            candidateId: agentRerankRankings.candidateId,
            rank: agentRerankRankings.rerankRank,
            relevanceScore: agentRerankRankings.relevanceScore,
          })
          .from(agentRerankRankings)
          .where(
            and(
              eq(agentRerankRankings.rerankRunId, successfulRerank.id),
              isNotNull(agentRerankRankings.rerankRank),
            ),
          )
          .orderBy(asc(agentRerankRankings.rerankRank))
      : []
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const storedRetrievalState = [...steps].reverse().map(step => step.outputJson as { retrieval_state?: RetrievalState } | null).find(output => output?.retrieval_state)?.retrieval_state
    const retrievalState = storedRetrievalState ? structuredClone(storedRetrievalState) : undefined
    if (retrievalState) {
      // 失败模型步骤不会提交成功快照，不能只读上轮state而显示0次。
      // 派发表是权威调用依据：失败/未知也占额度；仅做只读投影，不补发请求或改历史正文。
      const dispatchedDecisions = steps.filter(step => step.stepKind === 'searching' &&
        step.externalCallStatus !== 'not_dispatched').length
      retrievalState.model_calls = Math.max(retrievalState.model_calls ?? 0, dispatchedDecisions)
      if (!retrievalState.stop_reason && run.status === 'failed' &&
        /^AGENT_(MODEL_|DECISION_|RATE_LIMITED$)/.test(run.errorCode ?? ''))
        retrievalState.stop_reason = 'model_failed'
    }
    const baselineOnly = Boolean(retrievalState?.baseline && !successfulRerank &&
      ['failed', 'timed_out', 'outcome_unknown', 'completed_with_errors'].includes(run.status))
    if (baselineOnly && retrievalState) {
      // 失败/未知时仅投影已提交原文结果，不发起新请求。页面明确这些结果未经最终图片重排。
      retrievalState.result_mode = 'baseline'
      retrievalState.quality_status = 'not_accepted'
      retrievalState.fallback_reason = run.errorCode === 'AGENT_RERANK_SELECTION_CHANGED' ? 'selection_invalidated'
        : run.status === 'outcome_unknown' ? 'external_outcome_unknown' : retrievalState.stop_reason ?? run.status
    }
    let retrievalCandidates = retrievalState && !retrievalState.rerank_candidate_keys && ['succeeded', 'completed_with_errors'].includes(run.status)
      ? candidates.filter(candidate => retrievalState.assessments?.length ? retrievalState.assessments.some(item => item.candidate_key === candidate.candidateKey && (retrievalState.stop_reason !== 'found' || item.conditions.every(condition => condition.status === 'satisfied'))) : true).map(candidate => ({ candidateId: candidate.id, rank: candidate.rank }))
      : []
    if (baselineOnly) retrievalCandidates = candidates.filter(candidate => retrievalState!.baseline!.candidate_keys.includes(candidate.candidateKey))
      .map(candidate => ({ candidateId: candidate.id, rank: retrievalState!.baseline!.candidate_keys.indexOf(candidate.candidateKey) + 1 })).slice(0, 10)
    // 最终判断完成之后文件仍可能被删除或重索引。展示前再核对当前事实，旧判断保留供审计，
    // 失效候选不作为可预览推荐返回；最多核验 20 条，避免每次轮询扫描整个任务的候选集。
    const unavailableCandidates: Array<{ candidate_key: string; status: string }> = []
    retrievalCandidates = retrievalCandidates.slice(0, 20)
    // 重排成功时使用其顺序；失败保底单独投影基线并标明未重排。历史任务保持兼容。
    let displayedRankings: Array<{ candidateId: string; rank: number | null }> = successfulRerank
      ? run.status === 'cancelled' ? [] : finalRankings
      : retrievalState ? retrievalCandidates : finalRankings
    if (retrievalState && this.segmentDetails) {
      const checked = await Promise.all(displayedRankings.map(async candidate => {
        const key = candidatesById.get(candidate.candidateId)!.candidateKey
        const current = await this.segmentDetails!.read(runId, key)
        if (current.status === 'stale' || current.status === 'read_failed' || !current.evidence.length) {
          unavailableCandidates.push({ candidate_key: key, status: current.status })
          return null
        }
        return candidate
      }))
      displayedRankings = checked.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    }
    return {
      id: run.id,
      status: run.status,
      next_step: run.nextStep,
      progress: buildAgentProgress(run, steps, traces, rerankAttempts),
      workflow: (run.enforcedScopeJson as { retrieval_agent?: boolean }).retrieval_agent ? 'retrieval_agent' : 'legacy',
      prompt: run.prompt,
      summary: baselineOnly ? '增强已停止，保留原文搜索基线；最终图片重排未完成，不会自动重发未知请求。'
        : run.status === 'ranking' ? '检索已完成，正在准备图片证据并最终重排。'
        : run.status === 'waiting_for_user_input' && retrievalState?.awaiting_rerank_authorization ? '检索已完成，等待最终图片重排授权或服务配置。'
        : retrievalState?.rerank_not_applicable ? '返回只读文本结果；这些候选没有可供图片重排的场景画面。'
        : retrievalState?.stop_reason ? '检索已结束，请查看结束原因与证据。' : run.summary,
      retrieval: retrievalState ? { ...retrievalState, final_rerank_status: successfulRerank ? 'succeeded' : baselineOnly ? 'not_completed' : 'pending',
        unavailable_candidates: unavailableCandidates, pending: retrievalState.pending?.action ?? null } : null,
      clarification_question: retrievalState?.question ?? (parsedIntent.success ? parsedIntent.data.clarification_reason : null),
      enforced_scope: run.enforcedScopeJson,
      lease_version: run.leaseVersion,
      attempt_count: run.attemptCount,
      usage: { external_calls_dispatched: steps.filter(step => step.externalCallStatus !== 'not_dispatched').length,
        tool_calls: retrievalState?.tool_calls ?? 0, elapsed_ms: (run.finishedAt ?? new Date()).getTime() - run.createdAt.getTime() },
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
            allow_external_scene_visual: sceneInspectionAuthorized(authorization.visualScopeJson),
            allow_external_retrieval_visual: matchedEvidenceAuthorized(authorization.visualScopeJson),
            allow_external_media_text: (authorization.textScopeJson as { fields?: string[] }).fields?.includes('retrieval_evidence_text') ?? false,
            granted_at: authorization.grantedAt.toISOString(),
          }
        : null,
      steps: steps.map((step) => ({
        step_attempt_id: step.stepAttemptId,
        step: step.stepKind,
        status: step.status,
        action: (step.outputJson as { action?: { action?: string } } | null)?.action?.action ?? null,
        tool_status: (step.outputJson as { tool_status?: string } | null)?.tool_status ?? null,
        external_call_status: step.externalCallStatus,
        input_fingerprint: step.inputFingerprint,
        started_at: step.startedAt.toISOString(),
        finished_at: step.finishedAt?.toISOString() ?? null,
      })),
      // 新视觉任务只返回成功重排结果；历史任务和无场景画面的文本结果保留只读兼容。
      // 原始通道分数不暴露为用户条件满足概率。
      candidates: displayedRankings.flatMap((ranking) => {
        const candidate = candidatesById.get(ranking.candidateId)
        if (!candidate || ranking.rank === null) return []
        return [{
        candidate_key: candidate.candidateKey,
        file_id: candidate.fileId,
        file_generation: candidate.fileGeneration,
        asset_id: candidate.assetId,
        scene_id: candidate.sceneId,
        scene_start_seconds:
          candidate.sceneStartSeconds !== null ? Number(candidate.sceneStartSeconds) : null,
        scene_end_seconds:
          candidate.sceneEndSeconds !== null ? Number(candidate.sceneEndSeconds) : null,
        rank: ranking.rank,
        ...(retrievalState ? { retrieval: { media_type: (candidate.retrievalJson as { media_type?: string }).media_type },
          query_sources: retrievalState.queries.filter(query => query.candidate_keys.includes(candidate.candidateKey)) } : {}),
      }]
      }),
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
      allowExternalMediaText: parsed.allow_external_media_text,
      allowExternalSceneVisual: parsed.allow_external_scene_visual,
      allowExternalRetrievalVisual: parsed.allow_external_retrieval_visual,
      allowExternalVisual: parsed.allow_external_visual,
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
