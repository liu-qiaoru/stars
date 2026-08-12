import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common'
import {
  shadowRerankRequestSchema,
  shadowRerankResponseSchema,
} from '@local-media-agent/shared/schemas'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { z, ZodError } from 'zod'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  candidateEvidence,
  evaluationCandidates,
  evaluationJudgments,
  evaluationQueries,
  evaluationRuns,
  evaluationShadowAttempts,
  evaluationShadowRankings,
  evaluationShadowRuns,
  mediaAssets,
  mediaFiles,
} from '../database/schema.js'
import { calculateRankingMetrics, type RankingMetrics } from '../ranking/metrics.js'
import { SHADOW_RERANK_PROVIDER, type ShadowRerankProvider } from './shadow-rerank.provider.js'

const PROTOCOL_VERSION = 'qwen3-vl-rerank-top20-v1'
const MODEL = 'qwen3-vl-rerank'
const REQUEST_TIMEOUT_MS = 120_000

// TypeScript 接口不能保护运行时 Provider 边界；用量和费用也必须先做
// Schema 校验，否则负 token、NaN 费用或过长 request ID 会污染历史报告。
const providerAuditSchema = z
  .object({
    providerRequestId: z.string().min(1).max(500).nullable(),
    responseModel: z.string().min(1).max(200),
    modelSnapshot: z.string().min(1).max(500).nullable(),
    region: z.string().min(1).max(200).nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    billedCostCny: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((value) => value.totalTokens === value.inputTokens + value.outputTokens, {
    path: ['totalTokens'],
    message: 'totalTokens must equal inputTokens + outputTokens',
  })

type CandidateRow = typeof evaluationCandidates.$inferSelect
type ShadowRankingRow = typeof evaluationShadowRankings.$inferSelect
type EvaluationQueryRow = typeof evaluationQueries.$inferSelect
type EvaluationJudgmentRow = typeof evaluationJudgments.$inferSelect

/**
 * 影子重排只读取 Evaluation 的冻结 RRF Top-20 与 Phase D 成功证据。它在网络调用前提交
 * dispatched，网络调用在事务外执行，返回后再用 attempt 状态做条件写入；普通 Search 和
 * agent_run_candidates 从不被更新。
 */
@Injectable()
export class ShadowRerankService implements OnModuleInit {
  private readonly logger = new Logger(ShadowRerankService.name)

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SHADOW_RERANK_PROVIDER) private readonly provider: ShadowRerankProvider,
  ) {}

  async onModuleInit() {
    await this.recoverInterrupted()
    const pending = await this.db
      .selectDistinct({ shadowRunId: evaluationShadowAttempts.shadowRunId })
      .from(evaluationShadowAttempts)
      .where(eq(evaluationShadowAttempts.status, 'pending'))
    for (const row of pending) {
      if (this.provider.available) {
        this.schedule(row.shadowRunId)
      }
    }
  }

  async start(evaluationRunId: string) {
    const [evaluationRun] = await this.db
      .select()
      .from(evaluationRuns)
      .where(eq(evaluationRuns.id, evaluationRunId))
      .limit(1)
    if (!evaluationRun) throw new NotFoundException('evaluation run not found')
    if (evaluationRun.status !== 'reported') {
      throw new ConflictException('evaluation run must be reported before shadow rerank')
    }
    const queryRows = await this.db
      .select({ id: evaluationQueries.id, searchScope: evaluationQueries.searchScope })
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, evaluationRun.versionId))
      .orderBy(asc(evaluationQueries.createdAt))

    const shadowRunId = randomUUID()
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(evaluationShadowRuns)
        .values({
          id: shadowRunId,
          evaluationRunId,
          protocolVersion: PROTOCOL_VERSION,
          status: 'pending',
          queryCount: queryRows.length,
        })
        .onConflictDoNothing()
        .returning()
      const run =
        inserted ??
        (
          await tx
            .select()
            .from(evaluationShadowRuns)
            .where(
              and(
                eq(evaluationShadowRuns.evaluationRunId, evaluationRunId),
                eq(evaluationShadowRuns.protocolVersion, PROTOCOL_VERSION),
              ),
            )
            .limit(1)
        )[0]
      if (!run) throw new Error('shadow rerank idempotency conflict could not be reloaded')
      for (const query of queryRows) {
        await tx
          .insert(evaluationShadowAttempts)
          .values({
            id: randomUUID(),
            shadowRunId: run.id,
            queryId: query.id,
            idempotencyKey: `${run.id}:${query.id}:${PROTOCOL_VERSION}`,
            status: query.searchScope === 'visual' ? 'pending' : 'not_applicable',
            notApplicableReason:
              query.searchScope === 'visual'
                ? null
                : '只有冻结 search_scope=visual 的查询可进入影子重排',
          })
          .onConflictDoNothing()
      }
    })
    return this.getByEvaluationRun(evaluationRunId)
  }

  /** HTTP 创建先返回可轮询事实，再调度后台执行；测试可直接调用 start 而不会遗留悬空任务。 */
  async startAndSchedule(evaluationRunId: string) {
    if (!this.provider.available) {
      // 真实视觉外发未授权时在创建持久化运行前拒绝。否则唯一幂等
      // 身份会被一次“Provider 禁用”失败占用，授权后也无法按同协议正常运行。
      throw new ConflictException('真实视觉外发授权尚未开启')
    }
    const result = await this.start(evaluationRunId)
    this.schedule(result.id)
    return result
  }

  /**
   * 后台调度只记录本地 UUID 和稳定错误码，不输出 Provider 异常原文。
   * executeAttempt 负责单查询失败；如果编排、汇总或最终读取异常，这里把
   * 仍处于 pending/running 的父 run 收敛为结构化失败，避免页面永久轮询。
   */
  private schedule(shadowRunId: string) {
    setImmediate(() => {
      void this.executePending(shadowRunId).catch(() => this.failScheduledRun(shadowRunId))
    })
  }

  private async failScheduledRun(shadowRunId: string) {
    this.logger.error(
      `shadow_rerank_scheduler_failed shadow_run_id=${shadowRunId} code=SHADOW_RERANK_SCHEDULER_FAILED`,
    )
    try {
      await this.db
        .update(evaluationShadowRuns)
        .set({
          status: 'failed',
          errorCode: 'SHADOW_RERANK_SCHEDULER_FAILED',
          errorMessage: '影子重排后台编排失败；未记录 Provider 原始内容',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationShadowRuns.id, shadowRunId),
            inArray(evaluationShadowRuns.status, ['pending', 'running']),
          ),
        )
    } catch {
      // 连持久化错误都失败时只能保留上面的脱敏日志；不再递归调度，
      // 也不输出可能包含本地数据的底层异常。
    }
  }

  async executePending(shadowRunId: string) {
    const attempts = await this.db
      .select()
      .from(evaluationShadowAttempts)
      .where(
        and(
          eq(evaluationShadowAttempts.shadowRunId, shadowRunId),
          eq(evaluationShadowAttempts.status, 'pending'),
        ),
      )
      .orderBy(asc(evaluationShadowAttempts.createdAt))
    await this.db
      .update(evaluationShadowRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(eq(evaluationShadowRuns.id, shadowRunId), eq(evaluationShadowRuns.status, 'pending')),
      )
    for (const attempt of attempts) await this.executeAttempt(attempt.id)
    await this.refreshRunStatus(shadowRunId)
    return this.get(shadowRunId)
  }

  /** Server 启动时调用：已 dispatched 的请求结果未知，只能落 outcome_unknown，绝不重放。 */
  async recoverInterrupted() {
    const interrupted = await this.db
      .select({
        id: evaluationShadowAttempts.id,
        shadowRunId: evaluationShadowAttempts.shadowRunId,
      })
      .from(evaluationShadowAttempts)
      .where(
        and(
          eq(evaluationShadowAttempts.status, 'running'),
          eq(evaluationShadowAttempts.externalCallStatus, 'dispatched'),
        ),
      )
    for (const attempt of interrupted) {
      await this.db
        .update(evaluationShadowAttempts)
        .set({
          status: 'outcome_unknown',
          externalCallStatus: 'outcome_unknown',
          errorCode: 'SHADOW_RERANK_OUTCOME_UNKNOWN',
          errorMessage: 'Provider 请求已发出，但 Server 未获得可确认结果；不会自动重试',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationShadowAttempts.id, attempt.id))
      await this.refreshRunStatus(attempt.shadowRunId)
    }
    return interrupted.length
  }

  private async executeAttempt(attemptId: string) {
    const [attempt] = await this.db
      .select()
      .from(evaluationShadowAttempts)
      .where(eq(evaluationShadowAttempts.id, attemptId))
      .limit(1)
    if (!attempt || attempt.status !== 'pending') return
    let providerResponseReceived = false
    try {
      const prepared = await this.prepareRequest(attempt)
      if (!this.provider.available) {
        throw new ShadowRerankError(
          'SHADOW_RERANK_PROVIDER_DISABLED',
          '真实 qwen3-vl-rerank 调用尚未获得视觉外发授权',
        )
      }
      const [claimed] = await this.db
        .update(evaluationShadowAttempts)
        .set({
          status: 'running',
          externalCallStatus: 'dispatched',
          queryFingerprint: prepared.queryFingerprint,
          evidenceFingerprint: prepared.evidenceFingerprint,
          requestBytes: prepared.requestBytes,
          actualCandidateCount: 20,
          dispatchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationShadowAttempts.id, attemptId),
            eq(evaluationShadowAttempts.status, 'pending'),
            eq(evaluationShadowAttempts.externalCallStatus, 'not_dispatched'),
          ),
        )
        .returning()
      if (!claimed) return

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const started = Date.now()
      let providerResult
      try {
        providerResult = await this.provider.rerank(prepared.request, controller.signal)
        providerResponseReceived = true
      } catch {
        await this.db
          .update(evaluationShadowAttempts)
          .set({
            status: 'outcome_unknown',
            externalCallStatus: 'outcome_unknown',
            errorCode: 'SHADOW_RERANK_OUTCOME_UNKNOWN',
            errorMessage: 'Provider 请求已发出但未获得明确响应；不会自动重试',
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(evaluationShadowAttempts.id, attemptId),
              eq(evaluationShadowAttempts.status, 'running'),
              eq(evaluationShadowAttempts.externalCallStatus, 'dispatched'),
            ),
          )
        return
      } finally {
        clearTimeout(timeout)
      }
      const latencyMs = Date.now() - started
      const rawProviderAudit = {
        providerRequestId: providerResult.providerRequestId,
        responseModel: providerResult.responseModel,
        modelSnapshot: providerResult.modelSnapshot,
        region: providerResult.region,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        totalTokens: providerResult.totalTokens,
        billedCostCny: providerResult.billedCostCny,
      }
      const responseFingerprint = safeFingerprint(providerResult.response)
      const actualResultCount = Array.isArray(
        (providerResult.response as { results?: unknown } | null)?.results,
      )
        ? (providerResult.response as { results: unknown[] }).results.length
        : 0
      // 先保存已收到的脱敏审计事实，再校验 Top-10。因此即使输出重复或
      // 不完整，报告仍能说明实际返回数、request ID、耗时、用量与响应指纹。
      // 每个元数据字段独立标准化，避免一个错误 totalTokens 抹掉其余已知事实；
      // 完整 Schema 仍在写入后统一校验，并让本次尝试整体失败且排名为空。
      const safeAudit = independentlySafeProviderAudit(rawProviderAudit)
      await this.db
        .update(evaluationShadowAttempts)
        .set({
          providerRequestId: safeAudit.providerRequestId,
          externalCallStatus: 'completed',
          responseModel: safeAudit.responseModel,
          modelSnapshot: safeAudit.modelSnapshot,
          region: safeAudit.region,
          responseFingerprint,
          inputTokens: safeAudit.inputTokens,
          outputTokens: safeAudit.outputTokens,
          totalTokens: safeAudit.totalTokens,
          latencyMs,
          billedCostCny:
            safeAudit.billedCostCny === null ? null : safeAudit.billedCostCny.toString(),
          actualResultCount,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationShadowAttempts.id, attemptId),
            eq(evaluationShadowAttempts.status, 'running'),
            eq(evaluationShadowAttempts.externalCallStatus, 'dispatched'),
          ),
        )
      const providerAudit = providerAuditSchema.parse(rawProviderAudit)
      if (providerAudit.responseModel !== MODEL) {
        throw new ShadowRerankError(
          'SHADOW_RESPONSE_MODEL_MISMATCH',
          'Provider 响应模型不是冻结的 qwen3-vl-rerank',
        )
      }
      const response = shadowRerankResponseSchema.parse(providerResult.response)
      await this.db.transaction(async (tx) => {
        const [completed] = await tx
          .update(evaluationShadowAttempts)
          .set({
            status: 'succeeded',
            externalCallStatus: 'completed',
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(evaluationShadowAttempts.id, attemptId),
              eq(evaluationShadowAttempts.status, 'running'),
              eq(evaluationShadowAttempts.externalCallStatus, 'completed'),
            ),
          )
          .returning()
        if (!completed) return
        const resultByIndex = new Map(
          response.results.map((result, index) => [result.index, { ...result, rank: index + 1 }]),
        )
        await tx.insert(evaluationShadowRankings).values(
          prepared.candidates.map((candidate, index) => {
            const result = resultByIndex.get(index)
            return {
              id: randomUUID(),
              attemptId,
              candidateId: candidate.id,
              candidateKey: candidate.candidateKey,
              rrfRank: candidate.rrfRank!,
              shadowRank: result?.rank ?? null,
              relevanceScore: result?.relevance_score.toString() ?? null,
            }
          }),
        )
      })
    } catch (error) {
      const normalized = normalizeError(error)
      await this.db
        .update(evaluationShadowAttempts)
        .set({
          status: 'failed',
          externalCallStatus: providerResponseReceived ? 'completed' : undefined,
          errorCode: normalized.code,
          errorMessage: normalized.message,
          errorDetailsJson: normalized.details,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationShadowAttempts.id, attemptId),
            inArray(evaluationShadowAttempts.status, ['pending', 'running']),
          ),
        )
    }
  }

  private async prepareRequest(attempt: typeof evaluationShadowAttempts.$inferSelect) {
    const [query] = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.id, attempt.queryId))
      .limit(1)
    if (!query) throw new ShadowRerankError('SHADOW_QUERY_MISSING', '冻结查询不存在')
    const candidates = await this.db
      .select()
      .from(evaluationCandidates)
      .where(
        and(
          eq(
            evaluationCandidates.runId,
            (await this.shadowRun(attempt.shadowRunId)).evaluationRunId,
          ),
          eq(evaluationCandidates.queryId, query.id),
          sql`${evaluationCandidates.rrfRank} between 1 and 20`,
        ),
      )
      .orderBy(asc(evaluationCandidates.rrfRank))
    validateCandidates(candidates)
    const videoCandidates = candidates.filter((candidate) => candidate.mediaType === 'video')
    const evidence = videoCandidates.length
      ? await this.db
          .select()
          .from(candidateEvidence)
          .where(
            and(
              eq(candidateEvidence.sourceType, 'evaluation_candidate'),
              inArray(
                candidateEvidence.sourceId,
                videoCandidates.map((candidate) => candidate.id),
              ),
              eq(candidateEvidence.strategy, 'contact_sheet_v1'),
              eq(candidateEvidence.protocolVersion, 'candidate-evidence-v1'),
              eq(candidateEvidence.status, 'succeeded'),
            ),
          )
      : []
    const evidenceByCandidate = new Map(evidence.map((row) => [row.sourceId, row]))
    const documents = []
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.mediaType === 'image') {
        const imageBytes = await this.readFrozenImage(candidate, index)
        documents.push({
          index,
          candidate_key: candidate.candidateKey,
          evidence_sha256: createHash('sha256').update(imageBytes).digest('hex'),
          image_base64: imageBytes.toString('base64'),
        })
        continue
      }
      const row = evidenceByCandidate.get(candidate.id)
      if (!row?.artifactPath || !row.artifactSha256 || !row.inputSha256) {
        throw new ShadowRerankError(
          'SHADOW_EVIDENCE_INCOMPLETE',
          '每个视频候选必须拥有成功的 contact_sheet_v1 证据',
          {
            actual_video_candidate_count: videoCandidates.length,
            actual_evidence_count: evidence.length,
          },
        )
      }
      if (
        row.candidateKey !== candidate.candidateKey ||
        row.fileId !== candidate.fileId ||
        row.fileGeneration !== candidate.fileGeneration ||
        row.assetId !== candidate.assetId ||
        row.sceneId !== candidate.sceneId
      ) {
        throw new ShadowRerankError(
          'SHADOW_EVIDENCE_IDENTITY_MISMATCH',
          '候选证据与冻结 Evaluation 快照身份不一致',
          { candidate_index: index },
        )
      }
      const bytes = await readFile(row.artifactPath)
      if (createHash('sha256').update(bytes).digest('hex') !== row.artifactSha256) {
        throw new ShadowRerankError(
          'SHADOW_EVIDENCE_FINGERPRINT_MISMATCH',
          '候选证据指纹校验失败',
          { candidate_index: index },
        )
      }
      documents.push({
        index,
        candidate_key: candidate.candidateKey,
        evidence_sha256: row.artifactSha256,
        image_base64: bytes.toString('base64'),
      })
    }
    const request = shadowRerankRequestSchema.parse({
      model: MODEL,
      query: query.queryText,
      top_n: 10,
      documents,
    })
    return {
      request,
      candidates,
      queryFingerprint: fingerprint(query.queryText),
      evidenceFingerprint: fingerprint(documents.map((document) => document.evidence_sha256)),
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
    }
  }

  /**
   * 图片候选不伪造 Phase D contact sheet：Server 重新校验冻结 file/Asset/generation，
   * 再用 Sharp 把原图等比缩放到 1600×1600 边界内并固定输出 PNG。Sharp 是 Node.js
   * 图像处理库，这里只做内存中缩放，不写临时文件，也不向 API 暴露原路径。
   */
  private async readFrozenImage(candidate: CandidateRow, candidateIndex: number) {
    const [current] = await this.db
      .select({
        path: mediaFiles.path,
        fileGeneration: mediaFiles.indexGeneration,
        fileMediaType: mediaFiles.mediaType,
        assetId: mediaAssets.id,
        assetType: mediaAssets.assetType,
      })
      .from(mediaFiles)
      .innerJoin(
        mediaAssets,
        and(eq(mediaAssets.id, candidate.assetId), eq(mediaAssets.fileId, mediaFiles.id)),
      )
      .where(and(eq(mediaFiles.id, candidate.fileId), isNull(mediaFiles.deletedAt)))
      .limit(1)
    if (
      !current ||
      current.fileGeneration !== candidate.fileGeneration ||
      current.fileMediaType !== 'image' ||
      current.assetId !== candidate.assetId ||
      current.assetType !== 'image'
    ) {
      throw new ShadowRerankError(
        'SHADOW_IMAGE_IDENTITY_MISMATCH',
        '图片候选与当前文件 generation/Asset 事实不一致',
        { candidate_index: candidateIndex },
      )
    }
    try {
      return await sharp(current.path)
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer()
    } catch {
      throw new ShadowRerankError('SHADOW_IMAGE_READ_FAILED', '图片候选无法读取或缩放', {
        candidate_index: candidateIndex,
      })
    }
  }

  private async shadowRun(id: string) {
    const [run] = await this.db
      .select()
      .from(evaluationShadowRuns)
      .where(eq(evaluationShadowRuns.id, id))
      .limit(1)
    if (!run) throw new NotFoundException('shadow rerank run not found')
    return run
  }

  private async refreshRunStatus(shadowRunId: string) {
    const attempts = await this.db
      .select()
      .from(evaluationShadowAttempts)
      .where(eq(evaluationShadowAttempts.shadowRunId, shadowRunId))
    const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded')
    const failed = attempts.filter((attempt) =>
      ['failed', 'outcome_unknown'].includes(attempt.status),
    )
    const notApplicable = attempts.filter((attempt) => attempt.status === 'not_applicable')
    const applicableCount = attempts.length - notApplicable.length
    const terminal = succeeded.length + failed.length + notApplicable.length === attempts.length
    const status = !terminal
      ? 'running'
      : applicableCount === 0
        ? 'not_applicable'
        : succeeded.length === applicableCount
          ? 'succeeded'
          : succeeded.length > 0
            ? 'completed_with_errors'
            : 'failed'
    await this.db
      .update(evaluationShadowRuns)
      .set({
        status,
        succeededCount: succeeded.length,
        failedCount: failed.length,
        notApplicableCount: notApplicable.length,
        actualSampleCount: succeeded.length,
        requestBytes: attempts.reduce((sum, attempt) => sum + (attempt.requestBytes ?? 0), 0),
        inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0),
        totalTokens: attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0),
        latencyMs: attempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0),
        billedCostCny: attempts
          .reduce((sum, attempt) => sum + Number(attempt.billedCostCny ?? 0), 0)
          .toString(),
        responseModel: succeeded[0]?.responseModel ?? null,
        modelSnapshot: succeeded[0]?.modelSnapshot ?? null,
        region: succeeded[0]?.region ?? null,
        errorCode: failed.length ? 'SHADOW_RERANK_ATTEMPTS_FAILED' : null,
        errorMessage: failed.length ? `${failed.length} 个影子重排尝试失败或结果未知` : null,
        errorDetailsJson: failed.length
          ? { failed_attempt_count: failed.length, actual_sample_count: succeeded.length }
          : null,
        finishedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(evaluationShadowRuns.id, shadowRunId))
  }

  async getByEvaluationRun(evaluationRunId: string) {
    const [run] = await this.db
      .select()
      .from(evaluationShadowRuns)
      .where(
        and(
          eq(evaluationShadowRuns.evaluationRunId, evaluationRunId),
          eq(evaluationShadowRuns.protocolVersion, PROTOCOL_VERSION),
        ),
      )
      .limit(1)
    if (!run) throw new NotFoundException('shadow rerank has not been started')
    return this.get(run.id)
  }

  async findByEvaluationRun(evaluationRunId: string) {
    const [run] = await this.db
      .select({ id: evaluationShadowRuns.id })
      .from(evaluationShadowRuns)
      .where(
        and(
          eq(evaluationShadowRuns.evaluationRunId, evaluationRunId),
          eq(evaluationShadowRuns.protocolVersion, PROTOCOL_VERSION),
        ),
      )
      .limit(1)
    return run ? this.get(run.id) : null
  }

  async get(id: string) {
    const run = await this.shadowRun(id)
    const attempts = await this.db
      .select()
      .from(evaluationShadowAttempts)
      .where(eq(evaluationShadowAttempts.shadowRunId, id))
      .orderBy(asc(evaluationShadowAttempts.createdAt))
    const rankings = attempts.length
      ? await this.db
          .select()
          .from(evaluationShadowRankings)
          .where(
            inArray(
              evaluationShadowRankings.attemptId,
              attempts.map((attempt) => attempt.id),
            ),
          )
          .orderBy(asc(evaluationShadowRankings.rrfRank))
      : []
    const queryIds = attempts.map((attempt) => attempt.queryId)
    const queries = queryIds.length
      ? await this.db
          .select()
          .from(evaluationQueries)
          .where(inArray(evaluationQueries.id, queryIds))
      : []
    const candidateIds = rankings.map((ranking) => ranking.candidateId)
    const judgments = candidateIds.length
      ? await this.db
          .select()
          .from(evaluationJudgments)
          .where(inArray(evaluationJudgments.candidateId, candidateIds))
      : []
    const queryById = new Map(queries.map((query) => [query.id, query]))
    const judgmentByCandidate = new Map(
      judgments.map((judgment) => [judgment.candidateId, judgment]),
    )
    const metricsByQuery = new Map<string, { rrf: RankingMetrics; shadow: RankingMetrics }>()
    for (const attempt of attempts) {
      const attemptRankings = rankings.filter((ranking) => ranking.attemptId === attempt.id)
      const query = queryById.get(attempt.queryId)
      const metrics = calculateAttemptMetrics(
        attempt.status,
        attemptRankings,
        query,
        judgmentByCandidate,
      )
      if (metrics) metricsByQuery.set(attempt.queryId, metrics)
    }
    const [baselineRun] = await this.db
      .select({ reportJson: evaluationRuns.reportJson })
      .from(evaluationRuns)
      .where(eq(evaluationRuns.id, run.evaluationRunId))
      .limit(1)
    const baselineMetrics = readBaselineMetrics(baselineRun?.reportJson)
    return {
      id: run.id,
      evaluation_run_id: run.evaluationRunId,
      status: run.status,
      provider: run.provider,
      requested_model: run.requestedModel,
      response_model: run.responseModel,
      model_snapshot: run.modelSnapshot,
      region: run.region,
      protocol_version: run.protocolVersion,
      query_count: run.queryCount,
      succeeded_count: run.succeededCount,
      failed_count: run.failedCount,
      not_applicable_count: run.notApplicableCount,
      actual_sample_count: run.actualSampleCount,
      request_bytes: run.requestBytes,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      total_tokens: run.totalTokens,
      latency_ms: run.latencyMs,
      billed_cost_cny: Number(run.billedCostCny),
      review_status: 'not_run',
      error:
        run.errorCode && run.errorMessage
          ? { code: run.errorCode, message: run.errorMessage, details: run.errorDetailsJson }
          : null,
      metric_summary: buildMetricSummary(attempts, metricsByQuery, baselineMetrics),
      attempts: attempts.map((attempt) => {
        const attemptRankings = rankings.filter((ranking) => ranking.attemptId === attempt.id)
        const query = queryById.get(attempt.queryId)
        return {
          id: attempt.id,
          query_id: attempt.queryId,
          query_text: query?.queryText ?? '',
          status: attempt.status,
          external_call_status: attempt.externalCallStatus,
          provider_request_id: attempt.providerRequestId,
          response_model: attempt.responseModel,
          model_snapshot: attempt.modelSnapshot,
          region: attempt.region,
          query_fingerprint: attempt.queryFingerprint,
          evidence_fingerprint: attempt.evidenceFingerprint,
          response_fingerprint: attempt.responseFingerprint,
          request_bytes: attempt.requestBytes,
          input_tokens: attempt.inputTokens,
          output_tokens: attempt.outputTokens,
          total_tokens: attempt.totalTokens,
          latency_ms: attempt.latencyMs,
          billed_cost_cny: attempt.billedCostCny === null ? null : Number(attempt.billedCostCny),
          actual_candidate_count: attempt.actualCandidateCount,
          actual_result_count: attempt.actualResultCount,
          error:
            attempt.errorCode && attempt.errorMessage
              ? {
                  code: attempt.errorCode,
                  message: attempt.errorMessage,
                  details: attempt.errorDetailsJson,
                }
              : null,
          applicability_reason: attempt.notApplicableReason,
          metrics: metricsByQuery.get(attempt.queryId) ?? null,
          rankings: attemptRankings.map((ranking) => ({
            candidate_id: ranking.candidateId,
            candidate_key: ranking.candidateKey,
            rrf_rank: ranking.rrfRank,
            shadow_rank: ranking.shadowRank,
            relevance_score:
              ranking.relevanceScore === null ? null : Number(ranking.relevanceScore),
          })),
        }
      }),
      created_at: run.createdAt.toISOString(),
      finished_at: run.finishedAt?.toISOString() ?? null,
    }
  }
}

