import { SceneObservationError, SceneInspectionTool, sceneInspectionAuthorized, type SceneInspection } from './scene-inspection.tool.js'
import { MatchedEvidenceTool, matchedEvidenceAuthorized, type PreparedMatchedBatch } from './matched-evidence.tool.js'
import { retrievalModel } from './retrieval-model.policy.js'
import { validateMatchedStopBasis } from './retrieval-stop.policy.js'
import { RetrievalSelectionService } from './retrieval-selection.service.js'
import type { RetrievalSelectionPlan } from './retrieval-selection.policy.js'
import { retrievalBudget, remainingRetrievalBudget, retrievalBudgetStop, type RetrievalBudget } from './retrieval-budget.policy.js'
import { agentSearchProgress } from './agent-search-progress.js'
import type { RetrievalValidationIssue } from './retrieval-decision.diagnostics.js'
import { randomUUID, createHash } from 'node:crypto'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import { retrievalActionSchema, retrievalMatchedActionSchema, RETRIEVAL_EVIDENCE_LIMITS, MATCHED_EVIDENCE_LIMITS, MATCHED_DECISION_POLICY_VERSION, type RetrievalAction, type RetrievalOverview, type RetrievalVisualVerification, type RetrievalStopBasis } from '@local-media-agent/shared/schemas'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  agentRunAuthorizations,
  agentRunCandidates,
  agentRunInputs,
  agentRuns,
  agentRunSteps,
} from '../database/schema.js'
import { SearchService } from '../search/search.service.js'
import { AgentV1StepHandler } from './agent-v1-step.handler.js'
import {
  AgentStepExecutionError,
  type AgentStepHandler,
  type PreparedAgentStep,
} from './agent.types.js'
import {
  RETRIEVAL_DECISION_RUNNER,
  type RetrievalDecisionRunner,
} from './retrieval-decision.runner.js'
import { SegmentDetailsTool, type SegmentDetails } from './segment-details.tool.js'
import { AGENT_RERANK_POLICY } from './agent-rerank.policy.js'
import { retrievalQuerySignature, selectExperimentalCandidates, type RetrievalQuerySnapshot, type RetrievalQueryHit } from './retrieval-candidates.policy.js'

type ToolAction = Extract<RetrievalAction, { action: 'search_media' | 'get_segment_details' | 'get_segment_details_batch' | 'inspect_segment_frames' }>
/** 兼容旧单条动作；批量的每个候选都占一个详情和总工具位置，不能靠包装绕过额度。 */
function detailKeys(action?: ToolAction | null): string[] {
  return !action || action.action === 'search_media' ? [] : (action.action === 'get_segment_details' || action.action === 'inspect_segment_frames')
    ? [action.candidate_key] : action.candidate_keys
}
function toolUnits(action?: ToolAction | null) { return action?.action === 'search_media' ? 1 : detailKeys(action).length }
export interface RetrievalState {
  version: 1
  model_configuration?: { model: string; scene_inspection_enabled: boolean; evidence_mode?: 'overview' | 'matched_multimodal'; decision_policy_version?: string }
  matched_evidence?: Omit<PreparedMatchedBatch, 'images'> & { candidate_keys: string[] }
  matched_evidence_query_count?: number
  awaiting_retrieval_visual_authorization?: boolean
  scene_inspections?: Record<string, SceneInspection>
  awaiting_scene_authorization?: boolean
  pending: ToolAction | null
  tool_calls: number
  model_calls: number
  /** 首次执行冻结额度，旧状态从已提交工具动作补账；明确失败也占用次数。 */
  budget?: { limits: RetrievalBudget; searches: number; details: number }
  /** 仅记录程序可验证的新身份/正文；不把这些事实等同于原条件获得语义支持。 */
  progress_facts?: Array<{ step_id: string; kind: 'search_completed' | 'detail_checked'; new_candidates?: number; new_body_evidence?: number }>
  failures: number
  no_progress: number
  signatures: string[]
  queries: RetrievalQuerySnapshot[]
  details: Record<string, SegmentDetails>
  /** 新任务冻结概要额度；旧任务不自动扩展证据读取协议。概要与完整详情分别记账。 */
  evidence_protocol?: 'overview-batch-v1' | 'matched-multimodal-v1'
  overviews?: Record<string, RetrievalOverview>
  overview_budget?: { maximum_candidates: number; maximum_characters_per_candidate: number; inspected: number }
  /** 首轮原文快照与工具结果在同一事务提交；空集合也是已完成基线，不能重搜。 */
  baseline?: { query: string; step_id: string; candidate_keys: string[] }
  result_mode?: 'baseline' | 'enhanced' | 'evaluation'
  selection?: RetrievalSelectionPlan & { configuration_fingerprint: string; fingerprint: string }
  fallback_reason?: string
  experimental_candidate_keys?: string[]
  /** 仅由本地人工质量记录的重新核算授予；模型或任务成功不能开启。 */
  quality_status?: 'not_accepted' | 'accepted_for_frozen_case'
  gaps?: Array<{ step_id: string; action: ToolAction['action']; gap: NonNullable<ToolAction['gap']> }>
  rejected_judgments?: Array<{ candidate_key: string; condition_id: string; reason: string }>
  stop_reason?: string
  /** 模型的必要行动依据；不代表其“继续无用”判断已经人工核实。 */
  stop_basis?: RetrievalStopBasis
  /** 由程序落盘，与模型原判断同时提交；最终图片排序也不能改写成已核实。 */
  visual_verification?: RetrievalVisualVerification
  question?: string
  assessments?: Extract<RetrievalAction, { action: 'finish' }>['assessments']
  /** 有限纠正记录会送回模型；不把错误响应当成已经验证的判断。 */
  decision_failures?: number
  last_decision_error?: { code: string; message: string; issues?: RetrievalValidationIssue[]; omitted_issue_count?: number }
  /** 冻结最终重排集合，恢复授权后无需再次付费请求模型决策。 */
  rerank_candidate_keys?: string[]
  awaiting_rerank_authorization?: boolean
  rerank_not_applicable?: boolean
}
export function initialRetrievalState(): RetrievalState {
  return {
    version: 1,
    pending: null,
    tool_calls: 0,
    model_calls: 0,
    failures: 0,
    no_progress: 0,
    signatures: [],
    queries: [],
    details: {},
    evidence_protocol: 'overview-batch-v1', overviews: {},
  }
}

/**
 * 在现有租约执行器中交替提交“决策”和“工具结果”。每步只执行一个动作，模型没有数据库写权。
 * state 是恢复所需工作状态；每一步 output 另存原始工具结果，不依赖模型摘要恢复。
 */
