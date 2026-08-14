import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  vlmBlindConditionLabelInputSchema,
  vlmBlindLabelStageSchema,
  vlmCandidateReviewRequestSchema,
  type vlmReviewVerdictSchema,
} from '@local-media-agent/shared/schemas'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { CandidateEvidenceService } from '../candidate-evidence/candidate-evidence.service.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  candidateEvidence,
  evaluationVlmBlindCases,
  evaluationVlmBlindConditions,
  evaluationVlmBlindDatasets,
  evaluationVlmBlindFakeResults,
  evaluationVlmBlindFakeRuns,
  evaluationVlmBlindLabelingSessions,
} from '../database/schema.js'
import {
  deriveVlmReviewStatus,
  runVlmCandidateReview,
  VLM_REVIEW_PROVIDER,
  type VlmReviewProvider,
} from './vlm-review.provider.js'

type Verdict = z.infer<typeof vlmReviewVerdictSchema>
type ConditionRow = typeof evaluationVlmBlindConditions.$inferSelect

const bundleManifestSchema = z
  .object({
    candidate_key: z.string(),
    file_id: z.string().uuid(),
    scene_id: z.string().uuid(),
    protocol_version: z.literal('candidate-evidence-v1'),
    strategy: z.literal('all_indexed_frames_v1'),
    frames: z
      .array(
        z
          .object({
            asset_id: z.string().uuid(),
            frame_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            relative_path: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1)
      .max(12),
  })
  .passthrough()

/**
 * Phase F 人工条件盲标的主控服务。
 *
 * 候选 dataset 始终保持 frozen；本服务用独立 labeling session 表达证据准备、三轮人工标注、
 * 标签冻结和 fake 演练。证据仍由现有 Python Worker 异步构建，本服务只复用冻结
 * Evaluation candidate 身份创建 Job，并且从不搜索、扫描、索引或访问 Qdrant。
 */
@Injectable()
export class VlmBlindLabelingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CandidateEvidenceService)
    private readonly evidenceService: CandidateEvidenceService,
    @Inject(VLM_REVIEW_PROVIDER)
    private readonly provider: VlmReviewProvider,
  ) {}

  /** 只读聚合当前进度；读取页面不会创建证据 Job，也不会执行 fake Provider。 */
  async get(datasetId: string) {
    const state = await this.loadState(datasetId)
    return this.toResponse(state)
  }

  /**
   * 为 60 个有效叶子逐一创建或复用 all_indexed_frames_v1。
   * CandidateEvidenceService 使用冻结 candidate UUID + generation 做幂等身份；中途失败时
   * 已创建的 Job 可保留，重复调用只补齐失败或缺失项，不会重新检索候选。
   */
  async prepareEvidence(datasetId: string) {
    const state = await this.loadState(datasetId)
    this.assertCandidatePoolFrozen(state.dataset.status)
    await this.ensureSession(datasetId)
    for (const candidateCase of state.cases) {
      await this.evidenceService.createEvidence({
        source: {
          type: 'evaluation_candidate',
          run_id: candidateCase.sourceEvaluationRunId,
          candidate_id: candidateCase.sourceCandidateId,
        },
        candidate_key: candidateCase.candidateKey,
        strategies: ['all_indexed_frames_v1'],
      })
    }
    return this.get(datasetId)
  }

  /**
   * 保存一条条件的某一轮人工判断。阶段和 condition row UUID 共同形成幂等位置；
   * 重复保存只覆盖同一列，不追加重复标签。第二轮必须等待一审全部完成，最终裁决只允许
   * 用于两轮不一致或仍含 uncertain 的条件，防止把程序推断伪装成人工结论。
   */
  async saveConditionLabel(
    datasetId: string,
    caseId: string,
    conditionRowId: string,
    stageInput: unknown,
    input: unknown,
  ) {
    const stageResult = vlmBlindLabelStageSchema.safeParse(stageInput)
    const labelResult = vlmBlindConditionLabelInputSchema.safeParse(input)
    if (!stageResult.success || !labelResult.success) {
      throw new BadRequestException('invalid human condition label input')
    }
    const stage = stageResult.data
    const label = labelResult.data
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      // 与 freezeLabels 锁同一个 session，保证“最后一次标签写入”和“冻结指纹”有确定顺序。
      const state = await this.loadState(datasetId, db, true)
      this.assertCandidatePoolFrozen(state.dataset.status)
      if (!state.session || state.session.status === 'labels_frozen') {
        throw new ConflictException('human labels are not editable in the current state')
      }
      if (!allEvidenceSucceeded(state)) {
        throw new ConflictException('all candidate evidence must succeed before human labeling')
      }
      const candidateCase = state.cases.find((item) => item.id === caseId)
      const condition = state.conditions.find(
        (item) => item.id === conditionRowId && item.caseId === candidateCase?.id,
      )
      if (!candidateCase || !condition) {
        throw new NotFoundException('VLM blind condition not found in the active candidate pool')
      }
      if (stage === 'second' && state.conditions.some((item) => item.firstVerdict === null)) {
        throw new ConflictException('complete the first pass before starting second review')
      }
      if (stage === 'first' && state.conditions.some((item) => item.secondVerdict !== null)) {
        throw new ConflictException('the first pass is locked after second review starts')
      }
      if (stage === 'second' && state.conditions.some((item) => item.finalVerdict !== null)) {
        throw new ConflictException('second review is locked after final adjudication starts')
      }
      if (stage === 'final') {
        if (state.conditions.some((item) => item.secondVerdict === null)) {
          throw new ConflictException('complete the second pass before final adjudication')
        }
        if (!needsAdjudication(condition)) {
          throw new ConflictException('matching decisive labels do not require final adjudication')
        }
      }
      const now = new Date()
      await db
        .update(evaluationVlmBlindConditions)
        .set(
          stage === 'first'
            ? { firstVerdict: label.verdict, firstLabeledAt: now, labelNotes: label.notes ?? null }
            : stage === 'second'
              ? {
                  secondVerdict: label.verdict,
                  secondLabeledAt: now,
                  labelNotes: label.notes ?? null,
                }
              : {
                  finalVerdict: label.verdict,
                  finalLabeledAt: now,
                  labelNotes: label.notes ?? null,
                },
        )
        .where(eq(evaluationVlmBlindConditions.id, condition.id))
      return this.toResponse(await this.loadState(datasetId, db))
    })
  }

  /**
   * 冻结条件级人工真值。两轮一致的 yes/no 直接形成 resolved verdict；两轮不一致或任一轮
   * uncertain 时必须有人工 final=yes/no。这里不会自动补写 final 列，只把完整人工事实计算成
   * 稳定 SHA-256 指纹，之后所有标签写入口关闭。
   */
  async freezeLabels(datasetId: string) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const state = await this.loadState(datasetId, db, true)
      this.assertCandidatePoolFrozen(state.dataset.status)
      if (!state.session) throw new ConflictException('human labeling session has not started')
      if (state.session.status === 'labels_frozen') return this.toResponse(state)
      if (!allEvidenceSucceeded(state)) {
        throw new ConflictException('all candidate evidence must succeed before label freeze')
      }
      const resolved = state.conditions.map((condition) => ({
        condition_id: condition.id,
        verdict: resolvedVerdict(condition),
      }))
      if (resolved.some((item) => item.verdict === null)) {
        throw new ConflictException('human labels still require review or final adjudication')
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(resolved)).digest('hex')
      await db
        .update(evaluationVlmBlindLabelingSessions)
        .set({
          status: 'labels_frozen',
          labelsFingerprint: fingerprint,
          labelsFrozenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationVlmBlindLabelingSessions.id, state.session.id))
      return this.toResponse(await this.loadState(datasetId, db))
    })
  }

  /**
   * 标签冻结后同步执行一次本地 fake 协议演练。输入图片只在 Server 内存中转换为 Base64 并
   * 交给 FakeVlmReviewProvider；API、日志和数据库结果都不保存或返回图片内容。
   */
  async runFake(datasetId: string) {
    const state = await this.loadState(datasetId)
    if (!state.session || state.session.status !== 'labels_frozen') {
      throw new ConflictException('freeze human labels before the fake VLM exercise')
    }
    if (state.fakeRun && state.fakeRun.status !== 'running') return this.toResponse(state)
    if (state.fakeRun) throw new ConflictException('fake VLM exercise is already running')

    const fakeRunId = randomUUID()
    const [inserted] = await this.db
      .insert(evaluationVlmBlindFakeRuns)
      .values({
        id: fakeRunId,
        labelingSessionId: state.session.id,
        caseCount: state.cases.length,
      })
      .onConflictDoNothing()
      .returning()
    if (!inserted) {
      const current = await this.get(datasetId)
      if (current.fake_report?.status !== 'running') return current
      throw new ConflictException('fake VLM exercise is already running')
    }

    let failedCount = 0
    let notApplicableCount = 0
    let conditionTotal = 0
    let conditionCorrect = 0
    let caseStatusCorrect = 0
    for (const candidateCase of state.cases) {
      const caseConditions = state.conditions.filter((item) => item.caseId === candidateCase.id)
      try {
        const request = await this.buildFakeRequest(
          candidateCase,
          caseConditions,
          selectCurrentEvidence(state.evidence),
        )
        const result = await runVlmCandidateReview(this.provider, request)
        if (result.status === 'review_failed') failedCount += 1
        if (result.status === 'review_not_applicable') notApplicableCount += 1
        const outputConditions = result.output?.conditions ?? []
        for (const output of outputConditions) {
          const human = caseConditions.find((item) => item.conditionId === output.condition_id)
          conditionTotal += 1
          if (human && resolvedVerdict(human) === output.verdict) conditionCorrect += 1
        }
        const humanStatus = deriveVlmReviewStatus(
          caseConditions.map((condition) => ({
            kind: condition.kind as 'must_have' | 'optional' | 'exclusion',
            verdict: resolvedVerdict(condition)!,
          })),
        )
        if (result.status === humanStatus) caseStatusCorrect += 1
        await this.db.insert(evaluationVlmBlindFakeResults).values({
          id: randomUUID(),
          fakeRunId,
          caseId: candidateCase.id,
          status: result.status,
          outputJson: result.output,
          errorJson: result.error,
        })
      } catch {
        failedCount += 1
        await this.db.insert(evaluationVlmBlindFakeResults).values({
          id: randomUUID(),
          fakeRunId,
          caseId: candidateCase.id,
          status: 'review_failed',
          errorJson: { code: 'VLM_FAKE_REQUEST_INVALID' },
        })
      }
    }
    const succeededCount = state.cases.length - failedCount - notApplicableCount
    await this.db
      .update(evaluationVlmBlindFakeRuns)
      .set({
        status: failedCount === 0 ? 'succeeded' : 'completed_with_errors',
        succeededCount,
        failedCount,
        notApplicableCount,
        externalCallCount: 0,
        metricsJson: {
          condition_total: conditionTotal,
          condition_correct: conditionCorrect,
          condition_accuracy: conditionTotal === 0 ? null : conditionCorrect / conditionTotal,
          case_total: state.cases.length,
          case_status_correct: caseStatusCorrect,
          case_status_accuracy:
            state.cases.length === 0 ? null : caseStatusCorrect / state.cases.length,
        },
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(evaluationVlmBlindFakeRuns.id, fakeRunId))
    return this.get(datasetId)
  }

  private async ensureSession(datasetId: string) {
    await this.db
      .insert(evaluationVlmBlindLabelingSessions)
      .values({ id: randomUUID(), datasetId })
      .onConflictDoNothing()
  }

  private assertCandidatePoolFrozen(status: string) {
    if (status !== 'frozen') {
      throw new ConflictException('candidate pool must be frozen before condition labeling')
    }
  }

  private async loadState(datasetId: string, db = this.db, lockSession = false) {
    const [dataset] = await db
      .select()
      .from(evaluationVlmBlindDatasets)
      .where(eq(evaluationVlmBlindDatasets.id, datasetId))
      .limit(1)
    if (!dataset) throw new NotFoundException('VLM blind dataset not found')
    const allCases = await db
      .select()
      .from(evaluationVlmBlindCases)
      .where(eq(evaluationVlmBlindCases.datasetId, datasetId))
      .orderBy(asc(evaluationVlmBlindCases.proposalId))
    const replacedIds = new Set(
      allCases.flatMap((item) => (item.replacesCaseId ? [item.replacesCaseId] : [])),
    )
    const cases = allCases.filter((item) => !replacedIds.has(item.id))
    const caseIds = cases.map((item) => item.id)
    const candidateIds = cases.map((item) => item.sourceCandidateId)
    const conditions = caseIds.length
      ? await db
          .select()
          .from(evaluationVlmBlindConditions)
          .where(inArray(evaluationVlmBlindConditions.caseId, caseIds))
          .orderBy(
            asc(evaluationVlmBlindConditions.caseId),
            asc(evaluationVlmBlindConditions.ordinal),
          )
      : []
    let sessionQuery = db
      .select()
      .from(evaluationVlmBlindLabelingSessions)
      .where(eq(evaluationVlmBlindLabelingSessions.datasetId, datasetId))
      .limit(1)
    if (lockSession) sessionQuery = sessionQuery.for('update') as typeof sessionQuery
    const [session] = await sessionQuery
    const evidence = candidateIds.length
      ? await db
          .select()
          .from(candidateEvidence)
          .where(
            and(
              eq(candidateEvidence.sourceType, 'evaluation_candidate'),
              inArray(candidateEvidence.sourceId, candidateIds),
              eq(candidateEvidence.strategy, 'all_indexed_frames_v1'),
              eq(candidateEvidence.protocolVersion, 'candidate-evidence-v1'),
            ),
          )
      : []
    const [fakeRun] = session
      ? await db
          .select()
          .from(evaluationVlmBlindFakeRuns)
          .where(eq(evaluationVlmBlindFakeRuns.labelingSessionId, session.id))
          .limit(1)
      : []
    const fakeResults = fakeRun
      ? await db
          .select()
          .from(evaluationVlmBlindFakeResults)
          .where(eq(evaluationVlmBlindFakeResults.fakeRunId, fakeRun.id))
          .orderBy(asc(evaluationVlmBlindFakeResults.createdAt))
      : []
    return { dataset, cases, conditions, session, evidence, fakeRun, fakeResults }
  }

  private toResponse(state: Awaited<ReturnType<VlmBlindLabelingService['loadState']>>) {
    const currentEvidence = selectCurrentEvidence(state.evidence)
    const evidenceByCandidate = new Map(currentEvidence.map((item) => [item.sourceId, item]))
    const evidenceCounts = countValues(currentEvidence.map((item) => item.status))
    const resolvedCount = state.conditions.filter((item) => resolvedVerdict(item) !== null).length
    const adjudicationRequired = state.conditions.filter(needsAdjudication).length
    const labelsStatus = deriveLabelingStatus(state)
    return {
      dataset_id: state.dataset.id,
      candidate_status: state.dataset.status,
      session_id: state.session?.id ?? null,
      labels_status: labelsStatus,
      labels_fingerprint: state.session?.labelsFingerprint ?? null,
      labels_frozen_at: state.session?.labelsFrozenAt?.toISOString() ?? null,
      evidence_summary: {
        total: state.cases.length,
        missing: state.cases.length - currentEvidence.length,
        queued: evidenceCounts.get('queued') ?? 0,
        running:
          (evidenceCounts.get('running') ?? 0) + (evidenceCounts.get('cancel_requested') ?? 0),
        succeeded: evidenceCounts.get('succeeded') ?? 0,
        failed: (evidenceCounts.get('failed') ?? 0) + (evidenceCounts.get('cancelled') ?? 0),
      },
      label_progress: {
        total: state.conditions.length,
        first: state.conditions.filter((item) => item.firstVerdict !== null).length,
        second: state.conditions.filter((item) => item.secondVerdict !== null).length,
        adjudication_required: adjudicationRequired,
        final: state.conditions.filter((item) => item.finalVerdict !== null).length,
        resolved: resolvedCount,
      },
      cases: state.cases.map((candidateCase) => {
        const evidence = evidenceByCandidate.get(candidateCase.sourceCandidateId)
        return {
          id: candidateCase.id,
          proposal_id: candidateCase.proposalId,
          source_evaluation_run_id: candidateCase.sourceEvaluationRunId,
          source_candidate_id: candidateCase.sourceCandidateId,
          query_text: candidateCase.queryText,
          candidate_key: candidateCase.candidateKey,
          file_id: candidateCase.fileId,
          scene_id: candidateCase.sceneId,
          start_time_seconds: Number(candidateCase.startTimeSeconds),
          end_time_seconds: Number(candidateCase.endTimeSeconds),
          evidence: evidence
            ? {
                id: evidence.id,
                status: evidence.status,
                frame_count: readFrameCount(evidence.manifestJson),
                error: evidence.errorCode
                  ? { code: evidence.errorCode, message: evidence.errorMessage }
                  : null,
              }
            : null,
          conditions: state.conditions
            .filter((item) => item.caseId === candidateCase.id)
            .map((condition) => ({
              id: condition.id,
              condition_id: condition.conditionId,
              kind: condition.kind,
              source_text: condition.sourceText,
              first: condition.firstVerdict,
              second: condition.secondVerdict,
              final: condition.finalVerdict,
              needs_adjudication: needsAdjudication(condition),
              resolved: resolvedVerdict(condition),
            })),
        }
      }),
      fake_report: state.fakeRun
        ? {
            id: state.fakeRun.id,
            status: state.fakeRun.status,
            provider: state.fakeRun.provider,
            protocol_version: state.fakeRun.protocolVersion,
            case_count: state.fakeRun.caseCount,
            succeeded_count: state.fakeRun.succeededCount,
            failed_count: state.fakeRun.failedCount,
            not_applicable_count: state.fakeRun.notApplicableCount,
            external_call_count: state.fakeRun.externalCallCount,
            metrics: state.fakeRun.metricsJson,
            results: state.fakeResults.map((item) => ({
              case_id: item.caseId,
              status: item.status,
              output: item.outputJson,
              error: item.errorJson,
            })),
          }
        : null,
    }
  }

  private async buildFakeRequest(
    candidateCase: typeof evaluationVlmBlindCases.$inferSelect,
    conditions: ConditionRow[],
    evidenceRows: Array<typeof candidateEvidence.$inferSelect>,
  ) {
    const evidence = evidenceRows.find(
      (item) => item.sourceId === candidateCase.sourceCandidateId && item.status === 'succeeded',
    )
    if (!evidence?.artifactPath || !evidence.artifactSha256) {
      throw new Error('successful all_indexed_frames_v1 evidence is missing')
    }
    const manifestBytes = await readFile(evidence.artifactPath)
    if (createHash('sha256').update(manifestBytes).digest('hex') !== evidence.artifactSha256) {
      throw new Error('evidence manifest fingerprint mismatch')
    }
    const manifest = bundleManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
    if (
      manifest.candidate_key !== candidateCase.candidateKey ||
      manifest.file_id !== candidateCase.fileId ||
      manifest.scene_id !== candidateCase.sceneId
    ) {
      throw new Error('evidence manifest identity mismatch')
    }
    const bundleRoot = resolve(dirname(evidence.artifactPath))
    const evidenceFrames = []
    for (const frame of manifest.frames) {
      const framePath = resolve(bundleRoot, frame.relative_path)
      if (!framePath.startsWith(`${bundleRoot}${sep}`)) {
        throw new Error('evidence frame path escapes the frozen bundle')
      }
      const bytes = await readFile(framePath)
      if (createHash('sha256').update(bytes).digest('hex') !== frame.frame_sha256) {
        throw new Error('evidence frame fingerprint mismatch')
      }
      evidenceFrames.push({ frame_id: frame.asset_id, image_base64: bytes.toString('base64') })
    }
    return vlmCandidateReviewRequestSchema.parse({
      protocol_version: 'vlm-review-v1',
      model: 'qwen3.7-plus',
      original_query: candidateCase.queryText,
      candidate_key: candidateCase.candidateKey,
      conditions: conditions.map((condition) => ({
        condition_id: condition.conditionId,
        kind: condition.kind,
        source_text: condition.sourceText,
      })),
      evidence_frames: evidenceFrames,
    })
  }
}

