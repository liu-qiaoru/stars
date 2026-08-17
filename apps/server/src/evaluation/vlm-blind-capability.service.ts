import { createHash, randomUUID } from 'node:crypto'
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  parseVlmCandidateReviewOutput,
  vlmBlindRetryUnknownInputSchema,
  vlmBlindVisualAuthorizationInputSchema,
} from '@local-media-agent/shared/schemas'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  evaluationVlmBlindDatasets,
  evaluationVlmBlindLabelingSessions,
  evaluationVlmBlindRealAttempts,
  evaluationVlmBlindRealResults,
  evaluationVlmBlindRealRuns,
  evaluationVlmBlindVisualAuthorizations,
} from '../database/schema.js'
import {
  buildQwenVlmReviewRequestBody,
  QwenVlmReviewProviderError,
  VLM_REAL_REVIEW_PROVIDER,
  VLM_REVIEW_MODEL,
  VLM_REVIEW_PROMPT_VERSION,
  VLM_REVIEW_PROTOCOL_VERSION,
} from './qwen-vlm-review.provider.js'
import { VlmBlindLabelingService } from './vlm-blind-labeling.service.js'
import { deriveVlmReviewStatus, type VlmReviewProvider } from './vlm-review.provider.js'

const EDGE_GROUP = 'partial_relevance'
const MAX_CALLS = 84
const SMOKE_MAX_CALLS = 5
const SMOKE_MAX_COST_CNY = 0.5
const SMOKE_PROTOCOL_VERSION = 'vlm-review-smoke-v1'
const SMOKE_GROUPS = [
  'exact_match',
  'missing_must_have',
  'exclusion_hit',
  'partial_relevance',
  'insufficient_evidence',
] as const
type ExecutionMode = 'full' | 'smoke'

/**
 * Phase F 真实能力盲测编排器。
 *
 * GET preflight 只读本地冻结事实；授权单独写 PostgreSQL；真实 POST 先持久化 run/attempt，
 * 每次网络 dispatch 前再原子写入 dispatched。任何 unknown 立即停止后续槽位，重启恢复也
 * 只会标记 unknown，绝不自动重放。
 */