function calculateAttemptMetrics(
  status: string,
  attemptRankings: ShadowRankingRow[],
  query: EvaluationQueryRow | undefined,
  judgmentByCandidate: Map<string, EvaluationJudgmentRow>,
) {
  if (status !== 'succeeded' || !query) return null
  const shadowTop10Keys = attemptRankings
    .filter((ranking) => ranking.shadowRank !== null)
    .sort((left, right) => left.shadowRank! - right.shadowRank!)
    .map((ranking) => ranking.candidateKey)
  const rrfKeys = [...attemptRankings]
    .sort((left, right) => left.rrfRank - right.rrfRank)
    .map((ranking) => ranking.candidateKey)
  // Provider 只返回新 Top-10。为计算 nDCG@20 和 MRR，未进入新 Top-10 的
  // 候选按冻结 RRF 顺序接在后面；这只是影子报告口径，不回写普通排名。
  const selectedKeys = new Set(shadowTop10Keys)
  const shadowKeys = [
    ...shadowTop10Keys,
    ...rrfKeys.filter((candidateKey) => !selectedKeys.has(candidateKey)),
  ]
  const judgments = new Map(
    query.queryType === 'discovery'
      ? attemptRankings.flatMap((ranking) => {
          const judgment = judgmentByCandidate.get(ranking.candidateId)
          return judgment
            ? [
                [
                  ranking.candidateKey,
                  judgment.unjudgeable ? null : (judgment.relevance as 0 | 1 | 2),
                ] as [string, 0 | 1 | 2 | null],
              ]
            : []
        })
      : [],
  )
  const options = { knownTargetKey: query.targetSceneId ?? query.targetAssetId }
  return {
    rrf: calculateRankingMetrics(rrfKeys, judgments, options),
    shadow: calculateRankingMetrics(shadowKeys, judgments, options),
  }
}