function needsAdjudication(condition: ConditionRow) {
  return (
    condition.firstVerdict !== null &&
    condition.secondVerdict !== null &&
    (condition.firstVerdict !== condition.secondVerdict ||
      condition.firstVerdict === 'uncertain' ||
      condition.secondVerdict === 'uncertain')
  )
}

function resolvedVerdict(condition: ConditionRow): Verdict | null {
  if (needsAdjudication(condition)) {
    return condition.finalVerdict === 'yes' || condition.finalVerdict === 'no'
      ? condition.finalVerdict
      : null
  }
  if (
    condition.firstVerdict !== null &&
    condition.firstVerdict === condition.secondVerdict &&
    (condition.firstVerdict === 'yes' || condition.firstVerdict === 'no')
  ) {
    return condition.firstVerdict
  }
  return null
}

function allEvidenceSucceeded(state: {
  cases: Array<unknown>
  evidence: Array<typeof candidateEvidence.$inferSelect>
}) {
  const current = selectCurrentEvidence(state.evidence)
  return (
    current.length === state.cases.length && current.every((item) => item.status === 'succeeded')
  )
}

function deriveLabelingStatus(state: {
  cases: Array<unknown>
  conditions: ConditionRow[]
  evidence: Array<typeof candidateEvidence.$inferSelect>
  session?: { status: string } | undefined
}) {
  if (state.session?.status === 'labels_frozen') return 'labels_frozen'
  if (!state.session) return 'evidence_pending'
  if (!allEvidenceSucceeded(state)) {
    if (state.evidence.some((item) => item.status === 'failed' || item.status === 'cancelled')) {
      return 'evidence_failed'
    }
    return 'evidence_preparing'
  }
  if (state.conditions.some((item) => item.firstVerdict === null)) return 'first_pass'
  if (state.conditions.some((item) => item.secondVerdict === null)) return 'second_pass'
  if (state.conditions.some((item) => resolvedVerdict(item) === null)) return 'adjudication'
  return 'ready_to_freeze'
}

/**
 * 同一冻结 Evaluation candidate 过去可能为旧 generation 留下证据行。标签流程每个
 * candidate 只观察一个当前行，优先成功结果，再按更新时间选择最新状态；否则历史行会把
 * 60 个候选误算成 61 个证据并永久阻塞一审。
 */
function selectCurrentEvidence(rows: Array<typeof candidateEvidence.$inferSelect>) {
  const selected = new Map<string, typeof candidateEvidence.$inferSelect>()
  for (const row of rows) {
    const current = selected.get(row.sourceId)
    if (
      !current ||
      (current.status !== 'succeeded' && row.status === 'succeeded') ||
      (current.status === row.status && row.updatedAt > current.updatedAt)
    ) {
      selected.set(row.sourceId, row)
    }
  }
  return [...selected.values()]
}

function countValues(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function readFrameCount(value: unknown) {
  if (!value || typeof value !== 'object' || !('frame_count' in value)) return null
  return typeof value.frame_count === 'number' ? value.frame_count : null
}
