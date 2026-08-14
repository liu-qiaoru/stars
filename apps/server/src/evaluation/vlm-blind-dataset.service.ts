import { createHash, randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  vlmBlindCandidateReviewInputSchema,
  vlmBlindCandidateReviewPacketSchema,
} from '@local-media-agent/shared/schemas'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  planAcceptedGroupRebalance,
  selectDiversePendingCandidates,
  type VlmBlindSelectionGroup,
} from './vlm-blind-candidate-diversity.js'
import {
  evaluationCandidates,
  evaluationQueries,
  evaluationRuns,
  evaluationVlmBlindCases,
  evaluationVlmBlindConditions,
  evaluationVlmBlindDatasets,
  mediaAssets,
  vectorRefs,
} from '../database/schema.js'

type CandidatePacket = z.infer<typeof vlmBlindCandidateReviewPacketSchema>

/**
 * Phase F 数据集服务只管理本地人工事实：导入候选建议、校验其来自已报告的
 * Evaluation 快照，并记录用户审核。它不读 Qdrant、不抽帧、不调用 Provider，
 * 也不产生 VLM 的 passed/rejected 结论。
 */
@Injectable()
export class VlmBlindDatasetService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * 导入一份固定 60 对的建议包。所有身份校验与三张表写入位于同一事务，
   * 任何一对被改写都整体拒绝，避免留下半份可审核数据。
   */
  async importCandidateReviewPacket(input: { name: string; packet: unknown }) {
    const name = input.name.trim()
    if (name.length === 0 || name.length > 200) {
      throw new BadRequestException('dataset name must contain 1 to 200 characters')
    }
    const packet = vlmBlindCandidateReviewPacketSchema.parse(input.packet)
    const fingerprint = fingerprintPacket(packet)
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      await this.assertFrozenCandidateIdentities(packet, db)
      const datasetId = randomUUID()
      const inserted = await db
        .insert(evaluationVlmBlindDatasets)
        .values({
          id: datasetId,
          name,
          schemaVersion: packet.schema_version,
          status: 'candidate_review',
          targetCaseCount: 60,
          proposalFingerprint: fingerprint,
        })
        // 当前 Drizzle/PGlite 共同支持的无参数形式会捕获该 INSERT 的唯一约束冲突。
        // id 是新生成的 UUID，因此正常重复请求只可能命中内容指纹唯一索引。
        .onConflictDoNothing()
        .returning()
      if (inserted.length === 0) {
        const [existing] = await db
          .select({ id: evaluationVlmBlindDatasets.id })
          .from(evaluationVlmBlindDatasets)
          .where(eq(evaluationVlmBlindDatasets.proposalFingerprint, fingerprint))
          .limit(1)
        if (!existing) {
          throw new ConflictException('candidate review import lost its idempotent identity')
        }
        return this.get(existing.id, db)
      }
      for (const proposal of packet.proposals) {
        const caseId = randomUUID()
        await db.insert(evaluationVlmBlindCases).values({
          id: caseId,
          datasetId,
          proposalId: proposal.proposal_id,
          sourceEvaluationRunId: proposal.source_evaluation_run_id,
          sourceCandidateId: proposal.source_candidate_id,
          queryText: proposal.query_text,
          candidateKey: proposal.candidate_key,
          fileId: proposal.file_id,
          sceneId: proposal.scene_id,
          startTimeSeconds: String(proposal.start_time_seconds),
          endTimeSeconds: String(proposal.end_time_seconds),
          proposedGroup: proposal.proposed_group,
          selectionBasis: proposal.selection_basis,
        })
        await db.insert(evaluationVlmBlindConditions).values(
          proposal.conditions.map((condition, ordinal) => ({
            id: randomUUID(),
            caseId,
            conditionId: condition.condition_id,
            kind: condition.kind,
            sourceText: condition.source_text,
            ordinal,
          })),
        )
      }
      return this.get(datasetId, db)
    })
  }

  async list() {
    return this.db
      .select({
        id: evaluationVlmBlindDatasets.id,
        name: evaluationVlmBlindDatasets.name,
        status: evaluationVlmBlindDatasets.status,
        proposal_fingerprint: evaluationVlmBlindDatasets.proposalFingerprint,
        created_at: evaluationVlmBlindDatasets.createdAt,
      })
      .from(evaluationVlmBlindDatasets)
      .orderBy(asc(evaluationVlmBlindDatasets.createdAt))
  }

  async get(datasetId: string, db: Database = this.db) {
    const [dataset] = await db
      .select()
      .from(evaluationVlmBlindDatasets)
      .where(eq(evaluationVlmBlindDatasets.id, datasetId))
    if (!dataset) throw new NotFoundException('VLM blind dataset not found')
    const cases = await db
      .select()
      .from(evaluationVlmBlindCases)
      .where(eq(evaluationVlmBlindCases.datasetId, datasetId))
      .orderBy(asc(evaluationVlmBlindCases.proposalId))
    const conditions =
      cases.length === 0
        ? []
        : await db
            .select()
            .from(evaluationVlmBlindConditions)
            .where(
              inArray(
                evaluationVlmBlindConditions.caseId,
                cases.map((item) => item.id),
              ),
            )
            .orderBy(asc(evaluationVlmBlindConditions.ordinal))
    const replacedCaseIds = new Set(
      cases.flatMap((item) => (item.replacesCaseId ? [item.replacesCaseId] : [])),
    )
    const responseCases = cases.map((item) => {
      const caseConditions = conditions.filter((condition) => condition.caseId === item.id)
      return {
        id: item.id,
        replaces_case_id: item.replacesCaseId,
        is_active: !replacedCaseIds.has(item.id),
        proposal_id: item.proposalId,
        source_evaluation_run_id: item.sourceEvaluationRunId,
        source_candidate_id: item.sourceCandidateId,
        query_text: item.queryText,
        candidate_key: item.candidateKey,
        file_id: item.fileId,
        scene_id: item.sceneId,
        start_time_seconds: Number(item.startTimeSeconds),
        end_time_seconds: Number(item.endTimeSeconds),
        proposed_group: item.proposedGroup,
        reviewed_group: item.reviewedGroup,
        review_status: item.reviewStatus,
        selection_basis: item.selectionBasis,
        review_notes: item.reviewNotes,
        conditions: caseConditions.map((condition) => ({
          condition_id: condition.conditionId,
          kind: condition.kind,
          source_text: condition.sourceText,
        })),
        human_labels: caseConditions.flatMap((condition) =>
          condition.finalVerdict
            ? [{ condition_id: condition.conditionId, verdict: condition.finalVerdict }]
            : [],
        ),
      }
    })
    return {
      id: dataset.id,
      name: dataset.name,
      schema_version: dataset.schemaVersion,
      status: dataset.status,
      proposal_fingerprint: dataset.proposalFingerprint,
      frozen_fingerprint: dataset.frozenFingerprint,
      summary: {
        pending: responseCases.filter((item) => item.is_active && item.review_status === 'pending')
          .length,
        accepted: responseCases.filter(
          (item) => item.is_active && item.review_status === 'accepted',
        ).length,
        rejected: responseCases.filter(
          (item) => item.is_active && item.review_status === 'rejected',
        ).length,
        historical_rejected: responseCases.filter(
          (item) => !item.is_active && item.review_status === 'rejected',
        ).length,
        historical_accepted: responseCases.filter(
          (item) => !item.is_active && item.review_status === 'accepted',
        ).length,
      },
      cases: responseCases,
    }
  }

  /**
   * 丢弃所有曾被人工拒绝的查询文本，并为仍使用这些文本的有效叶子创建新 pending 行。
   * 新行必须来自未拒绝的冻结查询；旧 rejected/accepted/pending 行都保留为只读审计。
   * 整个批次在一个事务中生成，任一槽位无法替代时全部回滚，也不重搜或调用 Provider。
   */
  async generateRejectedReplacements(datasetId: string, additionalSourceRunId?: string) {
    const sourceRunId = additionalSourceRunId
      ? z.string().uuid().parse(additionalSourceRunId)
      : undefined
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [dataset] = await db
        .select()
        .from(evaluationVlmBlindDatasets)
        .where(eq(evaluationVlmBlindDatasets.id, datasetId))
        .for('update')
      if (!dataset) throw new NotFoundException('VLM blind dataset not found')
      if (dataset.status !== 'candidate_review') {
        throw new ConflictException('candidate review is already closed')
      }
      if (sourceRunId) {
        const [sourceRun] = await db
          .select({ status: evaluationRuns.status })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, sourceRunId))
        if (
          !sourceRun ||
          !['ready_for_labeling', 'labeled', 'reported'].includes(sourceRun.status)
        ) {
          throw new ConflictException('replacement source Evaluation run is not complete')
        }
      }
      const cases = await db
        .select()
        .from(evaluationVlmBlindCases)
        .where(eq(evaluationVlmBlindCases.datasetId, datasetId))
        .orderBy(asc(evaluationVlmBlindCases.proposalId))
        .for('update')
      const replacedIds = new Set(
        cases.flatMap((item) => (item.replacesCaseId ? [item.replacesCaseId] : [])),
      )
      const rejectedQueryTexts = new Set(
        cases.filter((item) => item.reviewStatus === 'rejected').map((item) => item.queryText),
      )
      const activeCases = cases.filter((item) => !replacedIds.has(item.id))
      const discardedQueryLeaves = activeCases.filter((item) =>
        rejectedQueryTexts.has(item.queryText),
      )
      if (discardedQueryLeaves.length === 0) return this.get(datasetId, db)

      const candidates = await loadFrozenVideoCandidates(db, [
        ...cases.map((item) => item.sourceEvaluationRunId),
        ...(sourceRunId ? [sourceRunId] : []),
      ])
      const usedCandidateIds = new Set(cases.map((item) => item.sourceCandidateId))
      const candidateById = new Map(candidates.map((item) => [item.id, item]))
      let choices: ReturnType<typeof selectDiversePendingCandidates>
      try {
        choices = selectDiversePendingCandidates({
          slots: discardedQueryLeaves.map((item) => ({
            proposalId: item.proposalId,
            group: (item.reviewedGroup ?? item.proposedGroup) as VlmBlindSelectionGroup,
          })),
          candidates: candidates
            .filter((item) => !rejectedQueryTexts.has(item.queryText))
            .map((item) => ({
              candidateId: item.id,
              queryText: item.queryText,
              eligibleGroups: selectionGroups.filter((group) => isEligibleReplacement(group, item)),
              stableOrder: createHash('sha256')
                .update(`${item.queryText}:${item.id}`)
                .digest('hex'),
            })),
          reviewedCandidateIds: usedCandidateIds,
          reviewedQueryTexts: activeCases
            .filter((item) => !rejectedQueryTexts.has(item.queryText))
            .map((item) => item.queryText),
          minimumUniqueQueries: Math.min(50, activeCases.length),
          maxPairsPerQuery: 2,
        })
      } catch {
        // 选择器错误可能携带内部槽位；对外只报告数量，避免暴露查询或媒体语义。
        throw new ConflictException(
          `discarded query replacements have no complete frozen assignment for ${discardedQueryLeaves.length} cases`,
        )
      }

      for (const discarded of discardedQueryLeaves) {
        const selected = choices.get(discarded.proposalId)
        const choice = selected ? candidateById.get(selected.candidateId) : undefined
        if (!choice) {
          throw new ConflictException(
            `discarded proposal ${discarded.proposalId} lost its planned frozen replacement`,
          )
        }
        const replacementId = randomUUID()
        await db.insert(evaluationVlmBlindCases).values({
          id: replacementId,
          datasetId,
          proposalId: nextReplacementProposalId(discarded.proposalId),
          replacesCaseId: discarded.id,
          sourceEvaluationRunId: choice.runId,
          sourceCandidateId: choice.id,
          queryText: choice.queryText,
          candidateKey: choice.candidateKey,
          fileId: choice.fileId,
          sceneId: choice.sceneId!,
          startTimeSeconds: choice.startTimeSeconds!,
          endTimeSeconds: choice.endTimeSeconds!,
          proposedGroup: (discarded.reviewedGroup ??
            discarded.proposedGroup) as VlmBlindSelectionGroup,
          selectionBasis: `本地查询丢弃替代：被拒绝的查询文本永久退出盲测池，改用未拒绝冻结查询下的未审核候选；需重新人工播放确认。`,
        })
        await db.insert(evaluationVlmBlindConditions).values(
          conditionsFromFrozenQuery(choice).map((condition, ordinal) => ({
            id: randomUUID(),
            caseId: replacementId,
            conditionId: condition.condition_id,
            kind: condition.kind,
            sourceText: condition.source_text,
            ordinal,
          })),
        )
      }
      return this.get(datasetId, db)
    })
  }

  /**
   * 将人工最终分组再平衡为五组各 12 条。超过配额的 accepted 叶子保持只读，
   * 新增 pending 后继补入缺额组；用户仍需逐条播放确认这些新候选。
   */
  async rebalanceAcceptedGroups(datasetId: string) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [dataset] = await db
        .select()
        .from(evaluationVlmBlindDatasets)
        .where(eq(evaluationVlmBlindDatasets.id, datasetId))
        .for('update')
      if (!dataset) throw new NotFoundException('VLM blind dataset not found')
      if (dataset.status !== 'candidate_review') {
        throw new ConflictException('candidate review is already closed')
      }
      const cases = await db
        .select()
        .from(evaluationVlmBlindCases)
        .where(eq(evaluationVlmBlindCases.datasetId, datasetId))
        .orderBy(asc(evaluationVlmBlindCases.proposalId))
        .for('update')
      const replacedIds = new Set(
        cases.flatMap((item) => (item.replacesCaseId ? [item.replacesCaseId] : [])),
      )
      const active = cases.filter((item) => !replacedIds.has(item.id))
      const rejectedQueryTexts = new Set(
        cases.filter((item) => item.reviewStatus === 'rejected').map((item) => item.queryText),
      )
      if (active.some((item) => rejectedQueryTexts.has(item.queryText))) {
        throw new ConflictException('discard rejected query texts before group rebalance')
      }
      if (active.some((item) => item.reviewStatus !== 'accepted' || !item.reviewedGroup)) {
        throw new ConflictException('all active candidate cases must be accepted before rebalance')
      }
      const candidates = await loadFrozenVideoCandidates(
        db,
        active.map((item) => item.sourceEvaluationRunId),
      )
      const candidateById = new Map(candidates.map((item) => [item.id, item]))
      const usedCandidateIds = new Set(cases.map((item) => item.sourceCandidateId))
      const plan = planAcceptedGroupRebalance({
        targetPerGroup: 12,
        parents: active.map((item) => {
          const source = candidateById.get(item.sourceCandidateId)
          if (!source)
            throw new ConflictException(
              `proposal ${item.proposalId} lost its frozen source candidate`,
            )
          return {
            caseId: item.id,
            currentGroup: item.reviewedGroup as VlmBlindSelectionGroup,
            runId: item.sourceEvaluationRunId,
            queryId: source.queryId,
          }
        }),
        candidates: candidates
          .filter(
            (item) => !usedCandidateIds.has(item.id) && !rejectedQueryTexts.has(item.queryText),
          )
          .map((item) => ({
            candidateId: item.id,
            runId: item.runId,
            queryId: item.queryId,
            eligibleGroups: selectionGroups.filter((group) => isEligibleReplacement(group, item)),
            stableOrder: createHash('sha256').update(`${item.queryId}:${item.id}`).digest('hex'),
          })),
      })
      for (const item of plan) {
        const parent = active.find((entry) => entry.id === item.parentCaseId)!
        const choice = candidateById.get(item.candidateId)!
        const replacementId = randomUUID()
        await db.insert(evaluationVlmBlindCases).values({
          id: replacementId,
          datasetId,
          proposalId: nextReplacementProposalId(parent.proposalId),
          replacesCaseId: parent.id,
          sourceEvaluationRunId: choice.runId,
          sourceCandidateId: choice.id,
          queryText: choice.queryText,
          candidateKey: choice.candidateKey,
          fileId: choice.fileId,
          sceneId: choice.sceneId!,
          startTimeSeconds: choice.startTimeSeconds!,
          endTimeSeconds: choice.endTimeSeconds!,
          proposedGroup: item.targetGroup,
          selectionBasis: `本地配额再平衡建议：保留已接受前代审计，使用同一冻结查询的未审核候选补足目标分组；需重新人工确认。`,
        })
        await db.insert(evaluationVlmBlindConditions).values(
          conditionsFromFrozenQuery(choice).map((condition, ordinal) => ({
            id: randomUUID(),
            caseId: replacementId,
            conditionId: condition.condition_id,
            kind: condition.kind,
            sourceText: condition.source_text,
            ordinal,
          })),
        )
      }
      return this.get(datasetId, db)
    })
  }

  /**
   * 冻结最终 60 对人工候选。事务会重新验证叶子身份、人工状态、查询多样性、五组配额、
   * 拒绝文本排除和条件完整性，再对规范化快照计算 SHA-256。重复冻结只读返回同一指纹；
   * 冻结后所有审核、替代和再平衡入口都会因 dataset 状态关闭而拒绝写入。
   */
  async freezeCandidateReview(datasetId: string) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [dataset] = await db
        .select()
        .from(evaluationVlmBlindDatasets)
        .where(eq(evaluationVlmBlindDatasets.id, datasetId))
        .for('update')
      if (!dataset) throw new NotFoundException('VLM blind dataset not found')
      if (dataset.status === 'frozen') {
        if (!dataset.frozenFingerprint || !dataset.frozenAt) {
          throw new ConflictException('frozen candidate review is missing its audit identity')
        }
        return this.get(datasetId, db)
      }
      if (dataset.status !== 'candidate_review') {
        throw new ConflictException('candidate review cannot be frozen from its current status')
      }

      const cases = await db
        .select()
        .from(evaluationVlmBlindCases)
        .where(eq(evaluationVlmBlindCases.datasetId, datasetId))
        .orderBy(asc(evaluationVlmBlindCases.proposalId))
        .for('update')
      const replacedIds = new Set(
        cases.flatMap((item) => (item.replacesCaseId ? [item.replacesCaseId] : [])),
      )
      const active = cases.filter((item) => !replacedIds.has(item.id))
      if (active.length !== dataset.targetCaseCount) {
        throw new ConflictException('candidate review must contain exactly 60 active cases')
      }
      if (active.some((item) => item.reviewStatus !== 'accepted' || !item.reviewedGroup)) {
        throw new ConflictException('all active candidate cases must be accepted before freeze')
      }
      if (new Set(active.map((item) => item.sourceCandidateId)).size !== active.length) {
        throw new ConflictException('active candidate identities must be unique before freeze')
      }
      const rejectedQueryTexts = new Set(
        cases.filter((item) => item.reviewStatus === 'rejected').map((item) => item.queryText),
      )
      if (active.some((item) => rejectedQueryTexts.has(item.queryText))) {
        throw new ConflictException('rejected query text remains active before freeze')
      }
      const queryCounts = countValues(active.map((item) => item.queryText))
      if (queryCounts.size < 50 || [...queryCounts.values()].some((count) => count > 2)) {
        throw new ConflictException('candidate query diversity is incomplete before freeze')
      }
      const groupCounts = countValues(
        active.map((item) => item.reviewedGroup as VlmBlindSelectionGroup),
      )
      if (selectionGroups.some((group) => groupCounts.get(group) !== 12)) {
        throw new ConflictException('candidate review groups must contain exactly 12 cases each')
      }

      const activeIds = active.map((item) => item.id)
      const conditions = await db
        .select()
        .from(evaluationVlmBlindConditions)
        .where(inArray(evaluationVlmBlindConditions.caseId, activeIds))
        .orderBy(
          asc(evaluationVlmBlindConditions.caseId),
          asc(evaluationVlmBlindConditions.ordinal),
        )
      if (active.some((item) => !conditions.some((condition) => condition.caseId === item.id))) {
        throw new ConflictException(
          'active candidate condition snapshot is incomplete before freeze',
        )
      }

      // 指纹覆盖进入盲测的完整本地事实，但 API 只返回哈希，不暴露查询、条件或媒体内容。
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            schema_version: dataset.schemaVersion,
            cases: active.map((item) => ({
              proposal_id: item.proposalId,
              source_evaluation_run_id: item.sourceEvaluationRunId,
              source_candidate_id: item.sourceCandidateId,
              query_text: item.queryText,
              candidate_key: item.candidateKey,
              file_id: item.fileId,
              scene_id: item.sceneId,
              start_time_seconds: item.startTimeSeconds,
              end_time_seconds: item.endTimeSeconds,
              reviewed_group: item.reviewedGroup,
              conditions: conditions
                .filter((condition) => condition.caseId === item.id)
                .map((condition) => ({
                  condition_id: condition.conditionId,
                  kind: condition.kind,
                  source_text: condition.sourceText,
                })),
            })),
          }),
        )
        .digest('hex')
      await db
        .update(evaluationVlmBlindDatasets)
        .set({
          status: 'frozen',
          frozenFingerprint: fingerprint,
          frozenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationVlmBlindDatasets.id, datasetId))
      return this.get(datasetId, db)
    })
  }

  /** 记录候选是否适合进入人工标注；这不是对条件的 yes/no/uncertain 真值。 */
  async reviewCandidate(datasetId: string, caseId: string, input: unknown) {
    const review = vlmBlindCandidateReviewInputSchema.parse(input)
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [dataset] = await db
        .select()
        .from(evaluationVlmBlindDatasets)
        .where(eq(evaluationVlmBlindDatasets.id, datasetId))
        .for('update')
      if (!dataset) throw new NotFoundException('VLM blind dataset not found')
      if (dataset.status !== 'candidate_review') {
        throw new ConflictException('candidate review is already closed')
      }
      const [candidateCase] = await db
        .select({ id: evaluationVlmBlindCases.id })
        .from(evaluationVlmBlindCases)
        .where(
          and(
            eq(evaluationVlmBlindCases.id, caseId),
            eq(evaluationVlmBlindCases.datasetId, datasetId),
          ),
        )
      if (!candidateCase) throw new NotFoundException('VLM blind candidate case not found')
      const [successor] = await db
        .select({ id: evaluationVlmBlindCases.id })
        .from(evaluationVlmBlindCases)
        .where(eq(evaluationVlmBlindCases.replacesCaseId, caseId))
        .limit(1)
      if (successor) {
        throw new ConflictException('superseded candidate case is read-only')
      }
      await db
        .update(evaluationVlmBlindCases)
        .set({
          reviewStatus: review.decision,
          reviewedGroup: review.decision === 'accepted' ? review.reviewed_group! : null,
          reviewNotes: review.notes ?? null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationVlmBlindCases.id, caseId))
      return this.get(datasetId, db)
    })
  }

  private async assertFrozenCandidateIdentities(packet: CandidatePacket, db: Database) {
    const rows = await db
      .select({
        candidateId: evaluationCandidates.id,
        runId: evaluationCandidates.runId,
        candidateKey: evaluationCandidates.candidateKey,
        fileId: evaluationCandidates.fileId,
        sceneId: evaluationCandidates.sceneId,
        startTimeSeconds: evaluationCandidates.startTimeSeconds,
        endTimeSeconds: evaluationCandidates.endTimeSeconds,
        queryText: evaluationQueries.queryText,
        mustHave: evaluationQueries.mustHaveJson,
        optional: evaluationQueries.optionalJson,
        exclusions: evaluationQueries.exclusionsJson,
        runStatus: evaluationRuns.status,
      })
      .from(evaluationCandidates)
      .innerJoin(evaluationQueries, eq(evaluationCandidates.queryId, evaluationQueries.id))
      .innerJoin(evaluationRuns, eq(evaluationCandidates.runId, evaluationRuns.id))
      .where(
        inArray(
          evaluationCandidates.id,
          packet.proposals.map((proposal) => proposal.source_candidate_id),
        ),
      )
    const byId = new Map(rows.map((row) => [row.candidateId, row]))
    for (const proposal of packet.proposals) {
      const row = byId.get(proposal.source_candidate_id)
      const expectedConditions = [
        ...asTextArray(row?.mustHave, 'must_have_json').map((source_text, index) => ({
          condition_id: `must-${index + 1}`,
          kind: 'must_have',
          source_text,
        })),
        ...asTextArray(row?.optional, 'optional_json').map((source_text, index) => ({
          condition_id: `optional-${index + 1}`,
          kind: 'optional',
          source_text,
        })),
        ...asTextArray(row?.exclusions, 'exclusions_json').map((source_text, index) => ({
          condition_id: `exclusion-${index + 1}`,
          kind: 'exclusion',
          source_text,
        })),
      ]
      if (
        !row ||
        // Phase F 首先审核“哪些候选值得标注”。ready_for_labeling 已表示
        // 全部查询的召回快照在同一事务中完整写入；要求 reported 会造成
        // 必须先完成无关的检索等级标注，形成死循环。failed/retrieving 仍严格拒绝。
        !['ready_for_labeling', 'labeled', 'reported'].includes(row.runStatus) ||
        row.runId !== proposal.source_evaluation_run_id ||
        row.candidateKey !== proposal.candidate_key ||
        row.fileId !== proposal.file_id ||
        row.sceneId !== proposal.scene_id ||
        Number(row.startTimeSeconds) !== proposal.start_time_seconds ||
        Number(row.endTimeSeconds) !== proposal.end_time_seconds ||
        row.queryText !== proposal.query_text ||
        JSON.stringify(expectedConditions) !== JSON.stringify(proposal.conditions)
      ) {
        throw new BadRequestException(
          `proposal ${proposal.proposal_id} identity does not match the frozen Evaluation candidate`,
        )
      }
    }
  }
}

function asTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    // 冻结条件是 Phase F 请求的事实来源。把损坏 JSON 当作空数组会同时让生成器
    // 和导入校验漏掉条件，因此必须显式拒绝；错误只暴露字段名，不回显用户文本。
    throw new BadRequestException(`frozen ${field} must be a string array`)
  }
  return value
}

function fingerprintPacket(packet: CandidatePacket) {
  return createHash('sha256').update(JSON.stringify(packet)).digest('hex')
}

type ReplacementCandidate = {
  rrfRank: number | null
  currentRank: number | null
  startTimeSeconds: string | null
  endTimeSeconds: string | null
  exclusions: unknown
  mustHave: unknown
  optional: unknown
  frameCount: number
}

const selectionGroups: VlmBlindSelectionGroup[] = [
  'exact_match',
  'missing_must_have',
  'exclusion_hit',
  'partial_relevance',
  'insufficient_evidence',
]

async function loadFrozenVideoCandidates(db: Database, runIds: string[]) {
  return db
    .select({
      id: evaluationCandidates.id,
      queryId: evaluationCandidates.queryId,
      runId: evaluationCandidates.runId,
      candidateKey: evaluationCandidates.candidateKey,
      fileId: evaluationCandidates.fileId,
      sceneId: evaluationCandidates.sceneId,
      startTimeSeconds: evaluationCandidates.startTimeSeconds,
      endTimeSeconds: evaluationCandidates.endTimeSeconds,
      rrfRank: evaluationCandidates.rrfRank,
      currentRank: evaluationCandidates.currentRank,
      queryText: evaluationQueries.queryText,
      mustHave: evaluationQueries.mustHaveJson,
      optional: evaluationQueries.optionalJson,
      exclusions: evaluationQueries.exclusionsJson,
      frameCount: sql<number>`(select count(distinct ${vectorRefs.id}) from ${mediaAssets}
        join ${vectorRefs} on ${vectorRefs.assetId} = ${mediaAssets.id}
        where ${mediaAssets.sceneId} = ${evaluationCandidates.sceneId}
          and ${mediaAssets.assetType} = 'video_frame'
          and ${vectorRefs.collectionName} = 'video_frame_vectors'
          and ${vectorRefs.status} = 'indexed')`,
    })
    .from(evaluationCandidates)
    .innerJoin(evaluationQueries, eq(evaluationCandidates.queryId, evaluationQueries.id))
    .where(
      and(
        inArray(evaluationCandidates.runId, [...new Set(runIds)]),
        eq(evaluationCandidates.primaryPool, true),
        eq(evaluationCandidates.mediaType, 'video'),
      ),
    )
}

