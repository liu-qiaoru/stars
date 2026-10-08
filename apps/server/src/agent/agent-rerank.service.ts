import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { agentRerankRequestSchema, agentRerankResponseSchema } from '@local-media-agent/shared/schemas'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import sharp from 'sharp'
import { z, ZodError } from 'zod'
import { CandidateEvidenceService } from '../candidate-evidence/candidate-evidence.service.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  agentRerankFeedback,
  agentRerankRankings,
  agentRerankRuns,
  agentRunCandidates,
  agentRunSteps,
  agentRunAuthorizations,
  agentRuns,
  candidateEvidence,
  mediaAssets,
  mediaFiles,
  videoScenes,
} from '../database/schema.js'
import { dashScopeShadowRerankRequestBytes } from '../evaluation/dashscope-shadow-rerank.provider.js'
import {
  ShadowRerankProviderResponseError,
} from '../evaluation/shadow-rerank.provider.js'
import {
  AGENT_RERANK_IMAGE_MIME,
  AGENT_RERANK_PROVIDER,
  type AgentRerankProvider,
} from './agent-rerank.provider.js'
import { AGENT_RERANK_POLICY } from './agent-rerank.policy.js'
import { finishAgentTraceSpan, startAgentTraceSpan } from './agent-trace.repository.js'

const MODEL = 'qwen3-vl-rerank'
const IMAGE_INPUT_COST_CNY_PER_TOKEN = 1.8 / 1_000_000

// 序列化后 JSON 总量的安全线（字节）。2026-08 实测该专用端点网关：18,530,463 字节成功、
// 18,800,042 字节返回 413 RequestTooLarge。取 17MB 保留余量，防止协议字段增长后顶到边界。
export const RERANK_SAFE_REQUEST_BYTES = 17_000_000
// JSON 骨架的保守估计：query 原文、20 组 candidate_key/指纹/字段名、data URL 前缀等。
// 只用于分配预算，最终是否可发以真实序列化字节数硬校验为准。
const REQUEST_SKELETON_BYTES = 8_192
// JPEG quality 85：对照片/视频帧体积约为 PNG 的 1/5~1/10，画面信息对重排模型足够。
const EVIDENCE_JPEG_QUALITY = 85
// 逐级降尺寸档（像素，长边上限）：每降一档像素约减半，字节数大致同步下降。
// 最小档仍超预算时不再继续压缩，由总量硬校验决定失败，避免无限尝试。
const EVIDENCE_SIZE_LADDER = [1600, 1200, 900, 700, 560, 448] as const

/**
 * 把安全线换算成每个候选的原始字节预算。权重 = 证据包含的画面数：
 * 图片计 1；视频拼图取 Worker 写入 manifest 的 frame_count（1 帧场景给低预算，
 * 9 帧拼图给高预算），帧多的图内容密度高，需要更多字节保持每帧可读。
 * Base64 把每 3 字节原始数据编成 4 个字符，因此原始字节预算要在安全线基础上打 3/4 折扣。
 */
export function planEvidenceBudgets(weights: number[], queryText: string) {
  const skeleton = REQUEST_SKELETON_BYTES + Buffer.byteLength(queryText, 'utf8')
  const rawTotal = Math.max(0, Math.floor(((RERANK_SAFE_REQUEST_BYTES - skeleton) * 3) / 4))
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => Math.floor((rawTotal * weight) / weightTotal))
}

/**
 * 把一张证据图（本地路径或内存字节）压缩到预算内：按尺寸档逐级重编码 JPEG，
 * 返回第一档满足预算的结果；最小档仍超预算时返回最小档结果，是否可发交给
 * 调用方的总量硬校验决定，避免单张极端复杂的图拖累其余 19 张的可用尺寸。
 */
export async function encodeEvidenceWithinBudget(source: string | Buffer, budgetBytes: number) {
  let smallest: Buffer = Buffer.alloc(0)
  for (const size of EVIDENCE_SIZE_LADDER) {
    const buffer = await sharp(source)
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: EVIDENCE_JPEG_QUALITY })
      .toBuffer()
    if (buffer.byteLength <= budgetBytes) return buffer
    smallest = buffer
  }
  return smallest
}

