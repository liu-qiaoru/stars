import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import {
  agentRerankFeedbackInputSchema,
  shadowRerankRequestSchema,
  shadowRerankResponseSchema,
  startAgentRerankInputSchema,
} from '@local-media-agent/shared/schemas'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
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
  agentRunAuthorizations,
  agentRunCandidates,
  agentRuns,
  candidateEvidence,
  mediaAssets,
  mediaFiles,
} from '../database/schema.js'
import { dashScopeShadowRerankRequestBytes } from '../evaluation/dashscope-shadow-rerank.provider.js'
import {
  ShadowRerankProviderResponseError,
  type ShadowRerankProvider,
} from '../evaluation/shadow-rerank.provider.js'
import { AGENT_RERANK_PROVIDER } from './agent-rerank.provider.js'

const PROTOCOL_VERSION = 'qwen3-vl-rerank-top20-v1'
const MODEL = 'qwen3-vl-rerank'
const MAX_REQUEST_COST_CNY = 0.216
const IMAGE_INPUT_COST_CNY_PER_TOKEN = 1.8 / 1_000_000

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
 * 编排用户主动开启的产品 Rerank。视频证据先由 Python Worker 异步生成；Server 随后
 * 校验 Top-20 冻结身份，在网络前提交 dispatched，最后把 Top-10 作为独立排序写回。
 * 它从不改写 agent_run_candidates.rank，因此页面和后续汇总始终保留同一份 RRF 基线。
 */