function isEligibleReplacement(group: string, candidate: ReplacementCandidate) {
  const rank = candidate.rrfRank ?? candidate.currentRank ?? Number.MAX_SAFE_INTEGER
  const duration = Number(candidate.endTimeSeconds) - Number(candidate.startTimeSeconds)
  if (group === 'exact_match') return rank <= 4
  if (group === 'partial_relevance') return rank >= 5 && rank <= 10
  if (group === 'insufficient_evidence') return Number(candidate.frameCount) <= 2 || duration <= 2
  if (group === 'exclusion_hit') {
    return asTextArray(candidate.exclusions, 'exclusions_json').length > 0 && rank >= 8
  }
  return rank >= 8
}

function conditionsFromFrozenQuery(candidate: ReplacementCandidate) {
  return [
    ...asTextArray(candidate.mustHave, 'must_have_json').map((source_text, index) => ({
      condition_id: `must-${index + 1}`,
      kind: 'must_have' as const,
      source_text,
    })),
    ...asTextArray(candidate.optional, 'optional_json').map((source_text, index) => ({
      condition_id: `optional-${index + 1}`,
      kind: 'optional' as const,
      source_text,
    })),
    ...asTextArray(candidate.exclusions, 'exclusions_json').map((source_text, index) => ({
      condition_id: `exclusion-${index + 1}`,
      kind: 'exclusion' as const,
      source_text,
    })),
  ]
}

/** 统计冻结校验所需的离散值数量；调用方只使用数量，不把查询正文写入错误。 */
function countValues(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function nextReplacementProposalId(proposalId: string) {
  const match = proposalId.match(/^(.*)-replacement-(\d+)$/)
  return match ? `${match[1]}-replacement-${Number(match[2]) + 1}` : `${proposalId}-replacement-1`
}