@Injectable()
export class VlmBlindCapabilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(VLM_REAL_REVIEW_PROVIDER) private readonly provider: VlmReviewProvider,
    @Inject(VlmBlindLabelingService)
    private readonly labeling: VlmBlindLabelingService,
  ) {}

  async onModuleInit() {
    await this.recoverInterrupted()
  }

  /** 构造精确真实 HTTP body，但只返回字节数和指纹，不返回查询、条件或 Base64。 */
  async preflight(datasetId: string) {
    return this.preflightForMode(datasetId, 'full')
  }

  /**
   * Smoke 从五个冻结类型中各选请求体最小的一条，目的是用最少媒体外发验证真实协议。
   * 选择规则完全确定：先比真实请求字节数，再比 case UUID；同一冻结输入永远得到同一清单。
   */
  async smokePreflight(datasetId: string) {
    return this.preflightForMode(datasetId, 'smoke')
  }

  private async preflightForMode(datasetId: string, mode: ExecutionMode) {
    const prepared = await this.prepare(datasetId, mode)
    const existingAuthorization = await this.findMatchingAuthorization(
      prepared.input.session.id,
      prepared.preflightFingerprint,
    )
    return {
      dataset_id: datasetId,
      labeling_session_id: prepared.input.session.id,
      dataset_fingerprint: prepared.input.dataset.frozenFingerprint,
      labels_fingerprint: prepared.input.session.labelsFingerprint,
      evidence_fingerprint: prepared.input.evidence_fingerprint,
      preflight_fingerprint: prepared.preflightFingerprint,
      provider: 'rightapi',
      requested_model: VLM_REVIEW_MODEL,
      execution_mode: mode,
      protocol_version: mode === 'smoke' ? SMOKE_PROTOCOL_VERSION : VLM_REVIEW_PROTOCOL_VERSION,
      prompt_version: VLM_REVIEW_PROMPT_VERSION,
      provider_configured: Boolean(this.settings.rightCodeBaseUrl && this.settings.rightCodeApiKey),
      provider_enabled: this.settings.vlmReviewProvider === 'rightapi',
      external_llm_enabled: this.settings.allowExternalLlm,
      provider_available: this.provider.available && this.provider.external,
      visual_authorization_exists: Boolean(existingAuthorization),
      authorization_id: existingAuthorization?.id ?? null,
      candidate_count: prepared.items.length,
      normal_call_count: prepared.items.length,
      stability_case_count: prepared.edgeItems.length,
      stability_extra_call_count: mode === 'smoke' ? 0 : prepared.edgeItems.length * 2,
      maximum_call_count: prepared.planned.length,
      total_image_count: prepared.planned.reduce(
        (sum, item) => sum + item.input.request.evidence_frames.length,
        0,
      ),
      total_request_bytes: prepared.planned.reduce((sum, item) => sum + item.requestBytes, 0),
      items: prepared.items.map((item) => ({
        case_id: item.input.case.id,
        candidate_key: item.input.case.candidateKey,
        group: item.input.group,
        image_count: item.input.request.evidence_frames.length,
        request_bytes: item.requestBytes,
        normal_calls: 1,
        stability_extra_calls: mode === 'full' && item.input.group === EDGE_GROUP ? 2 : 0,
      })),
      budget:
        mode === 'smoke'
          ? { max_calls: SMOKE_MAX_CALLS, max_cost_cny: SMOKE_MAX_COST_CNY }
          : {
              max_calls: this.settings.vlmReviewMaxCalls ?? MAX_CALLS,
              max_cost_cny: this.settings.vlmReviewMaxCostCny ?? 5,
            },
      stop_conditions: [
        'provider_disabled_or_unconfigured',
        'fingerprint_drift',
        'visual_authorization_missing_or_expired',
        'call_or_budget_limit_reached',
        'outcome_unknown',
      ],
      external_call_count: 0,
    }
  }

  /**
   * 用户必须回传当前 preflight 指纹，授权才会写入。重复确认同一指纹返回同一行；
   * 指纹漂移、超过部署硬上限或 Provider 未开启都在任何外发前拒绝。
   */
  async authorize(datasetId: string, input: unknown) {
    return this.authorizeForMode(datasetId, input, 'full')
  }

  async authorizeSmoke(datasetId: string, input: unknown) {
    return this.authorizeForMode(datasetId, input, 'smoke')
  }

  private async authorizeForMode(datasetId: string, input: unknown, mode: ExecutionMode) {
    const parsed = vlmBlindVisualAuthorizationInputSchema.parse(input)
    const prepared = await this.prepare(datasetId, mode)
    if (parsed.preflight_fingerprint !== prepared.preflightFingerprint) {
      throw new ConflictException('preflight fingerprint no longer matches frozen input')
    }
    if (!this.provider.available || !this.provider.external) {
      throw new ConflictException('真实 qwen3.7-plus 视觉 Provider 未启用或未配置')
    }
    const deploymentMaxCalls =
      mode === 'smoke' ? SMOKE_MAX_CALLS : (this.settings.vlmReviewMaxCalls ?? MAX_CALLS)
    const deploymentMaxCost =
      mode === 'smoke' ? SMOKE_MAX_COST_CNY : (this.settings.vlmReviewMaxCostCny ?? 5)
    if (
      parsed.max_calls !== prepared.planned.length ||
      parsed.max_calls > deploymentMaxCalls ||
      parsed.max_cost_cny > deploymentMaxCost
    ) {
      throw new ConflictException('visual authorization exceeds or cannot cover deployment limits')
    }
    const [inserted] = await this.db
      .insert(evaluationVlmBlindVisualAuthorizations)
      .values({
        id: randomUUID(),
        labelingSessionId: prepared.input.session.id,
        datasetFingerprint: prepared.input.dataset.frozenFingerprint!,
        labelsFingerprint: prepared.input.session.labelsFingerprint!,
        evidenceFingerprint: prepared.input.evidence_fingerprint,
        preflightFingerprint: prepared.preflightFingerprint,
        maxCalls: parsed.max_calls,
        maxCostCny: parsed.max_cost_cny.toString(),
        expiresAt: new Date(Date.now() + parsed.expires_in_minutes * 60_000),
      })
      .onConflictDoNothing()
      .returning()
    return (
      inserted ??
      (await this.findMatchingAuthorization(
        prepared.input.session.id,
        prepared.preflightFingerprint,
      ))
    )
  }

  async startAndSchedule(datasetId: string) {
    const run = await this.start(datasetId, 'full')
    setImmediate(() => void this.executePending(run.id).catch(() => this.failRun(run.id)))
    return this.getRun(run.id)
  }

  async startSmokeAndSchedule(datasetId: string) {
    const run = await this.start(datasetId, 'smoke')
    setImmediate(() => void this.executePending(run.id).catch(() => this.failRun(run.id)))
    return this.getRun(run.id)
  }

  /**
   * unknown 绝不由恢复流程自动重放。只有这个显式入口可把旧 attempt 标记为已人工接管，
   * 并创建新的 step_attempt_id；历史 unknown 行和外部调用计数永久保留。
   */
  async retryUnknownAndSchedule(runId: string, input: unknown) {
    const result = await this.retryUnknown(runId, input)
    setImmediate(() => void this.executePending(runId).catch(() => this.failRun(runId)))
    return result
  }

  /** 测试可直接调用并自行执行 pending，避免留下后台定时任务。 */
  async retryUnknown(runId: string, input: unknown) {
    vlmBlindRetryUnknownInputSchema.parse(input)
    const [run] = await this.db
      .select()
      .from(evaluationVlmBlindRealRuns)
      .where(eq(evaluationVlmBlindRealRuns.id, runId))
      .limit(1)
    if (!run) throw new NotFoundException('real VLM run not found')
    if (run.status !== 'outcome_unknown') {
      throw new ConflictException('only an outcome_unknown run can be explicitly retried')
    }
    if (!this.provider.available || !this.provider.external) {
      throw new ConflictException('真实 qwen3.7-plus 视觉 Provider 未启用或未配置')
    }
    if (run.externalCallCount >= run.maxCalls) {
      throw new ConflictException('real VLM run has no remaining authorized call capacity')
    }
    const [unknown] = await this.db
      .select()
      .from(evaluationVlmBlindRealAttempts)
      .where(
        and(
          eq(evaluationVlmBlindRealAttempts.runId, runId),
          eq(evaluationVlmBlindRealAttempts.status, 'outcome_unknown'),
        ),
      )
      .orderBy(desc(evaluationVlmBlindRealAttempts.createdAt))
      .limit(1)
    if (!unknown) throw new ConflictException('outcome_unknown attempt not found')
    await this.db.transaction(async (tx) => {
      const [superseded] = await tx
        .update(evaluationVlmBlindRealAttempts)
        .set({ status: 'superseded_unknown', updatedAt: new Date() })
        .where(
          and(
            eq(evaluationVlmBlindRealAttempts.id, unknown.id),
            eq(evaluationVlmBlindRealAttempts.status, 'outcome_unknown'),
          ),
        )
        .returning()
      if (!superseded) throw new ConflictException('outcome_unknown attempt was already handled')
      const id = randomUUID()
      await tx.insert(evaluationVlmBlindRealAttempts).values({
        id,
        runId,
        caseId: unknown.caseId,
        repetition: unknown.repetition,
        attemptNumber: unknown.attemptNumber + 1,
        retryOfAttemptId: unknown.id,
        stepAttemptId: id,
        requestFingerprint: unknown.requestFingerprint,
        requestBytes: unknown.requestBytes,
        imageCount: unknown.imageCount,
        actualSampleCount: unknown.actualSampleCount,
      })
      await tx
        .update(evaluationVlmBlindRealRuns)
        .set({ status: 'running', unknownCount: 0, finishedAt: null, updatedAt: new Date() })
        .where(eq(evaluationVlmBlindRealRuns.id, runId))
    })
    return this.getRun(runId)
  }

  /** 可由测试直接调用；生产 Controller 使用 startAndSchedule 立即返回轮询身份。 */
  async start(datasetId: string, mode: ExecutionMode = 'full') {
    const prepared = await this.prepare(datasetId, mode)
    if (!this.provider.available || !this.provider.external) {
      throw new ConflictException('真实 qwen3.7-plus 视觉 Provider 未启用或未配置')
    }
    const authorization = await this.findMatchingAuthorization(
      prepared.input.session.id,
      prepared.preflightFingerprint,
    )
    if (!authorization) throw new ConflictException('独立视觉授权不存在、已过期或指纹不匹配')
    if (prepared.planned.length > authorization.maxCalls) {
      throw new ConflictException('visual authorization call limit is insufficient')
    }
    const runId = randomUUID()
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(evaluationVlmBlindRealRuns)
        .values({
          id: runId,
          labelingSessionId: prepared.input.session.id,
          authorizationId: authorization.id,
          protocolVersion: mode === 'smoke' ? SMOKE_PROTOCOL_VERSION : VLM_REVIEW_PROTOCOL_VERSION,
          promptVersion: VLM_REVIEW_PROMPT_VERSION,
          datasetFingerprint: prepared.input.dataset.frozenFingerprint!,
          labelsFingerprint: prepared.input.session.labelsFingerprint!,
          evidenceFingerprint: prepared.input.evidence_fingerprint,
          caseCount: prepared.items.length,
          plannedCallCount: prepared.planned.length,
          maxCalls: authorization.maxCalls,
          maxCostCny: authorization.maxCostCny,
        })
        .onConflictDoNothing()
        .returning()
      if (!run) {
        const [existing] = await tx
          .select()
          .from(evaluationVlmBlindRealRuns)
          .where(eq(evaluationVlmBlindRealRuns.authorizationId, authorization.id))
          .limit(1)
        if (!existing) throw new ConflictException('real VLM run idempotency conflict')
        return existing
      }
      await tx.insert(evaluationVlmBlindRealAttempts).values(
        prepared.planned.map((item) => {
          const id = randomUUID()
          return {
            id,
            runId,
            caseId: item.input.case.id,
            repetition: item.repetition,
            stepAttemptId: id,
            requestBytes: item.requestBytes,
            imageCount: item.input.request.evidence_frames.length,
            actualSampleCount: 1,
            requestFingerprint: item.requestFingerprint,
          }
        }),
      )
      return run
    })
  }

  async executePending(runId: string) {
    const [run] = await this.db
      .select()
      .from(evaluationVlmBlindRealRuns)
      .where(eq(evaluationVlmBlindRealRuns.id, runId))
      .limit(1)
    if (!run) throw new NotFoundException('real VLM run not found')
    const input = await this.labeling.prepareCapabilityInputForRun(run.labelingSessionId)
    if (
      input.dataset.frozenFingerprint !== run.datasetFingerprint ||
      input.session.labelsFingerprint !== run.labelsFingerprint ||
      input.evidence_fingerprint !== run.evidenceFingerprint
    ) {
      await this.failRun(runId, 'VLM_REVIEW_FINGERPRINT_DRIFT')
      return this.getRun(runId)
    }
    await this.db
      .update(evaluationVlmBlindRealRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(evaluationVlmBlindRealRuns.id, runId),
          eq(evaluationVlmBlindRealRuns.status, 'pending'),
        ),
      )
    const attempts = await this.db
      .select()
      .from(evaluationVlmBlindRealAttempts)
      .where(
        and(
          eq(evaluationVlmBlindRealAttempts.runId, runId),
          eq(evaluationVlmBlindRealAttempts.status, 'pending'),
        ),
      )
      // 显式 retry-unknown 必须先验证原未知槽位，再继续其余 pending；否则 83 个旧槽位
      // 会先耗尽 84 次硬上限，使用户明确重试的 attempt 永远无法 dispatch。
      .orderBy(
        desc(evaluationVlmBlindRealAttempts.attemptNumber),
        asc(evaluationVlmBlindRealAttempts.createdAt),
      )
    const itemByCase = new Map(input.items.map((item) => [item.case.id, item]))
    for (const attempt of attempts) {
      const hasUnknown = await this.hasUnknown(runId)
      if (hasUnknown) break
      const item = itemByCase.get(attempt.caseId)
      if (!item) {
        await this.failAttempt(attempt.id, 'VLM_REVIEW_CASE_IDENTITY_MISSING')
        continue
      }
      await this.executeAttempt(run, attempt, item)
    }
    await this.refreshRun(runId, input.items)
    return this.getRun(runId)
  }

  /** Server 启动恢复：只有 running+dispatched 才是不明结果，pending 从未外发。 */
  async recoverInterrupted() {
    const interrupted = await this.db
      .select()
      .from(evaluationVlmBlindRealAttempts)
      .where(
        and(
          eq(evaluationVlmBlindRealAttempts.status, 'running'),
          eq(evaluationVlmBlindRealAttempts.externalCallStatus, 'dispatched'),
        ),
      )
    for (const attempt of interrupted) {
      await this.db
        .update(evaluationVlmBlindRealAttempts)
        .set({
          status: 'outcome_unknown',
          externalCallStatus: 'outcome_unknown',
          errorJson: { code: 'VLM_REVIEW_OUTCOME_UNKNOWN' },
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationVlmBlindRealAttempts.id, attempt.id))
      await this.refreshRun(attempt.runId)
    }
    return interrupted.length
  }

  async listRuns(datasetId: string) {
    // 历史页面只通过 dataset→labeling session 外键定位真实 run；这里绝不读取 evidence
    // 文件或重建 Base64 请求，避免“打开报告”产生昂贵本地 I/O 或隐藏外发风险。
    const [dataset] = await this.db
      .select({ id: evaluationVlmBlindDatasets.id })
      .from(evaluationVlmBlindDatasets)
      .where(eq(evaluationVlmBlindDatasets.id, datasetId))
      .limit(1)
    if (!dataset) throw new NotFoundException('VLM blind dataset not found')
    const [session] = await this.db
      .select({ id: evaluationVlmBlindLabelingSessions.id })
      .from(evaluationVlmBlindLabelingSessions)
      .where(eq(evaluationVlmBlindLabelingSessions.datasetId, datasetId))
      .limit(1)
    if (!session) return { items: [] }
    const rows = await this.db
      .select()
      .from(evaluationVlmBlindRealRuns)
      .where(eq(evaluationVlmBlindRealRuns.labelingSessionId, session.id))
      .orderBy(desc(evaluationVlmBlindRealRuns.createdAt))
    return { items: rows.map(toRunResponse) }
  }

  async getRun(runId: string) {
    const [run] = await this.db
      .select()
      .from(evaluationVlmBlindRealRuns)
      .where(eq(evaluationVlmBlindRealRuns.id, runId))
      .limit(1)
    if (!run) throw new NotFoundException('real VLM run not found')
    const attempts = await this.db
      .select()
      .from(evaluationVlmBlindRealAttempts)
      .where(eq(evaluationVlmBlindRealAttempts.runId, runId))
      .orderBy(asc(evaluationVlmBlindRealAttempts.createdAt))
    return {
      ...toRunResponse(run),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        case_id: attempt.caseId,
        repetition: attempt.repetition,
        attempt_number: attempt.attemptNumber,
        step_attempt_id: attempt.stepAttemptId,
        status: attempt.status,
        external_call_status: attempt.externalCallStatus,
        response_model: attempt.responseModel,
        provider_request_id: attempt.providerRequestId,
        request_bytes: attempt.requestBytes,
        image_count: attempt.imageCount,
        actual_sample_count: attempt.actualSampleCount,
        input_tokens: attempt.inputTokens,
        output_tokens: attempt.outputTokens,
        total_tokens: attempt.totalTokens,
        billed_cost_cny: numberOrNull(attempt.billedCostCny),
        latency_ms: attempt.latencyMs,
        derived_status: attempt.derivedStatus,
        error: attempt.errorJson,
      })),
    }
  }

  private async executeAttempt(
    run: typeof evaluationVlmBlindRealRuns.$inferSelect,
    attempt: typeof evaluationVlmBlindRealAttempts.$inferSelect,
    item: Awaited<ReturnType<VlmBlindLabelingService['prepareCapabilityInput']>>['items'][number],
  ) {
    const claimed = await this.claimDispatch(run, attempt)
    if (!claimed) return
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.vlmReviewTimeoutMs ?? 120_000,
    )
    let receivedAudit: Awaited<ReturnType<VlmReviewProvider['review']>>['audit'] | null = null
    try {
      const providerResult = await this.provider.review(item.request, controller.signal)
      receivedAudit = providerResult.audit
      const output = parseVlmCandidateReviewOutput(item.request, providerResult.output)
      const kindById = new Map(
        item.request.conditions.map((condition) => [condition.condition_id, condition.kind]),
      )
      const derivedStatus = deriveVlmReviewStatus(
        output.conditions.map((condition) => ({
          kind: kindById.get(condition.condition_id)!,
          verdict: condition.verdict,
        })),
      )
      await this.db.transaction(async (tx) => {
        await tx
          .update(evaluationVlmBlindRealAttempts)
          .set({
            status: 'succeeded',
            externalCallStatus: 'completed',
            responseFingerprint: providerResult.audit.response_fingerprint,
            responseModel: providerResult.audit.response_model,
            providerRequestId: providerResult.audit.provider_request_id,
            inputTokens: providerResult.audit.input_tokens,
            outputTokens: providerResult.audit.output_tokens,
            totalTokens: providerResult.audit.total_tokens,
            billedCostCny: providerResult.audit.billed_cost_cny?.toString() ?? null,
            derivedStatus,
            latencyMs: Date.now() - started,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(evaluationVlmBlindRealAttempts.id, attempt.id),
              eq(evaluationVlmBlindRealAttempts.externalCallStatus, 'dispatched'),
            ),
          )
        await tx.insert(evaluationVlmBlindRealResults).values({
          id: randomUUID(),
          attemptId: attempt.id,
          caseId: attempt.caseId,
          derivedStatus,
          outputJson: output,
        })
      })
    } catch (error) {
      const unknown = error instanceof QwenVlmReviewProviderError && error.outcomeUnknown
      const responseReceived =
        receivedAudit !== null ||
        (error instanceof QwenVlmReviewProviderError && error.responseReceived)
      await this.db
        .update(evaluationVlmBlindRealAttempts)
        .set({
          status: unknown ? 'outcome_unknown' : 'failed',
          externalCallStatus: unknown
            ? 'outcome_unknown'
            : responseReceived
              ? 'completed'
              : 'dispatched',
          responseFingerprint:
            receivedAudit?.response_fingerprint ??
            (error instanceof QwenVlmReviewProviderError ? error.responseFingerprint : null),
          responseModel: receivedAudit?.response_model ?? null,
          providerRequestId: receivedAudit?.provider_request_id ?? null,
          inputTokens: receivedAudit?.input_tokens ?? null,
          outputTokens: receivedAudit?.output_tokens ?? null,
          totalTokens: receivedAudit?.total_tokens ?? null,
          billedCostCny: receivedAudit?.billed_cost_cny?.toString() ?? null,
          errorJson: {
            code:
              error instanceof QwenVlmReviewProviderError
                ? error.code
                : 'VLM_REVIEW_OUTPUT_INVALID',
          },
          latencyMs: Date.now() - started,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationVlmBlindRealAttempts.id, attempt.id))
      await this.db.insert(evaluationVlmBlindRealResults).values({
        id: randomUUID(),
        attemptId: attempt.id,
        caseId: attempt.caseId,
        derivedStatus: 'review_failed',
        errorJson: {
          code:
            error instanceof QwenVlmReviewProviderError ? error.code : 'VLM_REVIEW_OUTPUT_INVALID',
        },
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 表锁让并发执行器共享同一 run 的调用/预算上限；dispatched 在 fetch 之前提交。 */
  private async claimDispatch(
    run: typeof evaluationVlmBlindRealRuns.$inferSelect,
    attempt: typeof evaluationVlmBlindRealAttempts.$inferSelect,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table evaluation_vlm_blind_real_runs in share row exclusive mode`)
      const dispatched = await tx
        .select({ billedCostCny: evaluationVlmBlindRealAttempts.billedCostCny })
        .from(evaluationVlmBlindRealAttempts)
        .where(
          and(
            eq(evaluationVlmBlindRealAttempts.runId, run.id),
            inArray(evaluationVlmBlindRealAttempts.externalCallStatus, [
              'dispatched',
              'completed',
              'outcome_unknown',
            ]),
          ),
        )
      if (dispatched.length >= run.maxCalls) {
        await tx
          .update(evaluationVlmBlindRealAttempts)
          .set({ status: 'failed', errorJson: { code: 'VLM_REVIEW_CALL_LIMIT_REACHED' } })
          .where(eq(evaluationVlmBlindRealAttempts.id, attempt.id))
        return false
      }
      // Provider 可能不返回实时账单费用。此时每次按“总授权预算 / 最大调用数”保守预留；
      // 若返回实际费用则使用实际值，发现已超预算后不再 dispatch 下一次请求。
      const maxCost = Number(run.maxCostCny)
      const perCallReservation = maxCost / run.maxCalls
      const reservedCost = dispatched.reduce(
        (sum, item) => sum + (numberOrNull(item.billedCostCny) ?? perCallReservation),
        0,
      )
      if (reservedCost + perCallReservation > maxCost + Number.EPSILON) {
        await tx
          .update(evaluationVlmBlindRealAttempts)
          .set({ status: 'failed', errorJson: { code: 'VLM_REVIEW_BUDGET_LIMIT_REACHED' } })
          .where(eq(evaluationVlmBlindRealAttempts.id, attempt.id))
        return false
      }
      const [claimed] = await tx
        .update(evaluationVlmBlindRealAttempts)
        .set({
          status: 'running',
          externalCallStatus: 'dispatched',
          dispatchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationVlmBlindRealAttempts.id, attempt.id),
            eq(evaluationVlmBlindRealAttempts.status, 'pending'),
            eq(evaluationVlmBlindRealAttempts.externalCallStatus, 'not_dispatched'),
          ),
        )
        .returning()
      return Boolean(claimed)
    })
  }

  private async refreshRun(
    runId: string,
    items?: Awaited<ReturnType<VlmBlindLabelingService['prepareCapabilityInput']>>['items'],
  ) {
    const attempts = await this.db
      .select()
      .from(evaluationVlmBlindRealAttempts)
      .where(eq(evaluationVlmBlindRealAttempts.runId, runId))
    const results = await this.db
      .select()
      .from(evaluationVlmBlindRealResults)
      .where(
        inArray(
          evaluationVlmBlindRealResults.attemptId,
          attempts.map((item) => item.id),
        ),
      )
    const unknownCount = attempts.filter((item) => item.status === 'outcome_unknown').length
    const failedCount = attempts.filter((item) => item.status === 'failed').length
    const succeededCount = attempts.filter((item) => item.status === 'succeeded').length
    const pendingCount = attempts.filter((item) =>
      ['pending', 'running'].includes(item.status),
    ).length
    const externalCallCount = attempts.filter(
      (item) => item.externalCallStatus !== 'not_dispatched',
    ).length
    const terminal = pendingCount === 0 || unknownCount > 0
    const knownTokens = attempts.every(
      (item) => item.status !== 'succeeded' || item.totalTokens !== null,
    )
    const knownCosts = attempts.every(
      (item) => item.status !== 'succeeded' || item.billedCostCny !== null,
    )
    const billedCost = knownCosts
      ? attempts.reduce((sum, item) => sum + (numberOrNull(item.billedCostCny) ?? 0), 0)
      : null
    const currentRun = await this.runById(runId)
    const selectedCaseIds = new Set(attempts.map((attempt) => attempt.caseId))
    const selectedItems = items?.filter((item) => selectedCaseIds.has(item.case.id))
    const smoke = currentRun.protocolVersion === SMOKE_PROTOCOL_VERSION
    const metrics = selectedItems
      ? smoke
        ? {
            ...computeSmokeMetrics(selectedItems, attempts, results),
            audit: {
              all_5_calls_succeeded:
                succeededCount === SMOKE_MAX_CALLS && failedCount === 0 && unknownCount === 0,
              token_usage_known: knownTokens,
              billed_cost_known_and_within_budget:
                billedCost !== null && billedCost <= Number(currentRun.maxCostCny),
            },
            eligible_for_real_top3_simulation: false,
          }
        : {
            ...computeMetrics(selectedItems, attempts, results),
            gates: {
              ...computeMetrics(selectedItems, attempts, results).gates,
              all_84_calls_succeeded:
                succeededCount === 84 && failedCount === 0 && unknownCount === 0,
              token_usage_known: knownTokens,
              billed_cost_known_and_within_budget:
                billedCost !== null && billedCost <= Number(currentRun.maxCostCny),
            },
            eligible_for_real_top3_simulation: false,
          }
      : null
    if (metrics && !smoke && 'gates' in metrics) {
      metrics.eligible_for_real_top3_simulation = Object.values(metrics.gates).every(Boolean)
    }
    await this.db
      .update(evaluationVlmBlindRealRuns)
      .set({
        status: unknownCount
          ? 'outcome_unknown'
          : terminal
            ? failedCount === 0
              ? 'succeeded'
              : succeededCount === 0
                ? 'failed'
                : 'completed_with_errors'
            : 'running',
        externalCallCount,
        succeededCount,
        failedCount,
        unknownCount,
        inputTokens: knownTokens ? sumNullable(attempts.map((item) => item.inputTokens)) : null,
        outputTokens: knownTokens ? sumNullable(attempts.map((item) => item.outputTokens)) : null,
        totalTokens: knownTokens ? sumNullable(attempts.map((item) => item.totalTokens)) : null,
        billedCostCny: billedCost?.toString() ?? null,
        metricsJson: terminal ? metrics : null,
        finishedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(evaluationVlmBlindRealRuns.id, runId))
  }

  private async hasUnknown(runId: string) {
    const [row] = await this.db
      .select({ id: evaluationVlmBlindRealAttempts.id })
      .from(evaluationVlmBlindRealAttempts)
      .where(
        and(
          eq(evaluationVlmBlindRealAttempts.runId, runId),
          eq(evaluationVlmBlindRealAttempts.status, 'outcome_unknown'),
        ),
      )
      .limit(1)
    return Boolean(row)
  }

  private async runById(runId: string) {
    const [run] = await this.db
      .select()
      .from(evaluationVlmBlindRealRuns)
      .where(eq(evaluationVlmBlindRealRuns.id, runId))
      .limit(1)
    if (!run) throw new NotFoundException('real VLM run not found')
    return run
  }

  private async failAttempt(attemptId: string, code: string) {
    await this.db
      .update(evaluationVlmBlindRealAttempts)
      .set({ status: 'failed', errorJson: { code }, completedAt: new Date() })
      .where(eq(evaluationVlmBlindRealAttempts.id, attemptId))
  }

  private async failRun(runId: string, code = 'VLM_REVIEW_SCHEDULER_FAILED') {
    await this.db
      .update(evaluationVlmBlindRealRuns)
      .set({ status: 'failed', errorJson: { code }, finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(evaluationVlmBlindRealRuns.id, runId),
          inArray(evaluationVlmBlindRealRuns.status, ['pending', 'running']),
        ),
      )
  }

  private async prepare(datasetId: string, mode: ExecutionMode = 'full') {
    const input = await this.labeling.prepareCapabilityInput(datasetId)
    const allItems = input.items.map((item) => {
      const body = buildQwenVlmReviewRequestBody(item.request)
      const serialized = JSON.stringify(body)
      return {
        input: item,
        requestBytes: Buffer.byteLength(serialized),
        requestFingerprint: createHash('sha256').update(serialized).digest('hex'),
      }
    })
    const allEdgeItems = allItems.filter((item) => item.input.group === EDGE_GROUP)
    if (allItems.length !== 60 || allEdgeItems.length !== 12) {
      throw new ConflictException('frozen capability protocol requires 60 cases and 12 edge cases')
    }
    const items =
      mode === 'smoke'
        ? SMOKE_GROUPS.map((group) => {
            const selected = allItems
              .filter((item) => item.input.group === group)
              .sort(
                (left, right) =>
                  left.requestBytes - right.requestBytes ||
                  left.input.case.id.localeCompare(right.input.case.id),
              )[0]
            if (!selected) throw new ConflictException(`smoke group ${group} has no candidate`)
            return selected
          })
        : allItems
    const edgeItems = items.filter((item) => item.input.group === EDGE_GROUP)
    const planned =
      mode === 'smoke'
        ? items.map((item) => ({ ...item, repetition: 1 }))
        : [
            ...items.map((item) => ({ ...item, repetition: 1 })),
            ...edgeItems.flatMap((item) => [
              { ...item, repetition: 2 },
              { ...item, repetition: 3 },
            ]),
          ]
    const preflightFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          dataset_fingerprint: input.dataset.frozenFingerprint,
          labels_fingerprint: input.session.labelsFingerprint,
          evidence_fingerprint: input.evidence_fingerprint,
          ...(mode === 'smoke'
            ? { execution_mode: mode, selection: 'minimum_request_bytes_v1' }
            : {}),
          requests: planned.map((item) => ({
            case_id: item.input.case.id,
            repetition: item.repetition,
            request_fingerprint: item.requestFingerprint,
            request_bytes: item.requestBytes,
          })),
        }),
      )
      .digest('hex')
    return { input, items, edgeItems, planned, preflightFingerprint }
  }

  private async findMatchingAuthorization(sessionId: string, fingerprint: string) {
    const [row] = await this.db
      .select()
      .from(evaluationVlmBlindVisualAuthorizations)
      .where(
        and(
          eq(evaluationVlmBlindVisualAuthorizations.labelingSessionId, sessionId),
          eq(evaluationVlmBlindVisualAuthorizations.preflightFingerprint, fingerprint),
          eq(evaluationVlmBlindVisualAuthorizations.status, 'active'),
          sql`${evaluationVlmBlindVisualAuthorizations.expiresAt} > now()`,
        ),
      )
      .limit(1)
    return row
  }
}

/**
 * Smoke 只回答“真实协议是否能在五种候选上跑通”，样本量只有每类一条，不能套用
 * 正式 60 条评测的晋级门槛。这里保存逐组是否一致、条件一致率和耗时，明确不产出晋级结论。
 */
function computeSmokeMetrics(
  items: Awaited<ReturnType<VlmBlindLabelingService['prepareCapabilityInput']>>['items'],
  attempts: Array<typeof evaluationVlmBlindRealAttempts.$inferSelect>,
  results: Array<typeof evaluationVlmBlindRealResults.$inferSelect>,
) {
  const resultByAttempt = new Map(results.map((item) => [item.attemptId, item]))
  const attemptByCase = new Map<string, typeof evaluationVlmBlindRealAttempts.$inferSelect>()
  for (const attempt of attempts.filter((item) => item.repetition === 1)) {
    const current = attemptByCase.get(attempt.caseId)
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      attemptByCase.set(attempt.caseId, attempt)
    }
  }
  const groupMatches: Record<string, boolean> = {}
  let caseStatusCorrect = 0
  let conditionCorrect = 0
  let conditionTotal = 0
  for (const item of items) {
    const attempt = attemptByCase.get(item.case.id)
    const result = attempt ? resultByAttempt.get(attempt.id) : undefined
    const matches = result?.derivedStatus === expectedCaseStatus(item.group, item.human_status)
    groupMatches[item.group] = matches
    if (matches) caseStatusCorrect += 1
    const output = result?.outputJson as {
      conditions?: Array<{ condition_id: string; verdict: string }>
    } | null
    const actualById = new Map(
      (output?.conditions ?? []).map((condition) => [condition.condition_id, condition.verdict]),
    )
    for (const condition of item.human_conditions) {
      conditionTotal += 1
      if (actualById.get(condition.condition_id) === condition.verdict) conditionCorrect += 1
    }
  }
  const latencies = attempts
    .map((item) => item.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return {
    smoke_only: true,
    selection: 'minimum_request_bytes_v1',
    group_matches: groupMatches,
    case_status_correct: caseStatusCorrect,
    case_total: items.length,
    condition_correct: conditionCorrect,
    condition_total: conditionTotal,
    condition_accuracy: conditionTotal === 0 ? null : conditionCorrect / conditionTotal,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    formal_eligibility_note: 'Smoke 每类只有一条，只验证协议和审计链路，不用于 Phase F 晋级。',
  }
}

function computeMetrics(
  items: Awaited<ReturnType<VlmBlindLabelingService['prepareCapabilityInput']>>['items'],
  attempts: Array<typeof evaluationVlmBlindRealAttempts.$inferSelect>,
  results: Array<typeof evaluationVlmBlindRealResults.$inferSelect>,
) {
  const resultByAttempt = new Map(results.map((item) => [item.attemptId, item]))
  const firstByCase = new Map<string, typeof evaluationVlmBlindRealAttempts.$inferSelect>()
  for (const attempt of attempts.filter((item) => item.repetition === 1)) {
    const current = firstByCase.get(attempt.caseId)
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      firstByCase.set(attempt.caseId, attempt)
    }
  }
  const groupCorrect: Record<string, number> = {}
  let overallCorrect = 0
  let falsePassCount = 0
  const classStats = new Map(
    ['yes', 'no', 'uncertain'].map((value) => [value, { correct: 0, total: 0 }]),
  )
  for (const item of items) {
    const attempt = firstByCase.get(item.case.id)
    const result = attempt ? resultByAttempt.get(attempt.id) : undefined
    const expected = expectedCaseStatus(item.group, item.human_status)
    const actual = result?.derivedStatus ?? 'review_failed'
    if (actual === expected) {
      overallCorrect += 1
      groupCorrect[item.group] = (groupCorrect[item.group] ?? 0) + 1
    }
    if (expected !== 'passed' && actual === 'passed') falsePassCount += 1
    const output = result?.outputJson as {
      conditions?: Array<{ condition_id: string; verdict: string }>
    } | null
    const actualById = new Map(
      (output?.conditions ?? []).map((condition) => [condition.condition_id, condition.verdict]),
    )
    for (const condition of item.human_conditions) {
      const stats = classStats.get(condition.verdict)!
      stats.total += 1
      if (actualById.get(condition.condition_id) === condition.verdict) stats.correct += 1
    }
  }
  const classAccuracy = Object.fromEntries(
    [...classStats].map(([key, value]) => [
      key,
      { ...value, accuracy: value.total === 0 ? null : value.correct / value.total },
    ]),
  )
  const allClassAccuracies = Object.values(classAccuracy).map(
    (item) => item.accuracy as number | null,
  )
  const macroAccuracy = allClassAccuracies.some((value) => value === null)
    ? null
    : allClassAccuracies.reduce<number>((sum, value) => sum + value!, 0) / allClassAccuracies.length
  const stabilityItems = items.filter((item) => item.group === EDGE_GROUP)
  let stableCaseCount = 0
  for (const item of stabilityItems) {
    const latestByRepetition = new Map<number, typeof evaluationVlmBlindRealAttempts.$inferSelect>()
    for (const attempt of attempts.filter((attempt) => attempt.caseId === item.case.id)) {
      const current = latestByRepetition.get(attempt.repetition)
      if (!current || attempt.attemptNumber > current.attemptNumber) {
        latestByRepetition.set(attempt.repetition, attempt)
      }
    }
    const statuses = [1, 2, 3].map((repetition) => {
      const attempt = latestByRepetition.get(repetition)
      return attempt
        ? (resultByAttempt.get(attempt.id)?.derivedStatus ?? 'review_failed')
        : 'review_failed'
    })
    if (statuses.length === 3 && new Set(statuses).size === 1) stableCaseCount += 1
  }
  const latencies = attempts
    .map((item) => item.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  const p50 = percentile(latencies, 0.5)
  const p95 = percentile(latencies, 0.95)
  const gates = {
    false_pass_zero: falsePassCount === 0,
    overall_at_least_54_of_60: overallCorrect >= 54,
    exact_match_at_least_11_of_12: (groupCorrect.exact_match ?? 0) >= 11,
    missing_must_have_at_least_10_of_12: (groupCorrect.missing_must_have ?? 0) >= 10,
    exclusion_hit_at_least_10_of_12: (groupCorrect.exclusion_hit ?? 0) >= 10,
    partial_relevance_at_least_10_of_12: (groupCorrect.partial_relevance ?? 0) >= 10,
    insufficient_evidence_at_least_10_of_12: (groupCorrect.insufficient_evidence ?? 0) >= 10,
    condition_macro_accuracy_at_least_90_percent: macroAccuracy !== null && macroAccuracy >= 0.9,
    stability_at_least_11_of_12: stableCaseCount >= 11,
    p95_latency_at_most_90000_ms: p95 !== null && p95 <= 90_000,
  }
  return {
    false_pass_count: falsePassCount,
    overall_correct: overallCorrect,
    overall_total: 60,
    group_correct: groupCorrect,
    group_total: 12,
    condition_class_accuracy: classAccuracy,
    condition_macro_accuracy: macroAccuracy,
    condition_macro_accuracy_note:
      macroAccuracy === null
        ? '冻结人工真值缺少至少一个 yes/no/uncertain 类别，不能计算三类宏平均。'
        : null,
    stability_fully_consistent: stableCaseCount,
    stability_total: 12,
    latency_ms: { p50, p95 },
    gates,
    eligible_for_real_top3_simulation: Object.values(gates).every(Boolean),
  }
}

function expectedCaseStatus(group: string, derived: string) {
  if (group === 'exact_match') return 'passed'
  if (group === 'missing_must_have' || group === 'exclusion_hit') return 'rejected'
  if (group === 'insufficient_evidence') return 'insufficient_evidence'
  return derived
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return null
  return values[Math.max(0, Math.ceil(values.length * percentileValue) - 1)]!
}

function sumNullable(values: Array<number | null>) {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function numberOrNull(value: string | null) {
  return value === null ? null : Number(value)
}

function toRunResponse(run: typeof evaluationVlmBlindRealRuns.$inferSelect) {
  return {
    id: run.id,
    status: run.status,
    provider: run.provider,
    requested_model: run.requestedModel,
    protocol_version: run.protocolVersion,
    prompt_version: run.promptVersion,
    dataset_fingerprint: run.datasetFingerprint,
    labels_fingerprint: run.labelsFingerprint,
    evidence_fingerprint: run.evidenceFingerprint,
    case_count: run.caseCount,
    planned_call_count: run.plannedCallCount,
    external_call_count: run.externalCallCount,
    succeeded_count: run.succeededCount,
    failed_count: run.failedCount,
    unknown_count: run.unknownCount,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    total_tokens: run.totalTokens,
    billed_cost_cny: numberOrNull(run.billedCostCny),
    metrics: run.metricsJson,
    error: run.errorJson,
    created_at: run.createdAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
  }
}