@Injectable()
export class RetrievalAgentHandler implements AgentStepHandler {
  private readonly logger = new Logger(RetrievalAgentHandler.name)
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AgentV1StepHandler) private readonly legacy: AgentV1StepHandler,
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(SegmentDetailsTool) private readonly details: SegmentDetailsTool,
    @Inject(RETRIEVAL_DECISION_RUNNER) private readonly runner: RetrievalDecisionRunner,
    @Optional() @Inject(RetrievalSelectionService) private readonly selectionService?: RetrievalSelectionService,
    @Optional() @Inject(SceneInspectionTool) private readonly inspection?: SceneInspectionTool,
    @Optional() @Inject(MatchedEvidenceTool) private readonly matchedEvidence?: MatchedEvidenceTool,
  ) {}

  isReady() {
    return this.legacy.isReady()
  }

  /** 读取已提交步骤，准备一个可恢复动作；这里仅查本地状态，外部请求留给 execute。 */
  async prepare(input: Parameters<AgentStepHandler['prepare']>[0]): Promise<PreparedAgentStep> {
    const scope = input.enforcedScope as { retrieval_agent?: boolean }
    if (!scope.retrieval_agent) return this.legacy.prepare(input)
    const [runRecord] = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .limit(1)
    if (!runRecord) throw new AgentStepExecutionError('AGENT_RUN_MISSING', '任务不存在。')
    // 排队期间也会消耗总时限：首次意图请求发送前就检查，不能发出后才宣布超时。
    if (
      input.step === 'extracting_intent' &&
      Date.now() - runRecord.createdAt.getTime() >=
        (this.settings.agentRetrievalTimeoutMs ?? 600_000)
    ) {
      return {
        external: false,
        execute: async () => ({
          transition: { status: 'timed_out' },
          outputJson: {
            retrieval_state: { ...initialRetrievalState(), stop_reason: 'time_limit' },
          },
        }),
      }
    }

    if (input.step === 'extracting_intent') {
      const prepared = await this.legacy.prepare(input)
      const attempts = await this.db
        .select()
        .from(agentRunSteps)
        .where(
          and(
            eq(agentRunSteps.runId, input.runId),
            eq(agentRunSteps.stepKind, 'extracting_intent'),
          ),
        )
      if (attempts.length > (this.settings.agentRetrievalMaxRetries ?? 1) + 1) {
        return {
          external: false,
          execute: async () => ({
            transition: { status: 'failed' },
            outputJson: {
              retrieval_state: { ...initialRetrievalState(), stop_reason: 'model_limit' },
            },
          }),
        }
      }
      return {
        ...prepared,
        execute: async () => {
          try {
            return await prepared.execute()
          } catch (error) {
            // 只有拿到明确响应的可重试错误才重试；网络中断、服务端未知结果不重放。
            if (
              attempts.length <= (this.settings.agentRetrievalMaxRetries ?? 1) &&
              error instanceof AgentStepExecutionError &&
              !error.outcomeUnknown &&
              [
                'AGENT_INTENT_RATE_LIMITED',
                'AGENT_INTENT_RESPONSE_INVALID',
                'AGENT_INTENT_SCHEMA_INVALID',
              ].includes(error.code)
            ) {
              return {
                transition: { status: 'extracting_intent', nextStep: 'extracting_intent' },
                outputJson: { error_code: error.code, retry: true },
              }
            }
            throw error
          }
        },
      }
    }
    const intent = await this.legacy.loadCommittedIntent(input.runId)
    // 已有导出继续走原来的候选重排和人工确认链，不让检索工具循环引入导出副作用。
    if (intent.intent.goal === 'export_clip') {
      // 多轮检索不隐式开启图片外发；导出请求必须显式选择保留的原有授权流程。
      throw new AgentStepExecutionError(
        'AGENT_EXPORT_REQUIRES_LEGACY',
        '导出请使用页面的原有重排与导出流程，并单独授权图片。',
      )
    }
    const steps = await this.db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, input.runId))
      .orderBy(asc(agentRunSteps.createdAt))
    const outputs = steps
      .filter((step) => step.status === 'completed')
      .map((step) => step.outputJson as { retrieval_state?: RetrievalState })
    const state = structuredClone(
      [...outputs].reverse().find((output) => output?.retrieval_state)?.retrieval_state ??
        initialRetrievalState(),
    )
    // 以派发表为调用账本，结果未知后的人为重试也占额度，不能只统计成功响应。
    state.model_calls = steps.filter(
      (step) => step.stepKind === 'searching' && step.externalCallStatus !== 'not_dispatched',
    ).length
    if (!state.budget) {
      // 新版字段缺失时只从已完成工具步骤补账，绝不依据模型的使用量声明。
      const actions = steps.filter(step => step.status === 'completed' && step.externalCallStatus === 'not_dispatched' &&
        Boolean((step.outputJson as { tool_status?: string } | null)?.tool_status)).map(step => (step.outputJson as { action?: ToolAction } | null)?.action)
      state.budget = { limits: retrievalBudget(this.settings),
        searches: actions.filter(action => action?.action === 'search_media').length,
        details: actions.flatMap(detailKeys).length }
    }
    if (state.evidence_protocol && !state.overview_budget) state.overview_budget = {
      maximum_candidates: state.budget.limits.maximum_searches * AGENT_RERANK_POLICY.maximumCandidateCount,
      maximum_characters_per_candidate: RETRIEVAL_EVIDENCE_LIMITS.overviewCharacters, inspected: 0,
    }
    const [textAuthorization] = await this.db.select().from(agentRunAuthorizations)
      .where(eq(agentRunAuthorizations.runId, input.runId)).limit(1)
    const mayReadOverview = Boolean(textAuthorization?.allowExternalText &&
      (textAuthorization.textScopeJson as { fields?: string[] })?.fields?.includes('retrieval_evidence_text'))
    /** 搜索的本地证据准备，不调用GLM；成功、失效和失败均占冻结概要额度。
     * 正文与计数仅随步骤一次提交，取消/超时后的迟到结果无法写数据库。
     */
    const captureOverviews = async (rows: Array<{ candidateKey: string }>) => {
      if (!mayReadOverview || !state.overview_budget) return
      for (const row of rows) {
        if (state.overviews?.[row.candidateKey] || state.overview_budget.inspected >= state.overview_budget.maximum_candidates) continue
        state.overview_budget.inspected++
        let overview: RetrievalOverview
        try { overview = await this.details.readOverview(input.runId, row.candidateKey) }
        catch { overview = { candidate_key: row.candidateKey, level: 'overview', status: 'read_failed', evidence: [], truncated: false, continuous_action_verified: false } }
        ;(state.overviews ??= {})[row.candidateKey] = overview
      }
    }
    let currentMatched: PreparedMatchedBatch | undefined
    const readDetails = async (key: string): Promise<SegmentDetails> => {
      let detail = await this.details.read(input.runId, key)
      if (currentMatched?.records[key] && ['available', 'empty'].includes(detail.status))
        detail = { ...detail, evidence: [...detail.evidence, ...currentMatched.records[key]!.evidence] }
      const inspected = state.scene_inspections?.[key]
      if (inspected?.status !== 'observed' || !inspected.observation || !this.inspection || !['available', 'empty'].includes(detail.status)) return detail
      let current
      try { current = await this.inspection.prepare(input.runId, key) }
      catch { return { ...detail, status: 'stale', evidence: [] } }
      if (!this.inspection.matches(inspected, current.metadata)) return { ...detail, status: 'stale', evidence: [] }
      return { ...detail, evidence: [...detail.evidence, { evidence_id: `visual:${createHash('sha256').update(JSON.stringify([inspected.candidate_key, inspected.file_generation, inspected.frames.map(f => [f.frame_id, f.time_seconds, f.sha256]), inspected.observation.summary, inspected.observation.conditions.map(c => [c.condition_id, c.status, c.frame_ids, c.observation])])).digest('hex')}`,
        source: 'scene_visual_observation', text: JSON.stringify(inspected.observation), start_seconds: detail.start_seconds ?? null, end_seconds: detail.end_seconds ?? null,
        crosses_scene_boundary: false, truncated: false }] }
    }
    const usage = () => ({ tools: state.tool_calls, searches: state.budget!.searches,
      details: state.budget!.details, models: state.model_calls })
    const remaining = () => remainingRetrievalBudget(state.budget!.limits, usage())
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .limit(1)
    const elapsed = Date.now() - run!.createdAt.getTime()
    const totalTimeout = this.settings.agentRetrievalTimeoutMs ?? 600_000
    const local = (execute: PreparedAgentStep['execute']): PreparedAgentStep => ({
      external: false,
      execute,
      timeoutOutputJson: {
        retrieval_state: {
          ...structuredClone(state),
          tool_calls: state.tool_calls + toolUnits(state.pending),
          budget: { ...state.budget!, searches: state.budget!.searches + (state.pending?.action === 'search_media' ? 1 : 0),
            details: state.budget!.details + detailKeys(state.pending).length },
          pending: null,
          stop_reason: 'tool_timeout',
        },
      },
    })
    // 检索循环的停止不是最终排序完成。非空视觉候选需交给独立的图片重排服务；
    // 授权等待也持久化选中的身份，因此恢复时不重跑已经完成的模型决策。
    const finish = (reason: string) => local(async () => {
      state.pending = null
      state.stop_reason = reason
      const rows = await this.db.select().from(agentRunCandidates)
        .where(eq(agentRunCandidates.runId, input.runId)).orderBy(asc(agentRunCandidates.rank))
      const previouslySelected = state.rerank_candidate_keys
      if (state.baseline && !state.selection && !previouslySelected) {
        state.selection = await (this.selectionService ?? new RetrievalSelectionService(this.db, this.settings)).select({
          query: input.prompt, scope: intent.enforced_scope, baseline: state.baseline.candidate_keys,
          queries: state.queries, stop_reason: reason }, state.budget!.limits)
      }
      if (state.baseline) {
        state.result_mode = state.selection?.result_mode ?? 'baseline'
        state.quality_status = state.result_mode === 'enhanced' ? 'accepted_for_frozen_case' : 'not_accepted'
        state.fallback_reason = state.selection?.fallback_reason ?? (state.result_mode === 'baseline' ? 'quality_not_accepted' : undefined)
        state.experimental_candidate_keys = state.selection?.experimental_candidate_keys ?? selectExperimentalCandidates(state.baseline.candidate_keys, state.queries)
      }
      // 顺序来自选择计划，不是数据库首次发现顺序；旧授权等待任务沿用已冻结名单。
      const keys = previouslySelected ?? state.selection?.candidate_keys ?? state.baseline?.candidate_keys ?? rows.map(row => row.candidateKey)
      const byKey = new Map(rows.map(row => [row.candidateKey, row]))
      const eligible = keys.map(key => byKey.get(key)).filter((row): row is typeof rows[number] => Boolean(row))
      const selected: typeof rows = []
      for (const row of eligible) {
        if (!row.candidateKey.startsWith('image:') && !row.candidateKey.startsWith('video:')) continue
        if (row.candidateKey.startsWith('video:') && row.sceneId === null) continue
        const current = await readDetails( row.candidateKey)
        if (current.status !== 'stale' && current.status !== 'read_failed' && current.evidence.length) selected.push(row)
        if (selected.length === AGENT_RERANK_POLICY.maximumCandidateCount) break
      }
      if (previouslySelected && JSON.stringify(previouslySelected) !== JSON.stringify(selected.map(row => row.candidateKey)))
        // 等待期间身份失效时停止，不能在用户授权恢复后悄悄发送另一份名单。
        throw new AgentStepExecutionError('AGENT_RERANK_SELECTION_CHANGED', '已冻结的重排名单出现失效候选，停止外发并展示基线；不会自动更换名单。')
      if (state.result_mode === 'enhanced' && selected.length !== keys.length) {
        state.result_mode = 'baseline'
        state.quality_status = 'not_accepted'
        state.fallback_reason = 'enhanced_candidate_unavailable'
        selected.splice(0)
        for (const key of state.baseline!.candidate_keys) {
          const row = byKey.get(key)
          if (!row || (!key.startsWith('image:') && !row.sceneId)) continue
          const current = await readDetails( key)
          if (current.status !== 'stale' && current.status !== 'read_failed' && current.evidence.length) selected.push(row)
          if (selected.length === AGENT_RERANK_POLICY.maximumCandidateCount) break
        }
        state.selection = { ...state.selection!, result_mode: 'baseline', candidate_keys: selected.map(row => row.candidateKey),
          fallback_reason: 'enhanced_candidate_unavailable' }
      }
      state.rerank_candidate_keys = selected.map(row => row.candidateKey)
      // 纯音频或没有场景身份的转录结果没有可供图片模型比较的画面，保留原只读结果。
      if (!selected.length && eligible.some(row => row.candidateKey.startsWith('audio:') ||
        (row.candidateKey.startsWith('video:') && row.sceneId === null))) {
        delete state.rerank_candidate_keys
        state.rerank_not_applicable = true
      }
      const outputJson = { retrieval_state: state, rerank_candidate_keys: state.rerank_candidate_keys, elapsed_ms: elapsed }
      if (!selected.length || reason === 'time_limit') {
        delete state.awaiting_rerank_authorization
        delete state.question
        const status = reason === 'time_limit' ? 'timed_out' as const
          : ['tool_failed', 'model_failed'].includes(reason) ? 'completed_with_errors' as const : 'succeeded' as const
        return { transition: { status }, outputJson }
      }
      const [authorization] = await this.db.select().from(agentRunAuthorizations)
        .where(eq(agentRunAuthorizations.runId, input.runId)).limit(1)
      const rerankReady = this.settings.agentRerankProvider === 'dashscope' &&
        Boolean(this.settings.dashscopeApiKey && this.settings.dashscopeWorkspaceId)
      if (!authorization?.allowExternalVisual || !rerankReady) {
        state.awaiting_rerank_authorization = true
        state.question = rerankReady
          ? '检索已完成。最终重排需要单独允许向阿里云百炼发送完整查询和选中候选的派生图片；不会发送路径、画面描述或转录。'
          : '检索已完成，但最终重排服务未启用或未配置。请在服务配置中启用产品重排并配置百炼凭证，再单独授权图片并继续。'
        return { transition: { status: 'waiting_for_user_input' as const, nextStep: 'searching' as const,
          waitingStepId: randomUUID(), waitingExpiresAt: new Date(Date.now() + this.settings.agentWaitingTtlSeconds * 1000) }, outputJson }
      }
      delete state.awaiting_rerank_authorization
      delete state.question
      return {
        transition: { status: 'ranking' as const, nextStep: 'reranking' as const }, outputJson,
        candidates: selected.map((row, index) => ({ candidateKey: row.candidateKey, fileId: row.fileId,
          fileGeneration: row.fileGeneration, assetId: row.assetId, sceneId: row.sceneId,
          sceneStartSeconds: row.sceneStartSeconds === null ? null : Number(row.sceneStartSeconds),
          sceneEndSeconds: row.sceneEndSeconds === null ? null : Number(row.sceneEndSeconds),
          rank: index + 1, retrievalJson: row.retrievalJson as Record<string, unknown> })),
        rerankAttempt: { attemptNo: 1, completionStatus: 'succeeded' as const,
          protocolVersion: AGENT_RERANK_POLICY.protocolVersion, maxCostCny: AGENT_RERANK_POLICY.maximumCostCny },
      }
    })
    const configuration = { model: retrievalModel(this.settings), scene_inspection_enabled: this.settings.agentSceneInspectionEnabled ?? false,
      evidence_mode: this.settings.agentRetrievalEvidenceMode ?? 'overview',
      ...(this.settings.agentRetrievalEvidenceMode === 'matched_multimodal' ? { decision_policy_version: MATCHED_DECISION_POLICY_VERSION } : {}) }
    if (configuration.evidence_mode === 'matched_multimodal' && configuration.model !== 'deepseek-v4-flash') return finish('model_configuration_changed')
    if (state.model_configuration && (state.model_configuration.model !== configuration.model || state.model_configuration.scene_inspection_enabled !== configuration.scene_inspection_enabled ||
      (state.model_configuration.evidence_mode ?? 'overview') !== configuration.evidence_mode)) return finish('model_configuration_changed')
    // 已交接的排序/授权恢复使用冻结名单；尚在规划的旧模式不静默升级决策约束。
    if (state.model_configuration && !state.rerank_candidate_keys && configuration.evidence_mode === 'matched_multimodal' &&
      state.model_configuration.decision_policy_version !== configuration.decision_policy_version) return finish('model_configuration_changed')
    if (!state.model_configuration && configuration.evidence_mode === 'matched_multimodal') state.evidence_protocol = MATCHED_EVIDENCE_LIMITS.protocol
    state.model_configuration ??= configuration
    const wait = (question: string) => local(async () => ({
      transition: { status: 'waiting_for_user_input', nextStep: 'searching', waitingStepId: randomUUID(), waitingExpiresAt: new Date(Date.now() + this.settings.agentWaitingTtlSeconds * 1000) },
      outputJson: { retrieval_state: { ...state, question }, elapsed_ms: elapsed },
    }))
    if (elapsed >= totalTimeout) return finish('time_limit')
    if (state.awaiting_rerank_authorization) return finish(state.stop_reason ?? 'partial')
    // 视觉召回必须先执行旧产品的原文搜索。模型仅能在这份已提交快照上提出增强。
    // spoken 的全部词匹配有不同语义，仍由模型选择关键词，不能套用视觉原文规则。
    const baselineSearch = !state.baseline && intent.enforced_scope.search_scope !== 'spoken'
    if (baselineSearch) {
      if (!input.prompt.trim() || [...input.prompt].length > 4000)
        throw new AgentStepExecutionError('AGENT_BASELINE_QUERY_INVALID', '完整原文必须为1至4000字符；不会截断或改写原始条件。')
      state.pending = { action: 'search_media', query: input.prompt,
        search_scope: intent.enforced_scope.search_scope, media_types: intent.enforced_scope.media_types,
        limit: AGENT_RERANK_POLICY.maximumCandidateCount }
    }
    // attemptCount 包含崩溃恢复、明确重试和澄清，避免只数成功工具而留下无限循环漏洞。
    if (run!.attemptCount > (state.budget.limits.maximum_tools + state.budget.limits.maximum_models) * 4 + 8) return finish('step_limit')
    if (state.no_progress >= (this.settings.agentRetrievalMaxNoProgress ?? 2))
      return finish('no_progress')
    if (state.pending?.action === 'inspect_segment_frames') {
      const action = state.pending
      const key = action.candidate_key
      const existing = state.scene_inspections?.[key]
      if (configuration.model !== 'deepseek-v4-flash' || !configuration.scene_inspection_enabled || !this.inspection) return finish('scene_inspection_unavailable')
      if (!remaining().models) return finish('model_limit')
      if (!remaining().tools || !remaining().details) return finish('tool_limit')
      if (Object.keys(state.scene_inspections ?? {}).length > 3) return finish('scene_inspection_limit')
      if (!sceneInspectionAuthorized(textAuthorization?.visualScopeJson)) {
        state.awaiting_scene_authorization = true
        return wait('检查画面需要单独允许向RightAPI deepseek-v4-flash发送当前任务候选的采样图，最多3个候选，每个最多3帧。不发送路径或原视频。')
      }
      delete state.awaiting_scene_authorization
      if (existing?.status === 'observed') return finish('repeated_call')
      if (!existing) {
        if (Object.keys(state.scene_inspections ?? {}).length >= 3) return finish('scene_inspection_limit')
        // 取帧是本地独立步骤，超时/取消后迟到结果没有提交权；基线已经持久化。
        return local(async () => {
          try {
            const prepared = await this.inspection!.prepare(input.runId, key)
            ;(state.scene_inspections ??= {})[key] = prepared.metadata
            return { transition: { status: 'searching', nextStep: 'searching' }, outputJson: { retrieval_state: state, action, evidence_preparation: 'scene_frames', frame_count: prepared.metadata.frames.length } }
          } catch (error) {
            state.tool_calls++; state.budget!.details++; state.pending = null
            const fallback = await finish('scene_preparation_failed').execute()
            return { ...fallback, outputJson: { ...(fallback.outputJson as object), action, tool_status: 'failed', error_code: error instanceof AgentStepExecutionError ? error.code : 'AGENT_SCENE_PREPARATION_FAILED' } }
          }
        })
      }
      let prepared
      try {
        prepared = await this.inspection.prepare(input.runId, key)
        if (!this.inspection.matches(existing, prepared.metadata)) return finish('scene_evidence_changed')
      } catch { return finish('scene_evidence_changed') }
      let preflight
      try { preflight = this.inspection.preflight(prepared, input.prompt, intent.conditions) }
      catch { return finish('context_limit') }
      return { external: true, inputFingerprint: preflight.request_sha256, execute: async () => {
        state.model_calls++; state.tool_calls++; state.budget!.details++; state.pending = null
        try {
          const result = await this.inspection!.observe(input.runId, prepared, input.prompt, intent.conditions)
          existing.status = 'observed'; existing.observation = result.observation; existing.provider = result.provider; existing.normalizations = result.normalizations
          state.details[key] = await readDetails(key)
          state.signatures.push(`inspect:${key}`); state.no_progress = 0
          return { transition: { status: 'searching', nextStep: 'searching' }, outputJson: { retrieval_state: state, action, tool_status: 'succeeded', result: existing, provider: result.provider } }
        } catch (error) {
          if (!(error instanceof AgentStepExecutionError) || error.outcomeUnknown) throw error
          if (error instanceof SceneObservationError) existing.provider = error.provider
          const fallback = await finish('scene_observation_failed').execute()
          return { ...fallback, outputJson: { ...(fallback.outputJson as object), action, tool_status: 'failed', error_code: error.code } }
        }
      } }
    }
    if (state.pending) {
      if (!remaining().tools) return finish('tool_limit')
      const action = retrievalActionSchema.parse(state.pending) as ToolAction
      const units = toolUnits(action), keys = detailKeys(action)
      if (units > remaining().tools || units > (action.action === 'search_media' ? remaining().searches : remaining().details)) return finish('tool_limit')
      const signatures = action.action === 'search_media'
        ? [retrievalQuerySignature(action.query, action.search_scope, action.media_types)]
        : keys.map(key => `${action.action === 'inspect_segment_frames' ? 'inspect' : 'details'}:${key}`)
      if (signatures.some(signature => state.signatures.includes(signature))) return finish('repeated_call')
      return local(async () => {
        state.tool_calls += units
        if (action.action === 'search_media') state.budget!.searches++
        else state.budget!.details += keys.length
        state.pending = null
        try {
          if (action.action === 'search_media') {
            if (
              (intent.enforced_scope.search_scope !== 'all' &&
                action.search_scope !== intent.enforced_scope.search_scope) ||
              action.media_types.some(
                (type) => !intent.enforced_scope.media_types.includes(type),
              ) ||
              (action.search_scope === 'visual' && action.media_types.includes('audio')) ||
              (action.search_scope === 'spoken' && action.media_types.includes('image'))
            ) {
              throw new AgentStepExecutionError(
                'AGENT_SCOPE_EXCEEDED',
                '工具参数超出不可放宽的任务范围。',
              )
            }
            const result = await this.search.search({
              query: action.query,
              search_scope: action.search_scope,
              media_types: action.media_types,
              library_ids: intent.enforced_scope.library_ids,
              limit: action.limit,
              offset: 0,
              ranking_mode: 'rrf',
              query_expansion_mode: 'original',
              include_diagnostics: false,
            }, { onProgress: agentSearchProgress(this.db, input) })
            if (result.results.length > action.limit)
              throw new AgentStepExecutionError(
                'AGENT_SEARCH_RESPONSE_INVALID',
                '搜索返回数量超过工具请求上限。',
              )
            const frozen = await this.legacy.freezeCandidates(
              result.results,
              intent.enforced_scope,
            )
            // 同一场景/图片的多通道命中只占一个位置。新一轮仍保存命中 asset，
            // 但沿用首次冻结的业务身份，不能把图片 Caption 当成第二个文件。
            const existing = await this.db.select().from(agentRunCandidates).where(eq(agentRunCandidates.runId, input.runId))
            const identity = (candidate: { fileId: string; fileGeneration: number; sceneId: string | null; assetId: string; candidateKey: string }) =>
              candidate.sceneId ? `scene:${candidate.sceneId}` : candidate.candidateKey.startsWith('image:')
                ? `image:${candidate.fileId}:${candidate.fileGeneration}` : `asset:${candidate.assetId}`
            const canonical = new Map(existing.map(candidate => [identity(candidate), candidate]))
            const unique = new Map<string, typeof frozen[number]>()
            for (const candidate of frozen) {
              const key = identity(candidate), prior = canonical.get(key), repeated = unique.get(key)
              // 必须在替换为稳定候选身份之前记录实际命中的素材；否则同场景的
              // Caption/帧命中会在去重后消失，审计无法还原原始搜索名次。
              const hit: RetrievalQueryHit = { asset_id: candidate.assetId, rank: candidate.rank,
                sources: [...candidate.retrievalJson.reasons as string[]],
                source_matches: candidate.retrievalJson.source_matches as RetrievalQueryHit['source_matches'] }
              if (repeated) {
                repeated.retrievalJson.reasons = [...new Set([...(repeated.retrievalJson.reasons as string[]), ...(candidate.retrievalJson.reasons as string[])])]
                const hits = repeated.retrievalJson.query_hits as RetrievalQueryHit[]
                hits.push(hit)
                continue
              }
              candidate.retrievalJson.query_hits = [hit]
              if (prior) {
                candidate.retrievalJson.matched_asset_id = candidate.assetId
                candidate.candidateKey = prior.candidateKey
                candidate.assetId = prior.assetId
              }
              unique.set(key, candidate)
            }
            const candidates = [...unique.values()]
            const seen = new Set(state.queries.flatMap((query) => query.candidate_keys))
            let nextRank = seen.size
            for (const candidate of candidates) {
              candidate.retrievalJson.query_rank = candidate.rank
              if (!seen.has(candidate.candidateKey)) candidate.rank = ++nextRank
            }
            const newCount = candidates.filter(
              (candidate) => !seen.has(candidate.candidateKey),
            ).length
            state.no_progress = newCount ? 0 : state.no_progress + 1
            state.progress_facts = [...(state.progress_facts ?? []), { step_id: input.stepAttemptId, kind: 'search_completed', new_candidates: newCount }]
            state.queries.push({
              step_id: input.stepAttemptId,
              query: action.query,
              candidate_keys: candidates.map((candidate) => candidate.candidateKey),
              ranks: candidates.map(candidate => ({ candidate_key: candidate.candidateKey,
                rank: Number(candidate.retrievalJson.query_rank), sources: candidate.retrievalJson.reasons as string[],
                hits: candidate.retrievalJson.query_hits as RetrievalQueryHit[] })),
            })
            if (baselineSearch) state.baseline = { query: input.prompt, step_id: input.stepAttemptId,
              candidate_keys: candidates.map(candidate => candidate.candidateKey) }
            state.signatures.push(...signatures)
            return {
              transition: { status: 'searching', nextStep: 'searching' },
              candidates,
              outputJson: {
                retrieval_state: state,
                action,
                tool_status: 'succeeded',
                // 保存安全字段的完整工具结果，既保留每轮名次又不外泄路径。
                result: candidates,
                new_candidate_count: newCount,
                elapsed_ms: elapsed,
              },
            }
          }
          const priorIds = new Set(Object.values(state.details).flatMap(detail => detail.evidence.map(item => item.evidence_id)))
          const results: SegmentDetails[] = []
          // 串行执行最多3个只读查询，结果只在执行器的租约事务提交；迟到Promise没有写权。
          // 单个失败保留真实状态，其他成功证据仍保存在本次原子提交内，不伪装成空结果。
          for (const key of keys) {
            let detail: SegmentDetails
            try { detail = await readDetails( key) }
            catch { detail = { candidate_key: key, status: 'read_failed', evidence: [], truncated: false, continuous_action_verified: false } }
            state.details[key] = detail
            results.push(detail)
          }
          const newBodyEvidence = results.flatMap(result => result.evidence)
            .filter(item => item.source !== 'media_metadata' && !priorIds.has(item.evidence_id)).length
          // 新正文可供检查，但不证明缺口已解决；媒体身份与尺寸不能证明动作或关系。
          state.no_progress = newBodyEvidence ? 0 : state.no_progress + 1
          state.progress_facts = [...(state.progress_facts ?? []), { step_id: input.stepAttemptId,
            kind: 'detail_checked', new_body_evidence: newBodyEvidence }]
          state.signatures.push(...signatures)
          if (results.some(result => result.status === 'read_failed')) throw new Error('Segment details read failed')
          return {
            transition: { status: 'searching', nextStep: 'searching' },
            outputJson: {
              retrieval_state: state,
              action,
              tool_status: 'succeeded',
              result: action.action === 'get_segment_details' ? results[0] : { details: results },
              elapsed_ms: elapsed,
            },
          }
        } catch (error) {
          if (error instanceof AgentStepExecutionError) throw error
          state.failures++
            const exhausted = state.failures > (this.settings.agentRetrievalMaxRetries ?? 1)
          const fallback = exhausted ? await finish('tool_failed').execute() : null
          // 本地只读工具失败保留为失败事实，允许模型调整一次；绝不伪装成空搜索。
          return {
            ...(fallback ?? {}),
            transition: {
              ...(fallback?.transition ?? { status: 'searching' as const, nextStep: 'searching' as const }),
            },
            outputJson: {
              ...(fallback?.outputJson as object ?? {}),
              retrieval_state: {
                ...state,
                ...(state.failures > (this.settings.agentRetrievalMaxRetries ?? 1)
                  ? { stop_reason: 'tool_failed' }
                  : {}),
              },
              action,
              tool_status: 'failed',
              error_code: 'AGENT_TOOL_FAILED',
              elapsed_ms: elapsed,
            },
          }
        }
      })
    }
    // 工具额度耗尽后不再付费请模型重复宣布完成，直接保存已有基线并交接重排。
    const budgetStop = retrievalBudgetStop(state.budget.limits, usage())
    if (budgetStop) return finish(budgetStop)
    const [authorization] = await this.db
      .select()
      .from(agentRunAuthorizations)
      .where(eq(agentRunAuthorizations.runId, input.runId))
      .limit(1)
    const fields = (authorization?.textScopeJson as { fields?: string[] })?.fields
    if (!authorization?.allowExternalText || !fields?.includes('user_prompt'))
      throw new AgentStepExecutionError('AGENT_AUTHORIZATION_INVALID', '用户输入外发授权缺失。')
    if (!fields.includes('retrieval_evidence_text'))
      return wait(
        '多轮判断需要将候选标识、媒体信息、已有画面描述和相关转录发送至 RightAPI glm-5.3。请单独授权素材文字；不包含图片或本地路径。',
      )
    if (!remaining().models) return finish('model_limit')
    const answers = await this.db
      .select()
      .from(agentRunInputs)
      .where(
        and(eq(agentRunInputs.runId, input.runId), eq(agentRunInputs.inputType, 'clarification')),
      )
      .orderBy(asc(agentRunInputs.createdAt))
    if (answers.length > 4) return finish('clarification_limit')
    const candidates = await this.db
      .select()
      .from(agentRunCandidates)
      .where(eq(agentRunCandidates.runId, input.runId))
      .orderBy(asc(agentRunCandidates.rank))
    // 首轮搜索未获素材文字授权时，恢复授权后先完成一次本地概要步骤，再做模型决策。
    // 不重跑搜索、不消耗模型请求；旧任务没有冻结概要预算，保持原恢复行为。
    if (configuration.evidence_mode === 'overview' && intent.enforced_scope.search_scope !== 'spoken' && state.overview_budget &&
      candidates.some(row => !state.overviews?.[row.candidateKey]) && state.overview_budget.inspected < state.overview_budget.maximum_candidates) {
      const reserved = Math.min(candidates.filter(row => !state.overviews?.[row.candidateKey]).length,
        state.overview_budget.maximum_candidates - state.overview_budget.inspected)
      const prepared = local(async () => {
        await captureOverviews(candidates)
        return { transition: { status: 'searching', nextStep: 'searching' },
          outputJson: { retrieval_state: state, evidence_preparation: 'candidate_overviews', elapsed_ms: elapsed } }
      })
      const timeoutState = (prepared.timeoutOutputJson as { retrieval_state: RetrievalState }).retrieval_state
      timeoutState.overview_budget!.inspected += reserved
      // search/candidates已提交；超时保存预留数，禁止用不完整摘要重新决策或重放未知外发。
      timeoutState.stop_reason = 'overview_timeout'
      return prepared
    }
    // 决策必须明确区分已展示证据和未展示证据，避免凭候选名单臆造满足条件的判断。
    const detailEntries = Object.entries(state.details).slice(-3)
    const visibleKeys = state.baseline
      ? selectExperimentalCandidates(state.baseline.candidate_keys, state.queries)
      : candidates.slice(0, 20).map(candidate => candidate.candidateKey)
    const visibleCandidates = candidates.filter(candidate => visibleKeys.includes(candidate.candidateKey))
    if (configuration.evidence_mode === 'matched_multimodal' && visibleKeys.length > 0) {
      if (!this.matchedEvidence) return finish('matched_evidence_unavailable')
      // 图片用途独立授权；旧场景授权不覆盖20候选。纯文字命中仍可继续判断。
      const hasVisualMatches = visibleCandidates.some(row => (row.retrievalJson as { reasons?: string[] }).reasons?.includes('vector_match'))
      if (hasVisualMatches && !matchedEvidenceAuthorized(textAuthorization?.visualScopeJson)) {
        state.awaiting_retrieval_visual_authorization = true
        return wait('允许向RightAPI DeepSeek发送本任务最多20个候选的单张命中图及已授权的命中文字，用于判断证据缺口和是否补搜；不发送路径或原视频。')
      }
      delete state.awaiting_retrieval_visual_authorization
      const prepareBatch = () => this.matchedEvidence!.prepare(input.runId, visibleKeys, state.queries)
      if (!state.matched_evidence || JSON.stringify(state.matched_evidence.candidate_keys) !== JSON.stringify(visibleKeys) ||
        state.matched_evidence.fingerprint === '' || state.matched_evidence_query_count !== state.queries.length) {
        // 先本地提交图文身份和指纹，再独立派发；失败/取消不会覆盖已完成原文基线。
        return local(async () => {
          try {
            const prepared = await prepareBatch()
            state.matched_evidence = { records: prepared.records, fingerprint: prepared.fingerprint, candidate_keys: visibleKeys }
            state.matched_evidence_query_count = state.queries.length
            return { transition: { status: 'searching', nextStep: 'searching' },
              outputJson: { retrieval_state: state, evidence_preparation: 'matched_candidates', image_count: prepared.images.length, elapsed_ms: elapsed } }
          } catch { return finish('matched_evidence_failed').execute() }
        })
      }
      try { currentMatched = await prepareBatch() }
      catch { return finish('matched_evidence_failed') }
      if (currentMatched.fingerprint !== state.matched_evidence.fingerprint) return finish('matched_evidence_changed')
      // 以实际准备的图片再检查，不能只依赖旧候选reasons；补搜可能新增视觉来源。
      if (currentMatched.images.length && !matchedEvidenceAuthorized(textAuthorization?.visualScopeJson)) {
        state.awaiting_retrieval_visual_authorization = true
        return wait('新增视觉命中需要本任务独立的DeepSeek命中图授权，尚未外发图片。')
      }
    }
    // 多个相似场景可能来自同一文件；提供身份分组供模型比较检查价值，不保存路径或文件名。
    // “读过正文”仍不是条件已满足。这里仅统计已提交详情和未读身份，不推断语义或强制补搜。
    const fileGroups = new Map<string, { file_id: string; checked_candidates: number; unread_candidates: number }>()
    for (const candidate of visibleCandidates) {
      const group = fileGroups.get(candidate.fileId) ?? { file_id: candidate.fileId, checked_candidates: 0, unread_candidates: 0 }
      if (state.details[candidate.candidateKey]) group.checked_candidates++
      else group.unread_candidates++
      fileGroups.set(candidate.fileId, group)
    }
    const checkedCount = Object.keys(state.details).length
    const completeOverviewKeys = visibleCandidates.filter(row => {
      const overview = state.overviews?.[row.candidateKey]
      return overview?.status === 'available' && !overview.truncated && overview.evidence.length > 0
    }).map(row => row.candidateKey)
    // 已发送命中帧/完整文字也满足“先检查现有线索”的入口，不再用详情计数
    // 告诉模型还必须读两份。提供了证据不代表模型已正确判断其语义。
    const completeMatchedKeys = visibleKeys.filter(key => {
      const record = currentMatched?.records[key]
      return record?.status === 'available' && record.evidence.some(row => !row.truncated)
    })
    const context = {
      original_goal: input.prompt,
      decision_policy_version: configuration.decision_policy_version ?? 'overview-legacy',
      conditions: intent.conditions,
      enforced_scope: { ...intent.enforced_scope, library_ids: undefined },
      clarification_answers: answers.slice(-4).map((answer) => answer.responseJson),
      omitted_answers: Math.max(0, answers.length - 4),
      // 模型需要实际查询、候选身份和原名次；每个素材的重复命中明细只在审计中保留。
      // 降低上下文字节数，不丢弃原始state.queries，也不跨查询比较原始分数。
      queries: state.queries.map(({ ranks, ...query }) => ({ ...query,
        ranks: ranks?.map(({ candidate_key, rank }) => ({ candidate_key, rank })) })),
      query_hit_details_omitted: true,
      candidates: visibleCandidates.map((candidate) => ({
        candidate_key: candidate.candidateKey,
        file_id: candidate.fileId,
        inspection_status: state.details[candidate.candidateKey]?.status ?? 'not_read',
        overview: state.overviews?.[candidate.candidateKey] ?? null,
        start_seconds: candidate.sceneStartSeconds,
        end_seconds: candidate.sceneEndSeconds,
        sources: (candidate.retrievalJson as { reasons?: string[] }).reasons,
      })),
      omitted_candidates: Math.max(0, candidates.length - 20),
      details: Object.fromEntries(detailEntries),
      matched_evidence: currentMatched?.records ?? null,
      omitted_details: Math.max(0, Object.keys(state.details).length - detailEntries.length),
      assessable_candidate_keys: [...new Set([...detailEntries.map(([key]) => key), ...Object.keys(currentMatched?.records ?? {})])],
      last_decision_error: state.last_decision_error ?? null,
      last_tool_status: (outputs.at(-1) as Record<string, unknown> | undefined)?.tool_status,
      baseline: state.baseline ?? null,
      checked_candidate_keys: Object.keys(state.details),
      unread_candidate_keys: candidates.filter(candidate => visibleKeys.includes(candidate.candidateKey) && !state.details[candidate.candidateKey]).slice(0, 20).map(candidate => candidate.candidateKey),
      condition_groups: intent.conditions.map(condition => ({ condition_id: condition.condition_id,
        source_text: condition.source_text, kind: condition.kind,
        // 分类只辅助定位条件，原文组合始终保留；不声称正则能完整解析自然语言。
        aspects: [condition.kind === 'exclusion' ? 'exclusion' : 'object',
          ...(/连续|持续|先|再|然后|before|after|continuous/i.test(condition.source_text) ? ['sequence_or_continuity'] : []),
          ...(/上|下|里|旁|中|内|外|on|under|inside/i.test(condition.source_text) ? ['position_or_relation'] : [])] })),
      tools_remaining: remaining().tools,
      budget: { limits: state.budget.limits, used: usage(), remaining: remaining() },
      overview_budget: state.overview_budget ?? null,
      progress_facts: state.progress_facts?.slice(-3) ?? [],
      // 历史缺口是已经校验身份的模型行动依据，不是已验证的语义结论。
      // 不携带旧正文和证据ID，避免模型把省略详情的历史引用当成本轮可引用证据。
      gap_history: (state.gaps ?? []).slice(-3).map(({ step_id, action, gap }) => ({ step_id, action,
        gap: { condition_ids: gap.condition_ids, kind: gap.kind, missing_evidence: gap.missing_evidence,
          next_step_reason: gap.next_step_reason },
        checked_candidate_keys: gap.checked.slice(-4).map(row => row.candidate_key),
        omitted_checked: Math.max(0, gap.checked.length - 4) })),
      inspection_checkpoint: { minimum_existing_checks: Math.min(2, candidates.length),
        checked_candidates: checkedCount, minimum_checks_met: checkedCount >= Math.min(2, candidates.length) || completeOverviewKeys.length >= Math.min(2, candidates.length) || completeMatchedKeys.length >= Math.min(2, candidates.length),
        complete_matched_candidate_keys: completeMatchedKeys,
        complete_overview_candidate_keys: completeOverviewKeys,
        overview_can_ground_gap: completeOverviewKeys.length >= Math.min(2, candidates.length),
        checked_files: [...fileGroups.values()].filter(group => group.checked_candidates > 0).length,
        unread_candidates: visibleCandidates.filter(candidate => !state.details[candidate.candidateKey]).length,
        all_candidates_must_be_read: false, decision_opportunities_remaining: remaining().models,
        file_groups: [...fileGroups.values()] },
      visual_condition_verification_available: false,
      matched_images_available: Boolean(currentMatched?.images.length),
      scene_inspection: { available: configuration.model === 'deepseek-v4-flash' && configuration.scene_inspection_enabled && Boolean(this.inspection), authorized: sceneInspectionAuthorized(textAuthorization?.visualScopeJson), remaining_candidates: Math.max(0, 3 - Object.keys(state.scene_inspections ?? {}).length), maximum_frames: 3, observed_candidate_keys: Object.keys(state.scene_inspections ?? {}).filter(key => state.scene_inspections![key].status === 'observed'), continuous_action_verified: false },
      evidence_reliability: { pre_generated_caption: 'unverified_model_description', transcript: 'unverified_transcription', identity_checks_verify_semantics: false },
      continuous_video_inspection_available: false,
    }
    // 预检使用实际序列化请求（含工具Schema）；只省略最旧的完整详情，明确更新可引用名单。
    // 原文、条件、20个可见身份和概要不截断。仍超限就保留基线，不能先标派发再发现本地超限。
    if (this.runner.preflight) {
      const hardLimit = configuration.evidence_mode === 'matched_multimodal' ? MATCHED_EVIDENCE_LIMITS.requestBytes : 100000
      const requestLimit = Math.min(hardLimit, this.runner.preflight(context, currentMatched?.images).maximum_request_bytes ?? hardLimit)
      while (this.runner.preflight(context, currentMatched?.images).request_bytes > requestLimit && detailEntries.length) {
        detailEntries.shift()
        context.details = Object.fromEntries(detailEntries)
        context.assessable_candidate_keys = [...new Set([...detailEntries.map(([key]) => key), ...Object.keys(currentMatched?.records ?? {})])]
        context.omitted_details = Object.keys(state.details).length - detailEntries.length
      }
      if (this.runner.preflight(context, currentMatched?.images).request_bytes > requestLimit) return finish('context_limit')
    }
    let inputFingerprint: string
    try { inputFingerprint = this.runner.fingerprint(context, currentMatched?.images) }
    catch (error) {
      // 验收/部署费用门在派发前拒绝时还没有外部请求，不能标成未知并丢掉已完成基线。
      // 只有明确费用预检代码可收尾；陌生故障仍交由执行器审计，不推断是否已付费。
      if (error instanceof AgentStepExecutionError && error.code === 'AGENT_DECISION_PREFLIGHT_COST') return finish('cost_limit')
      throw error
    }
    return {
      external: true,
      inputFingerprint,
      execute: async () => {
        state.model_calls++
        let decision: Awaited<ReturnType<RetrievalDecisionRunner['decide']>>
        try {
          if (currentMatched) {
            const [freshAuthorization] = await this.db.select().from(agentRunAuthorizations).where(eq(agentRunAuthorizations.runId, input.runId)).limit(1)
            if (!freshAuthorization?.allowExternalText || !(freshAuthorization.textScopeJson as { fields?: string[] })?.fields?.includes('retrieval_evidence_text') ||
              (currentMatched.images.length && !matchedEvidenceAuthorized(freshAuthorization.visualScopeJson)))
              throw new AgentStepExecutionError('AGENT_AUTHORIZATION_INVALID', '命中图文权限已经撤销，停止外发。')
          }
          decision = await this.runner.decide(context, currentMatched?.images)
        } catch (error) {
          if (!(error instanceof AgentStepExecutionError) || error.outcomeUnknown) throw error
          if (!['AGENT_RATE_LIMITED', 'AGENT_DECISION_INVALID'].includes(error.code)) throw error
          state.failures++
          state.last_decision_error = { code: error.code, message: error.message,
            // Runner只提供共享Schema白名单字段/固定类型，不发送错误正文或自造键名。
            // 与失败步骤一起提交，重启后有限纠正仍得到同样的可操作反馈。
            ...(error.diagnostics?.stage === 'action_schema' ? {
              issues: error.diagnostics.issues, omitted_issue_count: error.diagnostics.omitted_issue_count,
            } : {}),
          }
          // 可重试错误在这里被接住，不会进入执行器的 error 日志，必须主动记录。
          // 只输出 Runner 生成的安全摘要；任务/步骤身份用于把终端记录关联到数据库。
          this.logger.warn(JSON.stringify({
            event: 'retrieval_decision_failed', run_id: input.runId,
            step_attempt_id: input.stepAttemptId, lease_version: input.leaseVersion,
            input_fingerprint: inputFingerprint,
            error_code: error.code, model_call_count: state.model_calls,
            failure_count: state.failures,
            will_retry: state.failures <= (this.settings.agentRetrievalMaxRetries ?? 1),
            diagnostics: error.diagnostics ?? null,
          }))
          const exhausted = state.failures > (this.settings.agentRetrievalMaxRetries ?? 1)
          const fallback = exhausted ? await finish('model_failed').execute() : null
          return {
            ...(fallback ?? {}),
            transition: fallback?.transition ?? { status: 'searching', nextStep: 'searching' },
            outputJson: {
              ...(fallback?.outputJson as object ?? {}),
              retrieval_state: {
                ...state,
                ...(state.failures > (this.settings.agentRetrievalMaxRetries ?? 1)
                  ? { stop_reason: 'model_failed' }
                  : {}),
              },
              error_code: error.code,
              // 与本步骤状态在同一事务中保存，关闭终端后仍可从审计接口查看。
              ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
            },
          }
        }
        const action = (configuration.evidence_mode === 'matched_multimodal' ? retrievalMatchedActionSchema : retrievalActionSchema).parse(decision.action)
        /** 只纠正已确认响应的非法动作，保存结构化拒绝理由；未知外发由执行器停止。 */
        const rejectDecision = async (error: AgentStepExecutionError) => {
          state.decision_failures = (state.decision_failures ?? 0) + 1
          state.last_decision_error = { code: error.code, message: error.message }
          const retry = state.decision_failures <= (this.settings.agentRetrievalMaxRetries ?? 1)
          this.logger.warn(JSON.stringify({ event: 'retrieval_decision_rejected', run_id: input.runId,
            step_attempt_id: input.stepAttemptId, error_code: error.code, will_retry: retry }))
          const fallback = retry ? null : await finish('insufficient_evidence').execute()
          return { ...(fallback ?? { transition: { status: 'searching' as const, nextStep: 'searching' as const } }),
            outputJson: { ...(fallback?.outputJson as object ?? {}), retrieval_state: state, action,
              provider: decision.provider, decision_status: 'rejected', error_code: error.code,
              validation: state.last_decision_error, retry, elapsed_ms: elapsed } }
        }
        if (action.action === 'search_media' || action.action === 'get_segment_details' || action.action === 'get_segment_details_batch' || action.action === 'inspect_segment_frames') {
          const keys = detailKeys(action), units = toolUnits(action)
          const signatures = action.action === 'search_media'
            ? [retrievalQuerySignature(action.query, action.search_scope, action.media_types)] : keys.map(key => `${action.action === 'inspect_segment_frames' ? 'inspect' : 'details'}:${key}`)
          if (signatures.some(signature => state.signatures.includes(signature))) {
            const stopped = await finish('repeated_call').execute()
            return { ...stopped, outputJson: { ...(stopped.outputJson as object), action, provider: decision.provider,
              decision_status: 'rejected', error_code: 'AGENT_REPEATED_ACTION' } }
          }
          if (!remaining().tools) return finish('tool_limit').execute()
          if (units > remaining().tools || units > (action.action === 'search_media' ? remaining().searches : remaining().details))
            return rejectDecision(new AgentStepExecutionError('AGENT_TOOL_BUDGET_EXHAUSTED', '该类工具额度已耗尽；选择仍有额度的有效动作或停止。'))
          try {
            if (action.action === 'inspect_segment_frames' && (configuration.model !== 'deepseek-v4-flash' || !configuration.scene_inspection_enabled || !this.inspection || Object.keys(state.scene_inspections ?? {}).length >= 3))
              throw new AgentStepExecutionError('AGENT_SCENE_UNAVAILABLE', '场景看图未启用或额度已耗尽。')
            if (action.action === 'search_media' && (
              (intent.enforced_scope.search_scope !== 'all' && action.search_scope !== intent.enforced_scope.search_scope) ||
              action.media_types.some(type => !intent.enforced_scope.media_types.includes(type)) ||
              (action.search_scope === 'visual' && action.media_types.includes('audio')) ||
              (action.search_scope === 'spoken' && action.media_types.includes('image'))))
              throw new AgentStepExecutionError('AGENT_SCOPE_EXCEEDED', '工具参数超出不可放宽的任务范围。')
            if (keys.some(key => !candidates.some(candidate => candidate.candidateKey === key)))
              throw new AgentStepExecutionError('AGENT_CANDIDATE_INVALID', '详情候选必须属于当前任务。')
            // spoken 的首次关键词选择没有候选可检查；其后每个工具动作都必须说明缺口。
            if (!(action.action === 'search_media' && !state.queries.length && intent.enforced_scope.search_scope === 'spoken')) {
              const gap = action.gap
              if (!gap || new Set(gap.condition_ids).size !== gap.condition_ids.length ||
                gap.condition_ids.some(id => !intent.conditions.some(condition => condition.condition_id === id)))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '下一步必须关联本任务原始条件，不能创建或替换条件。')
              for (const checked of gap.checked) {
                const matched = currentMatched?.records[checked.candidate_key]
                if (checked.evidence_level === 'matched') {
                  // 失效/读取失败的来源没有可发送正文；其真实状态本身可解释缺口。
                  // 只允许对应的状态缺口使用空引用，不能把空身份当成动作或位置证据。
                  const statusOnly = !checked.evidence_ids.length && (
                    (gap.kind === 'stale' && matched?.status === 'stale') ||
                    (gap.kind === 'tool_failed' && matched?.status === 'read_failed'))
                  if (!matched || (!checked.evidence_ids.length && !statusOnly) || checked.evidence_ids.some(id => !matched.evidence.some(e => e.evidence_id === id)))
                    throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '命中证据未发送、已经失效或属于其他候选。')
                  if (matched.truncated && ['not_mentioned', 'contradiction'].includes(gap.kind))
                    throw new AgentStepExecutionError('AGENT_GAP_INVALID', '截断命中文字不能证明完整内容缺失或相反。')
                  checked.read_status = matched.status
                  continue
                }
                const stored = state.details[checked.candidate_key]
                const overview = state.overviews?.[checked.candidate_key]
                if ((!stored || checked.evidence_level === 'overview') && overview && visibleKeys.includes(checked.candidate_key) &&
                  (checked.evidence_ids.length || checked.evidence_level === 'overview')) {
                  checked.evidence_level = 'overview'
                  checked.read_status = overview.status
                  const fresh = await this.details.readOverview(input.runId, checked.candidate_key)
                  if (fresh.status !== overview.status)
                    throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '概要状态已经变化，旧状态不能作为缺口依据。')
                  if (checked.evidence_ids.some(id => !overview.evidence.some(row => row.evidence_id === id) || !fresh.evidence.some(row => row.evidence_id === id)))
                    throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '概要引用已经失效或不属于候选。')
                  // 截断会隐藏后文；缺失/相反判断必须继续读取详情，不能据摘要定性。
                  if (['not_mentioned', 'contradiction'].includes(gap.kind) && overview.truncated)
                    throw new AgentStepExecutionError('AGENT_GAP_INVALID', '概要被截断，不能证明全文缺少或否定条件；先读取详情。')
                  continue
                }
                if (!stored && ['details_unread', 'visual_unverified'].includes(gap.kind) && keys.includes(checked.candidate_key) && !checked.evidence_ids.length &&
                  visibleKeys.includes(checked.candidate_key)) {
                  // 只核对了本任务可见候选的身份，不把空证据列表伪装成已读详情。
                  checked.read_status = 'not_read'
                  checked.evidence_level = 'identity'
                  continue
                }
                if (!stored || !detailEntries.some(([key]) => key === checked.candidate_key))
                  throw new AgentStepExecutionError('AGENT_GAP_INVALID', '缺口依据引用了未读取或本轮未展示的详情。')
                checked.read_status = stored.status
                checked.evidence_level = 'detail'
                const fresh = await readDetails( checked.candidate_key)
                if (checked.evidence_ids.some(id => !stored.evidence.some(item => item.evidence_id === id) ||
                  !fresh.evidence.some(item => item.evidence_id === id)))
                  throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '缺口证据不属于候选或已经失效。')
              }
              if (gap.kind === 'visual_unverified' && !(action.action === 'search_media' && currentMatched && gap.checked.some(row => row.evidence_level === 'matched')) &&
                (action.action !== 'inspect_segment_frames' || !gap.checked.some(row => row.candidate_key === action.candidate_key)))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '画面未核实缺口须检查本任务候选采样图。')
              if (gap.kind === 'no_candidates' && (!state.queries.length || candidates.length))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '没有候选与候选尚未检查必须分开。')
              if (gap.kind === 'details_unread' && (!keys.length || keys.some(key => state.details[key])))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '尚未读取详情的缺口应先检查现有候选。')
              if (['not_mentioned', 'contradiction', 'stale'].includes(gap.kind) && !gap.checked.length)
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '缺口必须列出已检查的候选和证据。')
              if (gap.kind === 'contradiction' && !gap.checked.some(item => item.evidence_ids.some(id =>
                (item.evidence_level === 'matched' ? currentMatched?.records[item.candidate_key] : item.evidence_level === 'overview' ? state.overviews?.[item.candidate_key] : state.details[item.candidate_key])?.evidence.some(evidence => evidence.evidence_id === id && evidence.source !== 'media_metadata'))))
                // 文件大小/身份不能证明动作或位置相反；正文引用也只是模型判断的可追溯依据。
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '相反证据缺口必须引用已检查的真实正文，不能只有候选身份或媒体信息。')
              if (gap.kind === 'stale' && !gap.checked.some(item => (item.evidence_level === 'matched' ? currentMatched?.records[item.candidate_key] : item.evidence_level === 'overview' ? state.overviews?.[item.candidate_key] : state.details[item.candidate_key])?.status === 'stale'))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '失效缺口必须有明确失效状态。')
              if (gap.kind === 'tool_failed' && context.last_tool_status !== 'failed' && !gap.checked.some(row =>
                (row.evidence_level === 'matched' ? currentMatched?.records[row.candidate_key] : row.evidence_level === 'overview' ? state.overviews?.[row.candidate_key] : state.details[row.candidate_key])?.status === 'read_failed'))
                throw new AgentStepExecutionError('AGENT_GAP_INVALID', '工具实际失败不能用空结果或正文缺失替代。')
              if (action.action === 'search_media' && candidates.length &&
                ((new Set(gap.checked.filter(row => row.evidence_level === 'matched' && (
                  currentMatched?.records[row.candidate_key]?.status === 'available' ||
                  (gap.kind === 'stale' && currentMatched?.records[row.candidate_key]?.status === 'stale') ||
                  (gap.kind === 'tool_failed' && currentMatched?.records[row.candidate_key]?.status === 'read_failed'))).map(row => row.candidate_key)).size < Math.min(2, candidates.length) && Object.keys(state.details).length < Math.min(2, candidates.length) &&
                  new Set(gap.checked.filter(row => row.evidence_level === 'overview' && completeOverviewKeys.includes(row.candidate_key)).map(row => row.candidate_key)).size < Math.min(2, candidates.length)) || !gap.checked.length))
                throw new AgentStepExecutionError('AGENT_READ_BEFORE_SEARCH', '先检查现有候选的完整概要或必要详情，再以真实缺口决定是否补搜。')
              state.gaps = [...(state.gaps ?? []), { step_id: input.stepAttemptId, action: action.action, gap }]
            }
          } catch (error) {
            if (!(error instanceof AgentStepExecutionError)) throw error
            return rejectDecision(error)
          }
          delete state.last_decision_error
        }
        delete state.question
        if (action.action === 'clarify') {
          const result = await wait(action.question).execute()
          return {
            ...result,
            outputJson: { ...(result.outputJson as object), action, provider: decision.provider },
          }
        }
        if (action.action === 'finish') {
          try {
            // 空名单可能只是还没执行搜索，尤其全文检索的第一关键词由模型选择。
            // 只认已提交的成功搜索快照，不能把“尚未搜索”伪装成“没有候选”。
            if (action.reason === 'no_results' && !state.queries.length)
              throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '尚未完成搜索，不能报告搜索无结果；先执行原范围的关键词搜索。')
            // 引用存在不等于语义正确。重新读取每个候选及证据指纹，拒绝旧版本和跨候选引用。
            for (const assessment of action.assessments) {
              const matched = currentMatched?.records[assessment.candidate_key]
              // 只接受本轮实际发送的详情与命中证据。历史详情因字节上限被省略后，
              // 即使该候选仍有命中图，也不能让模型引用未展示的旧正文。
              const visibleDetail = context.details[assessment.candidate_key]
              const stored = matched ? { ...matched, evidence: [...(visibleDetail?.evidence ?? []), ...matched.evidence] } : visibleDetail
              if (!candidates.some(candidate => candidate.candidateKey === assessment.candidate_key))
                throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '判断引用了本任务不存在的候选。')
              const fresh = await readDetails( assessment.candidate_key)
              if (fresh.status === 'read_failed') throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '候选详情读取失败。')
              if (fresh.status === 'stale' || !fresh.evidence.length)
                throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '候选已过期或当前不存在。')
              if (assessment.conditions.some(condition => condition.status !== 'unknown') && !context.assessable_candidate_keys.includes(assessment.candidate_key))
                throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '本轮未展示的详情只能报告unknown，不能作已验证判断。')
              const conditionIds = assessment.conditions.map((condition) => condition.condition_id)
              if (
                new Set(conditionIds).size !== intent.conditions.length ||
                conditionIds.length !== intent.conditions.length ||
                intent.conditions.some((condition) => !conditionIds.includes(condition.condition_id))
              )
                throw new AgentStepExecutionError(
                  'AGENT_CONDITIONS_INVALID',
                  '候选判断必须保留全部原始条件。',
                )
              for (const judgment of assessment.conditions) {
                const valid = new Set(
                  (stored?.evidence ?? [])
                    .filter((item) =>
                      fresh.evidence.some((current) => current.evidence_id === item.evidence_id),
                    )
                    .map((item) => item.evidence_id),
                )
                if (
                  judgment.evidence_ids.some((id) => !valid.has(id)) ||
                  (judgment.status !== 'unknown' && !judgment.evidence_ids.length)
                )
                  throw new AgentStepExecutionError(
                    'AGENT_EVIDENCE_INVALID',
                    stored ? '证据不属于当前候选或内容已变化。' : '候选未读取详情，只能提交无引用的 unknown 判断。',
                  )
                const condition = intent.conditions.find(
                  (condition) => condition.condition_id === judgment.condition_id,
                )!
                // Caption/转录是线索，不能独自支撑画面动作、对象或位置事实。
                // 仅限定证据类型，不声称引用了帧就一定看对；连续与全场景否定仍在下方保守处理。
                if (currentMatched && condition.evidence_type === 'visual' && judgment.status !== 'unknown' &&
                  !judgment.evidence_ids.some(id => ['matched_visual_frame', 'scene_visual_observation'].includes(
                    stored?.evidence.find(item => item.evidence_id === id)?.source ?? ''))) {
                  judgment.status = 'unknown'
                  state.rejected_judgments = [...(state.rejected_judgments ?? []), { candidate_key: assessment.candidate_key,
                    condition_id: judgment.condition_id, reason: 'visual_requires_pixel_evidence' }]
                }
                // 描述缺失或仅媒体尺寸证据都不能证明视觉条件失败；保存被降级的判断供审计。
                if ((judgment.status === 'not_satisfied' && judgment.basis !== 'explicit_contradiction') ||
                  (judgment.status !== 'unknown' && ['not_mentioned', 'not_read', 'stale', 'tool_failed'].includes(judgment.basis ?? '')) ||
                  (judgment.status !== 'unknown' && condition.evidence_type === 'visual' &&
                    judgment.evidence_ids.every(id => stored?.evidence.find(item => item.evidence_id === id)?.source === 'media_metadata'))) {
                  state.rejected_judgments = [...(state.rejected_judgments ?? []), { candidate_key: assessment.candidate_key,
                    condition_id: judgment.condition_id, reason: 'absence_is_not_contradiction' }]
                  judgment.status = 'unknown'
                }
                // 无视频检查工具时，对明确要求连续动作的条件实行保守程序边界；语义仍需人工评测。
                if (/连续|持续|完整动作|不间断|先.*再|然后|before|after|continuous|uninterrupted/i.test(condition.source_text))
                  judgment.status = 'unknown'
                if (judgment.status === 'not_satisfied' && candidates.find(row => row.candidateKey === assessment.candidate_key)?.sceneId &&
                  judgment.evidence_ids.some(id => stored?.evidence.find(e => e.evidence_id === id)?.source === 'matched_visual_frame')) {
                  judgment.status = 'unknown'
                  state.rejected_judgments = [...(state.rejected_judgments ?? []), { candidate_key: assessment.candidate_key, condition_id: judgment.condition_id, reason: 'sampled_frames_not_exhaustive' }]
                }
              }
            }
            if (
              new Set(action.assessments.map((item) => item.candidate_key)).size !==
              action.assessments.length
            ) {
              throw new AgentStepExecutionError('AGENT_CANDIDATE_INVALID', '最终候选不能重复。')
            }
            // assessments 也可包含被排除的候选；只要有完整命中，就不能被其他候选否决。
            const hasSupportedCandidate = action.assessments.some((item) =>
              item.conditions.every((condition) => condition.status === 'satisfied'),
            )
            if (configuration.evidence_mode === 'matched_multimodal') {
              state.stop_basis = validateMatchedStopBasis({ action, conditions: intent.conditions,
                matched: currentMatched?.records ?? {}, details: context.details,
                candidateKeys: visibleKeys, remaining: remaining() })
            }
            state.assessments = action.assessments
            state.stop_reason =
              (action.reason === 'found' && !hasSupportedCandidate) ||
              (action.reason === 'no_results' && (!state.queries.length || candidates.length > 0)) ||
              (action.reason === 'conditions_not_met' && (!candidates.length ||
                candidates.some(candidate => !action.assessments.some(item => item.candidate_key === candidate.candidateKey &&
                  item.conditions.some(judgment => judgment.status === 'not_satisfied' &&
                    intent.conditions.find(condition => condition.condition_id === judgment.condition_id)?.kind !== 'optional')))))
                ? 'insufficient_evidence'
                : action.reason
            // 文字描述可能误认桌面/灶台或虚构动作；孤立采样帧也不能验证连续过程。
            // 保留satisfied作为文字判断供审计，绝不把有效引用升级成视觉事实。
            // 不迫使模型再搜；仍可结束规划，沿用冻结基线和独立图片重排。
            if (intent.conditions.some(condition => condition.evidence_type === 'visual')) {
              state.visual_verification = { status: 'unverified', reason: Object.values(state.scene_inspections ?? {}).some(item => item.status === 'observed') || Object.values(currentMatched?.records ?? {}).some(record => record.evidence.some(e => e.source === 'matched_visual_frame')) ? 'sampled_frames' : 'text_only_tools', model_stop_reason: action.reason }
              if (state.stop_reason === 'found' || state.stop_reason === 'conditions_not_met')
                state.stop_reason = 'visual_evidence_unverified'
            }
          } catch (error) {
            if (!(error instanceof AgentStepExecutionError)) throw error
            return rejectDecision(error)
          }
          delete state.last_decision_error
          const finalized = await finish(state.stop_reason!).execute()
          return { ...finalized, outputJson: { ...(finalized.outputJson as object), action, provider: decision.provider } }
        } else state.pending = action
        return {
          transition: {
            status: 'searching',
            nextStep: 'searching',
          },
          outputJson: {
            retrieval_state: state,
            action,
            provider: decision.provider,
            elapsed_ms: elapsed,
          },
        }
      },
    }
  }
}