/** 只从 evaluation_runs.report_json 读冻结 RRF 指标；字段畸形时不猜测或修补。 */
function readBaselineMetrics(value: unknown) {
  const result = new Map<string, RankingMetrics>()
  if (!isRecord(value) || !Array.isArray(value.queries)) return result
  for (const row of value.queries) {
    if (isRecord(row) && typeof row.query_id === 'string' && isRankingMetrics(row.rrf)) {
      result.set(row.query_id, row.rrf)
    }
  }
  return result
}

function buildMetricSummary(
  attempts: Array<{ queryId: string; status: string }>,
  metricsByQuery: Map<string, { rrf: RankingMetrics; shadow: RankingMetrics }>,
  baselineByQuery: Map<string, RankingMetrics>,
) {
  const successful = [...metricsByQuery.values()]
  const applicable = attempts.filter((attempt) => attempt.status !== 'not_applicable')
  const fullPairs = applicable.flatMap((attempt) => {
    const succeeded = metricsByQuery.get(attempt.queryId)
    const rrf = succeeded?.rrf ?? baselineByQuery.get(attempt.queryId)
    return rrf ? [{ rrf, shadow: succeeded?.shadow ?? rrf }] : []
  })
  return {
    successful_samples: {
      n: successful.length,
      rrf: averageRankingMetrics(successful.map((pair) => pair.rrf)),
      shadow: averageRankingMetrics(successful.map((pair) => pair.shadow)),
    },
    // 完整产品口径把技术失败查询按原 RRF 回退，不会通过删除失败样本夸大改善。
    full_product_samples: {
      n: fullPairs.length,
      rrf: averageRankingMetrics(fullPairs.map((pair) => pair.rrf)),
      shadow_with_rrf_fallback: averageRankingMetrics(fullPairs.map((pair) => pair.shadow)),
    },
  }
}