/** 从 candidate_evidence 的 manifest 读取拼图帧数作为预算权重；缺失时按 1 帧计，安全优先。 */
function frameCountWeight(row: typeof candidateEvidence.$inferSelect | undefined) {
  const manifest = row?.manifestJson
  if (manifest && typeof manifest === 'object' && 'frame_count' in manifest) {
    const value = (manifest as { frame_count?: unknown }).frame_count
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 40) {
      return value
    }
  }
  return 1
}

/** 压缩循环结束后总量仍超安全线时抛出，调用方据此本地失败、不外发。 */
class AgentRerankRequestTooLargeError extends Error {
  constructor(readonly requestBytes: number) {
    super(`Rerank request body ${requestBytes} bytes exceeds safe line`)
  }
}

// TypeScript 类型在网络边界不会自动校验运行时值；审计字段也必须拒绝负 token、NaN
// 或超长 request id，避免一次异常供应商响应污染后续成本汇总。
const providerAuditSchema = z
  .object({
    providerRequestId: z.string().min(1).max(500).nullable(),
    responseModel: z.string().min(1).max(200).nullable(),
    modelSnapshot: z.string().min(1).max(500).nullable(),
    region: z.string().min(1).max(200).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    billedCostCny: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.inputTokens === null ||
      value.outputTokens === null ||
      value.totalTokens === null ||
      value.totalTokens === value.inputTokens + value.outputTokens,
    {
      path: ['totalTokens'],
      message: 'totalTokens must equal inputTokens + outputTokens when all are provided',
    },
  )

type FrozenCandidate = typeof agentRunCandidates.$inferSelect & { mediaType: string }

/**
 * 编排 Agent 产品必经的 Rerank。视频证据先由 Python Worker 异步生成；Server 随后
 * 校验 1～20 条冻结身份，在网络前提交 dispatched，最后把最多 Top-10 独立排序写回。
 * 它从不改写 agent_run_candidates.rank，因此页面和后续汇总始终保留同一份 RRF 基线。
 */
@Injectable()
export class AgentRerankService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRerankService.name)
  private timer?: NodeJS.Timeout
  private ticking = false

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AGENT_RERANK_PROVIDER) private readonly provider: AgentRerankProvider,
    @Inject(SETTINGS)
    private readonly settings: Pick<Settings, 'agentRerankTimeoutMs' | 'agentExecutorIntervalMs' | 'agentRetrievalTimeoutMs'>,
    @Inject(CandidateEvidenceService)
    private readonly evidenceService: CandidateEvidenceService,
  ) {}

  async onModuleInit() {
    // 已经外发但没有终态的请求可能已被供应商处理；恢复时只标未知，不自动重放。
    const unknownRows = await this.db
      .select({ id: agentRerankRuns.id })
      .from(agentRerankRuns)
      .where(
        and(
          eq(agentRerankRuns.status, 'running'),
          eq(agentRerankRuns.externalCallStatus, 'dispatched'),
        ),
      )
    for (const row of unknownRows) {
      await this.finishWithError(
        row.id,
        'outcome_unknown',
        'AGENT_RERANK_OUTCOME_UNKNOWN_AFTER_RESTART',
        'Rerank 请求已外发但 Server 未保存确定结果，禁止自动重试。',
      )
    }
    this.timer = setInterval(() => void this.tick(), this.settings.agentExecutorIntervalMs ?? 1_000)
    this.timer.unref()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  get available() {
    return this.provider.available
  }

  async getForAgentRun(agentRunId: string) {
    const [run] = await this.db
      .select()
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.agentRunId, agentRunId))
      .orderBy(asc(agentRerankRuns.attemptNo))
      .limit(1)
    return run ? this.response(run.id) : null
  }

  /**
   * 供本地验收在申请追加额度前准备可审查摘要。复用实际压缩与证据校验，
   * 只读取数据库和本地图片，不创建任务、不提交派发状态，也不调用Provider。
   * 返回实际供应商请求字节数与指纹；不返回本地路径、图片正文或凭证。
   * 预检不会锁定未来数据，真正派发仍须重新校验并原子提交授权/状态边界。
   */
  async preflightForAgentRun(agentRunId: string) {
    const candidates = await this.candidates(agentRunId)
    this.validateCandidates(candidates)
    const evidence = await this.db.select().from(candidateEvidence).where(and(
      eq(candidateEvidence.sourceType, 'agent_run_candidate'), eq(candidateEvidence.sourceId, agentRunId),
      eq(candidateEvidence.strategy, 'contact_sheet_v1'), eq(candidateEvidence.protocolVersion, 'candidate-evidence-v1'),
    ))
    const prepared = await this.prepareRequest(agentRunId, candidates, evidence)
    return { model: MODEL, query: prepared.request.query, candidate_count: prepared.request.documents.length,
      candidate_keys: prepared.request.documents.map(row => row.candidate_key),
      evidence_sha256: prepared.request.documents.map(row => row.evidence_sha256),
      request_sha256: fingerprint(prepared.request), request_bytes: prepared.requestBytes,
      maximum_estimated_cost_cny: AGENT_RERANK_POLICY.maximumCostCny, external_calls: 0 as const }
  }

  /**
   * 每次只推进一个任务，避免同时持有多组图片。默认轮询最早任务；隔离验收可指定任务，
   * 防止对照流程误领另一条流程。指定身份不跳过授权、预算、证据与原子派发检查。
   */
  async tick(agentRunId?: string) {
    if (this.ticking) return
    this.ticking = true
    try {
      const [run] = await this.db
        .select()
        .from(agentRerankRuns)
        .where(and(eq(agentRerankRuns.status, 'preparing_evidence'),
          agentRunId ? eq(agentRerankRuns.agentRunId, agentRunId) : undefined))
        .orderBy(asc(agentRerankRuns.createdAt))
        .limit(1)
      if (run && !this.provider.available) {
        await this.fail(run.id, 'AGENT_RERANK_PROVIDER_DISABLED', '产品重排服务未启用，未外发。')
      } else if (run) await this.executeIfReady(run.id)
    } catch (error) {
      // 基础设施异常消息可能携带SQL参数或磁盘路径；普通日志只保留固定类别与任务身份。
      this.logger.error(JSON.stringify({ event: 'agent_rerank_iteration_failed', agent_run_id: agentRunId ?? null }))
    } finally {
      this.ticking = false
    }
  }

  private async executeIfReady(rerankRunId: string) {
    const [rerankRun] = await this.db
      .select()
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.id, rerankRunId))
      .limit(1)
    if (!rerankRun || rerankRun.status !== 'preparing_evidence') return
    // Worker 不在线或任务无法完成时给出明确阶段错误；不能无限停留在“准备证据”。
    if (Date.now() - rerankRun.createdAt.getTime() >= (this.settings.agentRetrievalTimeoutMs ?? 600_000)) {
      await this.fail(rerankRunId, 'AGENT_RERANK_EVIDENCE_TIMEOUT', '准备派生图片超时，请检查 Python Worker 和证据任务；尚未调用外部重排模型。')
      return
    }
    const [parent] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, rerankRun.agentRunId)).limit(1)
    const [authorization] = await this.db.select().from(agentRunAuthorizations)
      .where(eq(agentRunAuthorizations.runId, rerankRun.agentRunId)).limit(1)
    const fields = (authorization?.visualScopeJson as { fields?: string[] })?.fields
    if (parent?.status !== 'ranking' || !authorization?.allowExternalVisual ||
      !fields?.includes('full_user_query') || !fields.includes('retrieval_candidate_derived_images')) {
      await this.fail(rerankRunId, 'AGENT_RERANK_AUTHORIZATION_INVALID', '父任务已停止或独立图片授权缺失，未外发。')
      return
    }
    let candidates: FrozenCandidate[]
    try {
      candidates = await this.candidates(rerankRun.agentRunId)
      this.validateCandidates(candidates)
    } catch {
      // 候选异常必须结束任务并保留错误，不能只在轮询日志里报错后永久卡在准备阶段。
      await this.fail(rerankRunId, 'AGENT_RERANK_CANDIDATES_INVALID', '冻结的重排候选缺失或不合法，未外发。')
      return
    }
    const videos = candidates.filter((item) => item.mediaType === 'video')
    const evidence = videos.length
      ? await this.db
          .select()
          .from(candidateEvidence)
          .where(
            and(
              eq(candidateEvidence.sourceType, 'agent_run_candidate'),
              eq(candidateEvidence.sourceId, rerankRun.agentRunId),
              inArray(
                candidateEvidence.candidateKey,
                videos.map((item) => item.candidateKey),
              ),
              eq(candidateEvidence.strategy, 'contact_sheet_v1'),
              eq(candidateEvidence.protocolVersion, 'candidate-evidence-v1'),
            ),
          )
      : []
    if (evidence.some((item) => ['failed', 'cancelled'].includes(item.status))) {
      await this.fail(
        rerankRunId,
        'AGENT_RERANK_EVIDENCE_FAILED',
        '至少一份视频派生 PNG 生成失败。',
      )
      return
    }
    const evidenceByKey = new Map(evidence.map((item) => [item.candidateKey, item]))
    const missingVideos = videos.filter((item) => !evidenceByKey.has(item.candidateKey))
    if (missingVideos.length) {
      try {
        // createEvidence 由数据库唯一身份保证幂等；轮询重入不会创建重复的 Worker 任务。
        for (const candidate of missingVideos) {
          await this.evidenceService.createEvidence({
            source: { type: 'agent_run_candidate', run_id: rerankRun.agentRunId },
            candidate_key: candidate.candidateKey,
            strategies: ['contact_sheet_v1'],
          })
        }
      } catch {
        await this.fail(
          rerankRunId,
          'AGENT_RERANK_EVIDENCE_QUEUE_FAILED',
          '视频派生证据任务创建失败，未向 Provider 外发。',
        )
      }
      return
    }
    if (evidence.some((item) => item.status !== 'succeeded'))
      return

    let prepared: Awaited<ReturnType<AgentRerankService['prepareRequest']>>
    try {
      prepared = await this.prepareRequest(rerankRun.agentRunId, candidates, evidence)
    } catch (error) {
      // 两类本地失败都不外发：证据身份失效需重新冻结；请求体超安全线则说明
      // 压缩循环已压至最小尺寸档仍不达标，错误信息保留实际字节数便于诊断。
      if (error instanceof AgentRerankRequestTooLargeError) {
        await this.fail(
          rerankRunId,
          'AGENT_RERANK_REQUEST_TOO_LARGE',
          `压缩后请求仍为 ${error.requestBytes} 字节，超过 ${RERANK_SAFE_REQUEST_BYTES} 字节安全线，未向 Provider 外发。`,
        )
      } else {
        await this.fail(
          rerankRunId,
          'AGENT_RERANK_EVIDENCE_INVALID',
          '派生 PNG 或冻结候选身份校验失败，未向 Provider 外发。',
        )
      }
      return
    }
    const claimed = await this.db.transaction(async tx => {
      // 锁住父任务，与用户取消串行处理；派发之前重新核对独立图片授权。
      const [parent] = await tx.select().from(agentRuns).where(eq(agentRuns.id, rerankRun.agentRunId)).for('update')
      if (parent?.status !== 'ranking') return null
      const [authorization] = await tx.select().from(agentRunAuthorizations)
        .where(eq(agentRunAuthorizations.runId, parent.id))
      const fields = (authorization?.visualScopeJson as { fields?: string[] })?.fields
      if (!authorization?.allowExternalVisual || !fields?.includes('full_user_query') || !fields.includes('retrieval_candidate_derived_images')) return null
      const [row] = await tx
      .update(agentRerankRuns)
      .set({
        status: 'running',
        externalCallStatus: 'dispatched',
        queryFingerprint: prepared.queryFingerprint,
        evidenceFingerprint: prepared.evidenceFingerprint,
        requestBytes: prepared.requestBytes,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRerankRuns.id, rerankRunId),
          eq(agentRerankRuns.status, 'preparing_evidence'),
          eq(agentRerankRuns.externalCallStatus, 'not_dispatched'),
        ),
      )
      .returning()
      return row ?? null
    })
    if (!claimed) return

    const trace = await startAgentTraceSpan(this.db, {
      runId: rerankRun.agentRunId,
      component: 'dashscope-rerank',
      operation: 'rerank_candidates',
      attemptNo: rerankRun.attemptNo,
      externalCallStatus: 'dispatched',
      requestSummaryJson: {
        candidate_count: candidates.length,
        request_bytes: prepared.requestBytes,
        maximum_cost_cny: Number(rerankRun.maxCostCny),
      },
    })

    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.agentRerankTimeoutMs ?? 180_000,
    )
    const startedAt = Date.now()
    try {
      const providerResult = await this.provider.rerank(prepared.request, controller.signal)
      const audit = providerAuditSchema.parse({
        providerRequestId: providerResult.providerRequestId,
        responseModel: providerResult.responseModel,
        modelSnapshot: providerResult.modelSnapshot,
        region: providerResult.region,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        totalTokens: providerResult.totalTokens,
        billedCostCny: providerResult.billedCostCny,
      })
      const response = agentRerankResponseSchema(candidates.length).parse(providerResult.response)
      const responseFingerprint = fingerprint(response)
      const rankingByIndex = new Map(
        response.results.map((item, index) => [
          item.index,
          { rank: index + 1, score: item.relevance_score },
        ]),
      )
      const committed = await this.db.transaction(async (transaction) => {
        const tx = transaction as Database
        const [current] = await tx
          .select({
            status: agentRerankRuns.status,
            agentRunId: agentRerankRuns.agentRunId,
            completionStatus: agentRerankRuns.completionStatus,
          })
          .from(agentRerankRuns)
          .where(eq(agentRerankRuns.id, rerankRunId))
          .limit(1)
          .for('update')
        // 另一恢复路径若已把请求定为 outcome_unknown，迟到响应不得重新覆盖终态。
        if (current?.status !== 'running') return false
        await tx.insert(agentRerankRankings).values(
          candidates.map((candidate, index) => ({
            id: randomUUID(),
            rerankRunId,
            candidateId: candidate.id,
            candidateKey: candidate.candidateKey,
            rrfRank: candidate.rank,
            rerankRank: rankingByIndex.get(index)?.rank ?? null,
            relevanceScore:
              rankingByIndex.get(index)?.score === undefined
                ? null
                : String(rankingByIndex.get(index)!.score),
          })),
        )
        const [completed] = await tx
          .update(agentRerankRuns)
          .set({
            status: 'succeeded',
            externalCallStatus: 'completed',
            providerRequestId: audit.providerRequestId,
            responseModel: audit.responseModel,
            modelSnapshot: audit.modelSnapshot,
            region: audit.region,
            responseFingerprint,
            inputTokens: audit.inputTokens,
            outputTokens: audit.outputTokens,
            totalTokens: audit.totalTokens,
            billedCostCny: audit.billedCostCny === null ? null : String(audit.billedCostCny),
            estimatedCostCny:
              audit.totalTokens === null
                ? null
                : String(audit.totalTokens * IMAGE_INPUT_COST_CNY_PER_TOKEN),
            latencyMs: Date.now() - startedAt,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(agentRerankRuns.id, rerankRunId), eq(agentRerankRuns.status, 'running')))
          .returning()
        if (!completed) throw new Error('Agent Rerank result lost its conditional write boundary')
        const completionStatus =
          current.completionStatus === 'waiting_for_export_selection'
            ? 'waiting_for_export_selection'
            : 'succeeded'
        const [parent] = await tx
          .update(agentRuns)
          .set({
            status: completionStatus,
            finishedAt: completionStatus === 'succeeded' ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(agentRuns.id, current.agentRunId), eq(agentRuns.status, 'ranking')),
          )
          .returning()
        if (!parent) {
          const [stopped] = await tx.select().from(agentRuns).where(eq(agentRuns.id, current.agentRunId))
          // 用户取消不能取消已经付费的远端处理。保存实际用量供审计，但绝不恢复父任务。
          if (stopped?.status !== 'cancelled') throw new Error('Agent parent run lost its ranking completion boundary')
        }
        return true
      })
      if (!committed) return
      await finishAgentTraceSpan(this.db, {
        runId: rerankRun.agentRunId,
        spanId: trace.spanId,
        status: 'succeeded',
        externalCallStatus: 'completed',
        responseSummaryJson: {
          result_count: response.results.length,
          provider_request_id: audit.providerRequestId,
          total_tokens: audit.totalTokens,
        },
      })
    } catch (error) {
      const definite =
        error instanceof ShadowRerankProviderResponseError || error instanceof ZodError
      // Provider 错误对象携带 http_status/provider_code/request_id，但按协议只存
      // 通用错误码进数据库；诊断详情只进日志，便于定位 413/限流等网关层失败。
      if (error instanceof ShadowRerankProviderResponseError) {
        this.logger.warn(
          `Agent rerank definite failure: http_status=${error.httpStatus} ` +
            `provider_code=${error.providerCode ?? 'null'} ` +
            `provider_request_id=${error.providerRequestId ?? 'null'}`,
        )
      }
      await this.finishWithError(
        rerankRunId,
        definite ? 'failed' : 'outcome_unknown',
        definite
          ? error instanceof ShadowRerankProviderResponseError
            ? error.code
            : 'AGENT_RERANK_RESPONSE_INVALID'
          : 'AGENT_RERANK_OUTCOME_UNKNOWN',
        definite
          ? 'Rerank Provider 返回了确定失败。'
          : 'Rerank 请求可能已被处理，结果未知且不会自动重试。',
        Date.now() - startedAt,
      )
      await finishAgentTraceSpan(this.db, {
        runId: rerankRun.agentRunId,
        spanId: trace.spanId,
        status: definite ? 'failed' : 'outcome_unknown',
        externalCallStatus: definite ? 'failed' : 'outcome_unknown',
        errorCode: definite ? 'AGENT_RERANK_FAILED' : 'AGENT_RERANK_OUTCOME_UNKNOWN',
        errorMessage: definite
          ? 'Rerank Provider 返回确定失败。'
          : 'Rerank 请求结果未知。',
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async prepareRequest(
    agentRunId: string,
    candidates: FrozenCandidate[],
    evidence: Array<typeof candidateEvidence.$inferSelect>,
  ) {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, agentRunId))
      .limit(1)
    if (!run) throw new NotFoundException('Agent run not found')
    const byKey = new Map(evidence.map((item) => [item.candidateKey, item]))
    // 先按“证据包含的画面数”分配每张图的字节预算，再逐张压缩到预算内，
    // 保证序列化后的请求体稳定低于百炼网关约 18.5MB 的 413 上限。
    const budgets = planEvidenceBudgets(
      candidates.map((candidate) =>
        candidate.mediaType === 'video'
          ? frameCountWeight(byKey.get(candidate.candidateKey))
          : 1,
      ),
      run.prompt,
    )
    const documents = []
    for (const [index, candidate] of candidates.entries()) {
      const source =
        candidate.mediaType === 'image'
          ? await this.readFrozenImage(candidate, index)
          : await this.readVideoEvidence(candidate, byKey.get(candidate.candidateKey), index)
      const bytes = await encodeEvidenceWithinBudget(source, budgets[index]!)
      documents.push({
        index,
        candidate_key: candidate.candidateKey,
        evidence_sha256: createHash('sha256').update(bytes).digest('hex'),
        image_base64: bytes.toString('base64'),
      })
    }
    const request = agentRerankRequestSchema.parse({
      model: MODEL,
      query: run.prompt,
      top_n: Math.min(AGENT_RERANK_POLICY.maximumResultCount, candidates.length),
      documents,
    })
    // 外发前的总量硬校验：预算分配是估算，只有真实序列化字节数是事实。
    // 超线时抛出并由调用方本地失败——此时外发必然被网关 413 拒收，
    // 不发可以保留“未外发”状态，调整压缩档位后仍可重新发起。
    const requestBytes = dashScopeShadowRerankRequestBytes(request, AGENT_RERANK_IMAGE_MIME)
    if (requestBytes > RERANK_SAFE_REQUEST_BYTES) {
      throw new AgentRerankRequestTooLargeError(requestBytes)
    }
    return {
      request,
      queryFingerprint: fingerprint(run.prompt),
      evidenceFingerprint: fingerprint(documents.map((item) => item.evidence_sha256)),
      requestBytes,
    }
  }

  /** 校验图片候选的冻结身份后返回本地路径；缩放与编码统一由 encodeEvidenceWithinBudget 完成。 */
  private async readFrozenImage(candidate: FrozenCandidate, index: number) {
    const [row] = await this.db
      .select({
        path: mediaFiles.path,
        generation: mediaFiles.indexGeneration,
        assetType: mediaAssets.assetType,
      })
      .from(mediaFiles)
      .innerJoin(
        mediaAssets,
        and(eq(mediaAssets.id, candidate.assetId), eq(mediaAssets.fileId, mediaFiles.id)),
      )
      .where(and(eq(mediaFiles.id, candidate.fileId), isNull(mediaFiles.deletedAt)))
      .limit(1)
    if (!row || row.generation !== candidate.fileGeneration || row.assetType !== 'image') {
      throw new ConflictException(`图片候选 ${index + 1} 的冻结身份已失效`)
    }
    return row.path
  }

  private async readVideoEvidence(
    candidate: FrozenCandidate,
    row: typeof candidateEvidence.$inferSelect | undefined,
    index: number,
  ) {
    if (
      !row?.artifactPath ||
      !row.artifactSha256 ||
      row.fileId !== candidate.fileId ||
      row.fileGeneration !== candidate.fileGeneration ||
      row.sceneId !== candidate.sceneId
    ) {
      throw new ConflictException(`视频候选 ${index + 1} 的派生 PNG 身份不一致`)
    }
    // 派生图片指纹正确也可能对应已经重索引/删除的旧场景，必须核对当前业务事实。
    const [current] = await this.db.select({ generation: mediaFiles.indexGeneration, sceneGeneration: videoScenes.indexGeneration })
      .from(mediaFiles).innerJoin(videoScenes, and(eq(videoScenes.fileId, mediaFiles.id), eq(videoScenes.id, candidate.sceneId!)))
      .where(and(eq(mediaFiles.id, candidate.fileId), isNull(mediaFiles.deletedAt))).limit(1)
    if (!current || current.generation !== candidate.fileGeneration || current.sceneGeneration !== candidate.fileGeneration ||
      (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new ConflictException('视频派生证据已过期')
    const bytes = await readFile(row.artifactPath)
    if (createHash('sha256').update(bytes).digest('hex') !== row.artifactSha256) {
      throw new ConflictException(`视频候选 ${index + 1} 的派生 PNG 指纹不一致`)
    }
    return bytes
  }

  private async candidates(agentRunId: string): Promise<FrozenCandidate[]> {
    const rows = await this.db
      .select({
        id: agentRunCandidates.id,
        runId: agentRunCandidates.runId,
        candidateKey: agentRunCandidates.candidateKey,
        fileId: agentRunCandidates.fileId,
        fileGeneration: agentRunCandidates.fileGeneration,
        assetId: agentRunCandidates.assetId,
        sceneId: agentRunCandidates.sceneId,
        sceneStartSeconds: agentRunCandidates.sceneStartSeconds,
        sceneEndSeconds: agentRunCandidates.sceneEndSeconds,
        rank: agentRunCandidates.rank,
        retrievalJson: agentRunCandidates.retrievalJson,
        createdAt: agentRunCandidates.createdAt,
        mediaType: mediaFiles.mediaType,
      })
      .from(agentRunCandidates)
      .innerJoin(mediaFiles, eq(mediaFiles.id, agentRunCandidates.fileId))
      .where(eq(agentRunCandidates.runId, agentRunId))
      .orderBy(asc(agentRunCandidates.rank))
    const [selection] = await this.db.select().from(agentRunSteps)
      .where(and(eq(agentRunSteps.runId, agentRunId), eq(agentRunSteps.status, 'completed')))
      .orderBy(desc(agentRunSteps.createdAt)).limit(1)
    const keys = (selection?.outputJson as { rerank_candidate_keys?: unknown })?.rerank_candidate_keys
    if (keys === undefined) return rows // 旧流程直接消费一次搜索的完整快照。
    const parsed = z.array(z.string()).min(1).max(20).parse(keys)
    if (new Set(parsed).size !== parsed.length) throw new ConflictException('重复的重排候选身份')
    // 多轮搜索的全集保留用于审计。重排只消费交接时冻结的子集，索引必须与请求顺序一致。
    return parsed.map((key, index) => {
      const row = rows.find(candidate => candidate.candidateKey === key)
      if (!row) throw new ConflictException('重排候选已缺失')
      return { ...row, rank: index + 1 }
    })
  }

  private validateCandidates(candidates: FrozenCandidate[]) {
    if (
      candidates.length < 1 ||
      candidates.length > AGENT_RERANK_POLICY.maximumCandidateCount ||
      candidates.some((item, index) => item.rank !== index + 1) ||
      candidates.some((item) => !['image', 'video'].includes(item.mediaType))
    ) {
      throw new ConflictException('Rerank 只接受连续的 1～20 条视觉 RRF 候选')
    }
  }

  private async fail(id: string, code: string, message: string) {
    await this.finishWithError(id, 'failed', code, message)
  }

  /** Rerank 失败会同步结束父 Agent run；绝不把内部 RRF 候选降级成最终结果。 */
  private async finishWithError(
    id: string,
    status: 'failed' | 'outcome_unknown',
    code: string,
    message: string,
    latencyMs?: number,
  ) {
    await this.db.transaction(async (transaction) => {
      const tx = transaction as Database
      const [rerank] = await tx
        .update(agentRerankRuns)
        .set({
          status,
          externalCallStatus: status === 'outcome_unknown' ? 'dispatched' : 'completed',
          errorCode: code,
          errorMessage: message,
          latencyMs,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentRerankRuns.id, id))
        .returning()
      if (!rerank) return
      await tx
        .update(agentRuns)
        .set({
          status,
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, rerank.agentRunId), eq(agentRuns.status, 'ranking')))
    })
  }

  private async response(id: string) {
    const [run] = await this.db
      .select()
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.id, id))
      .limit(1)
    if (!run) throw new NotFoundException('Agent rerank run not found')
    const [rankings, feedback] = await Promise.all([
      this.db
        .select()
        .from(agentRerankRankings)
        .where(eq(agentRerankRankings.rerankRunId, id))
        .orderBy(asc(agentRerankRankings.rerankRank), asc(agentRerankRankings.rrfRank)),
      this.db
        .select()
        .from(agentRerankFeedback)
        .where(eq(agentRerankFeedback.rerankRunId, id))
        .limit(1),
    ])
    return {
      id: run.id,
      agent_run_id: run.agentRunId,
      status: run.status,
      external_call_status: run.externalCallStatus,
      provider: run.provider,
      requested_model: run.requestedModel,
      provider_request_id: run.providerRequestId,
      request_bytes: run.requestBytes,
      total_tokens: run.totalTokens,
      estimated_cost_cny: run.estimatedCostCny === null ? null : Number(run.estimatedCostCny),
      latency_ms: run.latencyMs,
      error: run.errorCode ? { code: run.errorCode, message: run.errorMessage } : null,
      rankings: rankings.map((item) => ({
        candidate_key: item.candidateKey,
        rrf_rank: item.rrfRank,
        rerank_rank: item.rerankRank,
        relevance_score: item.relevanceScore === null ? null : Number(item.relevanceScore),
      })),
      feedback: feedback[0]?.verdict ?? null,
    }
  }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