@Injectable()
export class AgentRerankService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRerankService.name)
  private timer?: NodeJS.Timeout
  private ticking = false

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AGENT_RERANK_PROVIDER) private readonly provider: ShadowRerankProvider,
    @Inject(SETTINGS)
    private readonly settings: Pick<Settings, 'agentRerankTimeoutMs' | 'agentExecutorIntervalMs'>,
    @Inject(CandidateEvidenceService)
    private readonly evidenceService: CandidateEvidenceService,
  ) {}

  async onModuleInit() {
    // 已经外发但没有终态的请求可能已被供应商处理；恢复时只标未知，不自动重放。
    await this.db
      .update(agentRerankRuns)
      .set({
        status: 'outcome_unknown',
        errorCode: 'AGENT_RERANK_OUTCOME_UNKNOWN_AFTER_RESTART',
        errorMessage: 'Rerank 请求已外发但 Server 未保存确定结果，禁止自动重试。',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRerankRuns.status, 'running'),
          eq(agentRerankRuns.externalCallStatus, 'dispatched'),
        ),
      )
    this.timer = setInterval(() => void this.tick(), this.settings.agentExecutorIntervalMs ?? 1_000)
    this.timer.unref()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  get available() {
    return this.provider.available
  }

  async start(agentRunId: string, raw: z.input<typeof startAgentRerankInputSchema>) {
    const parsedInput = startAgentRerankInputSchema.safeParse(raw)
    if (!parsedInput.success) throw new BadRequestException(parsedInput.error.flatten())
    const input = parsedInput.data
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'AGENT_RERANK_PROVIDER_DISABLED',
        message: '产品 Rerank 当前未启用，不会外发查询或图片。',
      })
    }
    if (input.max_cost_cny < MAX_REQUEST_COST_CNY) {
      throw new BadRequestException({
        code: 'AGENT_RERANK_BUDGET_TOO_LOW',
        message: `Top-20 请求需按最高 ¥${MAX_REQUEST_COST_CNY} 预留预算。`,
      })
    }
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, agentRunId))
      .limit(1)
    if (!run) throw new NotFoundException('Agent run not found')
    if (!['waiting_for_export_selection', 'succeeded'].includes(run.status)) {
      throw new ConflictException('Agent 搜索尚未完成，不能启动 Rerank')
    }
    const [authorization] = await this.db
      .select()
      .from(agentRunAuthorizations)
      .where(eq(agentRunAuthorizations.runId, agentRunId))
      .limit(1)
    if (!authorization?.allowExternalVisual) {
      throw new BadRequestException({
        code: 'AGENT_RERANK_VISUAL_AUTHORIZATION_REQUIRED',
        message: '本次 Agent run 未授权外发派生候选 PNG。',
      })
    }
    const candidates = await this.candidates(agentRunId)

    const [created] = await this.db
      .insert(agentRerankRuns)
      .values({
        id: randomUUID(),
        agentRunId,
        protocolVersion: PROTOCOL_VERSION,
        maxCostCny: String(input.max_cost_cny),
      })
      .onConflictDoNothing()
      .returning()
    const rerankRun =
      created ??
      (
        await this.db
          .select()
          .from(agentRerankRuns)
          .where(eq(agentRerankRuns.agentRunId, agentRunId))
          .limit(1)
      )[0]
    if (!rerankRun) throw new ConflictException('Rerank run conflict could not be reloaded')
    if (!created) return this.response(rerankRun.id)
    try {
      this.validateCandidates(candidates)
    } catch {
      await this.db
        .update(agentRerankRuns)
        .set({
          status: 'not_applicable',
          errorCode: 'AGENT_RERANK_TOP20_REQUIRED',
          errorMessage: '本次结果不是连续的视觉 RRF Top-20，未外发且不执行 Rerank。',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentRerankRuns.id, rerankRun.id))
      return this.response(rerankRun.id)
    }

    // 图片由 Server 在 dispatch 前直接缩放；视频才需要 Worker 生成场景 contact sheet。
    try {
      for (const candidate of candidates.filter((item) => item.mediaType === 'video')) {
        await this.evidenceService.createEvidence({
          source: { type: 'agent_run_candidate', run_id: agentRunId },
          candidate_key: candidate.candidateKey,
          strategies: ['contact_sheet_v1'],
        })
      }
    } catch {
      await this.fail(
        rerankRun.id,
        'AGENT_RERANK_EVIDENCE_QUEUE_FAILED',
        '视频派生 PNG 任务创建失败，未向 Provider 外发。',
      )
      return this.response(rerankRun.id)
    }
    void this.tick()
    return this.response(rerankRun.id)
  }

  async getForAgentRun(agentRunId: string) {
    const [run] = await this.db
      .select()
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.agentRunId, agentRunId))
      .limit(1)
    return run ? this.response(run.id) : null
  }

  async saveFeedback(rerankRunId: string, raw: z.input<typeof agentRerankFeedbackInputSchema>) {
    const parsedInput = agentRerankFeedbackInputSchema.safeParse(raw)
    if (!parsedInput.success) throw new BadRequestException(parsedInput.error.flatten())
    const input = parsedInput.data
    const [run] = await this.db
      .select()
      .from(agentRerankRuns)
      .where(eq(agentRerankRuns.id, rerankRunId))
      .limit(1)
    if (!run) throw new NotFoundException('Agent rerank run not found')
    if (run.status !== 'succeeded') throw new ConflictException('Rerank 尚未成功，不能提交比较反馈')
    const now = new Date()
    await this.db
      .insert(agentRerankFeedback)
      .values({
        id: randomUUID(),
        rerankRunId,
        verdict: input.verdict,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentRerankFeedback.rerankRunId,
        set: { verdict: input.verdict, updatedAt: now },
      })
    return this.response(rerankRunId)
  }

  /** 单执行器轮询只推进一个 run，避免同时在内存中持有多组 Base64 图片。 */
  async tick() {
    if (this.ticking || !this.provider.available) return
    this.ticking = true
    try {
      const [run] = await this.db
        .select()
        .from(agentRerankRuns)
        .where(eq(agentRerankRuns.status, 'preparing_evidence'))
        .orderBy(asc(agentRerankRuns.createdAt))
        .limit(1)
      if (run) await this.executeIfReady(run.id)
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'Agent rerank tick failed')
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
    const candidates = await this.candidates(rerankRun.agentRunId)
    this.validateCandidates(candidates)
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
    if (evidence.length !== videos.length || evidence.some((item) => item.status !== 'succeeded'))
      return

    let prepared: Awaited<ReturnType<AgentRerankService['prepareRequest']>>
    try {
      prepared = await this.prepareRequest(rerankRun.agentRunId, candidates, evidence)
    } catch {
      await this.fail(
        rerankRunId,
        'AGENT_RERANK_EVIDENCE_INVALID',
        '派生 PNG 或冻结候选身份校验失败，未向 Provider 外发。',
      )
      return
    }
    const [claimed] = await this.db
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
    if (!claimed) return

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
      const response = shadowRerankResponseSchema.parse(providerResult.response)
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
          .select({ status: agentRerankRuns.status })
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
        return true
      })
      if (!committed) return
    } catch (error) {
      const definite =
        error instanceof ShadowRerankProviderResponseError || error instanceof ZodError
      await this.db
        .update(agentRerankRuns)
        .set({
          status: definite ? 'failed' : 'outcome_unknown',
          externalCallStatus: definite ? 'completed' : 'dispatched',
          errorCode: definite
            ? error instanceof ShadowRerankProviderResponseError
              ? error.code
              : 'AGENT_RERANK_RESPONSE_INVALID'
            : 'AGENT_RERANK_OUTCOME_UNKNOWN',
          errorMessage: definite
            ? 'Rerank Provider 返回了确定失败。'
            : 'Rerank 请求可能已被处理，结果未知且不会自动重试。',
          latencyMs: Date.now() - startedAt,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(agentRerankRuns.id, rerankRunId), eq(agentRerankRuns.status, 'running')))
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
    const documents = []
    for (const [index, candidate] of candidates.entries()) {
      const bytes =
        candidate.mediaType === 'image'
          ? await this.readFrozenImage(candidate, index)
          : await this.readVideoEvidence(candidate, byKey.get(candidate.candidateKey), index)
      documents.push({
        index,
        candidate_key: candidate.candidateKey,
        evidence_sha256: createHash('sha256').update(bytes).digest('hex'),
        image_base64: bytes.toString('base64'),
      })
    }
    const request = shadowRerankRequestSchema.parse({
      model: MODEL,
      query: run.prompt,
      top_n: 10,
      documents,
    })
    return {
      request,
      queryFingerprint: fingerprint(run.prompt),
      evidenceFingerprint: fingerprint(documents.map((item) => item.evidence_sha256)),
      requestBytes: dashScopeShadowRerankRequestBytes(request),
    }
  }

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
    return sharp(row.path)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer()
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
    const bytes = await readFile(row.artifactPath)
    if (createHash('sha256').update(bytes).digest('hex') !== row.artifactSha256) {
      throw new ConflictException(`视频候选 ${index + 1} 的派生 PNG 指纹不一致`)
    }
    return bytes
  }

  private async candidates(agentRunId: string): Promise<FrozenCandidate[]> {
    return this.db
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
  }

  private validateCandidates(candidates: FrozenCandidate[]) {
    if (
      candidates.length !== 20 ||
      candidates.some((item, index) => item.rank !== index + 1) ||
      candidates.some((item) => !['image', 'video'].includes(item.mediaType))
    ) {
      throw new ConflictException('Rerank 只接受连续的视觉 RRF Top-20 候选')
    }
  }

  private async fail(id: string, code: string, message: string) {
    await this.db
      .update(agentRerankRuns)
      .set({
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRerankRuns.id, id))
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