const metricKeys = [
  'precisionAt5',
  'precisionAt10',
  'ndcgAt10',
  'ndcgAt20',
  'hitAt5',
  'hitAt10',
  'hitAt20',
  'reciprocalRank',
] as const

function averageRankingMetrics(values: RankingMetrics[]): RankingMetrics | null {
  if (!values.length) return null
  const result = Object.fromEntries(
    metricKeys.map((key) => {
      const applicable = values.flatMap((metrics) =>
        metrics[key] === null ? [] : [metrics[key] as number],
      )
      return [
        key,
        applicable.length
          ? applicable.reduce((sum, current) => sum + current, 0) / applicable.length
          : null,
      ]
    }),
  ) as Omit<RankingMetrics, 'unjudgeableCount'>
  return {
    ...result,
    unjudgeableCount: values.reduce((sum, metrics) => sum + metrics.unjudgeableCount, 0),
  }
}

function isRankingMetrics(value: unknown): value is RankingMetrics {
  return (
    isRecord(value) &&
    metricKeys.every(
      (key) =>
        value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])),
    ) &&
    typeof value.unjudgeableCount === 'number'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateCandidates(candidates: CandidateRow[]) {
  if (candidates.length !== 20) {
    throw new ShadowRerankError('SHADOW_TOP20_INCOMPLETE', '影子重排必须读取完整 RRF Top-20', {
      actual_candidate_count: candidates.length,
    })
  }
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== 20 ||
    candidates.some((candidate, index) => candidate.rrfRank !== index + 1)
  ) {
    throw new ShadowRerankError('SHADOW_TOP20_INVALID', 'RRF Top-20 身份重复或名次不连续')
  }
  if (candidates.some((candidate) => !['image', 'video'].includes(candidate.mediaType))) {
    throw new ShadowRerankError('SHADOW_QUERY_NOT_VISUAL', '影子重排只适用于纯视觉图片或视频候选')
  }
}

function fingerprint(value: unknown) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new ShadowRerankError('SHADOW_FINGERPRINT_INVALID', '无法为 Provider 响应生成指纹')
  }
  return createHash('sha256').update(encoded).digest('hex')
}

/** Provider 已明确返回后，响应本体指纹应独立于计量字段保存。 */
function safeFingerprint(value: unknown) {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? null : createHash('sha256').update(encoded).digest('hex')
}

/**
 * 审计字段逐项收窄；非法字段保存 null，合法字段仍保留。随后整体 Schema 会拒绝
 * 这次 Provider 返回，因此这个函数不会把部分有效计量误当成成功结果。
 */
function independentlySafeProviderAudit(value: Record<string, unknown>) {
  const safeString = (input: unknown, max: number) =>
    typeof input === 'string' && input.length > 0 && input.length <= max ? input : null
  const safeNullableString = (input: unknown, max: number) =>
    input === null ? null : safeString(input, max)
  const safeInteger = (input: unknown) =>
    typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : null
  const inputTokens = safeInteger(value.inputTokens)
  const outputTokens = safeInteger(value.outputTokens)
  const rawTotalTokens = safeInteger(value.totalTokens)
  return {
    providerRequestId: safeNullableString(value.providerRequestId, 500),
    responseModel: safeString(value.responseModel, 200),
    modelSnapshot: safeNullableString(value.modelSnapshot, 500),
    region: safeNullableString(value.region, 200),
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== null && outputTokens !== null && rawTotalTokens === inputTokens + outputTokens
        ? rawTotalTokens
        : null,
    billedCostCny:
      typeof value.billedCostCny === 'number' &&
      Number.isFinite(value.billedCostCny) &&
      value.billedCostCny >= 0
        ? value.billedCostCny
        : null,
  }
}

class ShadowRerankError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message)
  }
}

function normalizeError(error: unknown) {
  if (error instanceof ShadowRerankError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof ZodError) {
    return {
      code: 'SHADOW_PROVIDER_RESPONSE_INVALID',
      message: 'Provider 响应或计量元数据不符合冻结 Schema',
      // 只保存字段路径和校验类型，不把 Provider 原始内容或图像带入 API。
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      },
    }
  }
  return {
    code: 'SHADOW_RERANK_FAILED',
    message: '影子重排失败；详细 Provider 内容未写入 API 或日志',
    details: null,
  }
}
