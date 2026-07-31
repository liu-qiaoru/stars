import { createHash, randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  evaluationCandidates,
  evaluationJudgments,
  evaluationQueries,
  evaluationRuns,
  evaluationSets,
  evaluationVersions,
  mediaAssets,
  mediaFiles,
  vectorRefs,
  videoScenes,
} from '../database/schema.js'
import { calculateRankingMetrics } from '../ranking/metrics.js'
import { SearchService } from '../search/search.service.js'

const querySchema = z.object({
  query_text: z.string().trim().min(1),
  query_type: z.enum(['known_target', 'discovery']),
  intent_category: z.string().trim().min(1),
  must_have: z.array(z.string().trim().min(1)).min(1),
  optional: z.array(z.string().trim().min(1)).default([]),
  exclusions: z.array(z.string().trim().min(1)).default([]),
  target_file_id: z.string().uuid().nullable().default(null),
  target_scene_id: z.string().uuid().nullable().default(null),
})

type SearchItem = {
  asset_id: string
  file_id: string
  media_type: string
  scene_id?: string | null
  start_time_seconds: number | null
  end_time_seconds: number | null
  reasons?: string[]
  source_scores?: Record<string, number>
  ranking_diagnostics?: {
    source_ranks: Record<string, number>
    rrf_contributions: Record<string, number>
    primary_signal: string
  }
  best_frame_time_seconds?: number | null
}

/** 候选进入当前排序或 RRF（Reciprocal Rank Fusion，倒数排名融合）任一前 20 名时返回 true。 */
function isTop20Candidate(currentRank: number | null, rrfRank: number | null) {
  return [currentRank, rrfRank].some((rank) => rank !== null && rank >= 1 && rank <= 20)
}

/**
 * 判断候选是否需要人工相关性标注。
 *
 * 自然发现指标最深只读取前 20 名，因此进入当前排序或倒数排名融合任一前 20 名的候选
 * 需要标注。指定目标只比较冻结目标的唯一标识和名次，无论名次如何都不读人工等级。
 */
export function requiresCandidateJudgment(
  queryType: string | undefined,
  currentRank: number | null,
  rrfRank: number | null,
) {
  if (queryType !== 'discovery') return false
  return isTop20Candidate(currentRank, rrfRank)
}

@Injectable()
export class EvaluationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SearchService) private readonly searchService: SearchService,
  ) {}

  async createSet(input: { name: string; description?: string }) {
    const name = z.string().trim().min(1).parse(input.name)
    const setId = randomUUID()
    const versionId = randomUUID()
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [set] = await db
        .insert(evaluationSets)
        .values({
          id: setId,
          name,
          description: input.description?.trim() || null,
        })
        .returning()
      await db.insert(evaluationVersions).values({ id: versionId, setId, version: 1 })
      return { ...this.setResponse(set!), version_id: versionId, version: 1, status: 'draft' }
    })
  }

  async listSets() {
    const sets = await this.db.select().from(evaluationSets).orderBy(asc(evaluationSets.createdAt))
    const items = await Promise.all(
      sets.map(async (set) => {
        const versions = await this.db
          .select()
          .from(evaluationVersions)
          .where(eq(evaluationVersions.setId, set.id))
          .orderBy(asc(evaluationVersions.version))
        const latest = versions.at(-1)
        return {
          ...this.setResponse(set),
          latest_version: latest ? this.versionResponse(latest) : null,
        }
      }),
    )
    return { items }
  }

  async getVersion(id: string) {
    const [version] = await this.db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, id))
    if (!version) throw new NotFoundException('evaluation version not found')
    const queries = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, id))
      .orderBy(asc(evaluationQueries.createdAt))
    return {
      ...this.versionResponse(version),
      queries: queries.map((row) => this.queryResponse(row)),
    }
  }

  async addQuery(versionId: string, input: unknown) {
    const parsed = querySchema.parse(input)
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      await this.requireDraft(versionId, db, true)
      if (parsed.query_type === 'known_target' && !parsed.target_file_id) {
        throw new BadRequestException('known_target query requires target_file_id')
      }
      if (parsed.query_type === 'discovery' && (parsed.target_file_id || parsed.target_scene_id)) {
        throw new BadRequestException('discovery query cannot define a target')
      }
      let targetAssetId: string | null = null
      if (parsed.target_file_id) {
        const [file] = await db
          .select({ id: mediaFiles.id, mediaType: mediaFiles.mediaType })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.id, parsed.target_file_id), isNull(mediaFiles.deletedAt)))
        if (!file) throw new BadRequestException('target media file is unavailable')
        if (file.mediaType === 'video' && !parsed.target_scene_id) {
          throw new BadRequestException('known_target video query requires target_scene_id')
        }
        if (file.mediaType !== 'video' && parsed.target_scene_id) {
          throw new BadRequestException('only video targets can define target_scene_id')
        }
        if (file.mediaType === 'image') {
          const [asset] = await db
            .select({ id: mediaAssets.id })
            .from(mediaAssets)
            .where(and(eq(mediaAssets.fileId, file.id), eq(mediaAssets.assetType, 'image')))
          if (!asset) throw new BadRequestException('target image asset is unavailable')
          targetAssetId = asset.id
        }
      }
      if (parsed.target_scene_id) {
        const [scene] = await db
          .select({ id: videoScenes.id })
          .from(videoScenes)
          .innerJoin(mediaFiles, eq(videoScenes.fileId, mediaFiles.id))
          .where(
            and(
              eq(videoScenes.id, parsed.target_scene_id),
              eq(videoScenes.fileId, parsed.target_file_id!),
              eq(videoScenes.indexGeneration, mediaFiles.indexGeneration),
              isNull(mediaFiles.deletedAt),
            ),
          )
        if (!scene)
          throw new BadRequestException('target scene is not a current scene of target file')
      }
      const [row] = await db
        .insert(evaluationQueries)
        .values({
          id: randomUUID(),
          versionId,
          queryText: parsed.query_text,
          queryType: parsed.query_type,
          intentCategory: parsed.intent_category,
          mustHaveJson: parsed.must_have,
          optionalJson: parsed.optional,
          exclusionsJson: parsed.exclusions,
          targetFileId: parsed.target_file_id,
          targetSceneId: parsed.target_scene_id,
          targetAssetId,
        })
        .returning()
      return this.queryResponse(row!)
    })
  }

  async freezeVersion(id: string) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      await this.requireDraft(id, db, true)
      const queries = await db
        .select({ id: evaluationQueries.id })
        .from(evaluationQueries)
        .where(eq(evaluationQueries.versionId, id))
      if (!queries.length)
        throw new BadRequestException('cannot freeze an empty evaluation version')
      const [row] = await db
        .update(evaluationVersions)
        .set({ status: 'frozen', frozenAt: new Date(), updatedAt: new Date() })
        .where(eq(evaluationVersions.id, id))
        .returning()
      return this.versionResponse(row!)
    })
  }

  /**
   * 单次调用正式 SearchService 取得一份来源快照，再保存 current 与 RRF 两种名次；
   * 评测层不复制 Qdrant 查询、场景折叠或 RRF 公式。
   */
  async startRun(versionId: string, input: { library_ids?: string[] }) {
    const [version] = await this.db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, versionId))
    if (!version) throw new NotFoundException('evaluation version not found')
    if (version.status !== 'frozen')
      throw new ConflictException('evaluation version must be frozen')
    const libraryIds = z.array(z.string().uuid()).default([]).parse(input.library_ids)
    const runId = randomUUID()
    await this.db.insert(evaluationRuns).values({
      id: runId,
      versionId,
      status: 'retrieving',
      libraryIdsJson: libraryIds,
      configJson: {
        search_scope: 'all',
        query_expansion_mode: 'original',
        source_depth: 20,
        rrf_k: 60,
      },
    })
    try {
      // 一次运行的全部查询候选和成功状态原子提交。外部检索失败或进程抛错时事务回滚，
      // 不会暴露“部分查询已有候选、状态仍 retrieving”的伪基线。
      await this.db.transaction(async (transaction) => {
        const db = transaction as Database
        const queries = await db
          .select()
          .from(evaluationQueries)
          .where(eq(evaluationQueries.versionId, versionId))
          .orderBy(asc(evaluationQueries.createdAt))
        for (const query of queries) {
          await this.validateFrozenTarget(db, query)
          await this.snapshotQuery(db, runId, query, libraryIds)
        }
        // 自然发现需要人工分级相关性；指定目标只比较冻结目标唯一标识与候选名次。
        // 若整个版本只有指定目标，召回完成后可直接生成报告。
        const requiresHumanLabeling = queries.some((query) => query.queryType === 'discovery')
        await db
          .update(evaluationRuns)
          .set({
            status: requiresHumanLabeling ? 'ready_for_labeling' : 'labeled',
            updatedAt: new Date(),
          })
          .where(eq(evaluationRuns.id, runId))
      })
    } catch (error) {
      // 候选事务已经整体回滚；这里只把事务外预先创建的 run 标成 failed，保留错误审计。
      await this.db
        .update(evaluationRuns)
        .set({
          status: 'failed',
          errorCode: 'EVALUATION_RETRIEVAL_INCOMPLETE',
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationRuns.id, runId))
    }
    return this.getRun(runId)
  }

  private async snapshotQuery(
    db: Database,
    runId: string,
    query: typeof evaluationQueries.$inferSelect,
    libraryIds: string[],
  ) {
    const base = {
      query: query.queryText,
      media_types: [],
      library_ids: libraryIds,
      limit: 20,
      offset: 0,
      query_expansion_mode: 'original' as const,
      include_diagnostics: true,
      search_scope: 'all' as const,
    }
    const result = await this.searchService.searchForEvaluation(base, 20)
    for (const required of [
      'image_vectors',
      'video_frame_vectors',
      'caption_text_vectors',
      'text_search',
    ]) {
      if (!result.groups.some((group) => group.collection === required)) {
        throw new Error(`required evaluation source is unavailable source=${required}`)
      }
    }
    const currentResults = result.comparison_results.current as SearchItem[]
    const fullRrfResults = result.comparison_results.full_rrf as SearchItem[]
    const currentRank = new Map(
      currentResults.map((item, index) => [this.candidateKey(item), index + 1]),
    )
    const union = new Map<string, SearchItem>()
    for (const item of [...currentResults, ...fullRrfResults])
      union.set(this.candidateKey(item), item)
    const fileIds = [...new Set([...union.values()].map((item) => item.file_id))]
    const files = fileIds.length
      ? await db
          .select({ id: mediaFiles.id, generation: mediaFiles.indexGeneration })
          .from(mediaFiles)
          .where(and(inArray(mediaFiles.id, fileIds), isNull(mediaFiles.deletedAt)))
      : []
    const generationByFile = new Map(files.map((file) => [file.id, file.generation]))
    if (generationByFile.size !== fileIds.length)
      throw new Error('candidate file generation is unavailable')
    const sceneIds = [
      ...new Set([...union.values()].flatMap((item) => (item.scene_id ? [item.scene_id] : []))),
    ]
    if (sceneIds.length) {
      const scenes = await db
        .select({
          id: videoScenes.id,
          fileId: videoScenes.fileId,
          generation: videoScenes.indexGeneration,
        })
        .from(videoScenes)
        .where(inArray(videoScenes.id, sceneIds))
      if (
        scenes.length !== sceneIds.length ||
        scenes.some((scene) => generationByFile.get(scene.fileId) !== scene.generation)
      ) {
        throw new Error('candidate scene generation does not match the current file generation')
      }
    }
    const rrfRank = new Map(
      fullRrfResults.map((item, index) => [this.candidateKey(item), index + 1]),
    )
    const snapshotItems = [
      ...fullRrfResults,
      ...currentResults.filter((item) => !rrfRank.has(this.candidateKey(item))),
    ]
    const blindItems = [...snapshotItems].sort((left, right) =>
      this.seedKey(`${runId}:${query.id}`, this.candidateKey(left)).localeCompare(
        this.seedKey(`${runId}:${query.id}`, this.candidateKey(right)),
      ),
    )
    const values = blindItems.map((item, index) => {
      const key = this.candidateKey(item)
      return {
        id: randomUUID(),
        runId,
        queryId: query.id,
        candidateKey: key,
        assetId: item.asset_id,
        fileId: item.file_id,
        sceneId: item.scene_id ?? null,
        fileGeneration: generationByFile.get(item.file_id)!,
        mediaType: item.media_type,
        startTimeSeconds: item.start_time_seconds?.toString() ?? null,
        endTimeSeconds: item.end_time_seconds?.toString() ?? null,
        sourceEvidenceJson: {
          reasons: item.reasons ?? [],
          source_scores: item.source_scores ?? {},
          source_ranks: item.ranking_diagnostics?.source_ranks ?? {},
          rrf_contributions: item.ranking_diagnostics?.rrf_contributions ?? {},
          best_frame_time_seconds: item.best_frame_time_seconds ?? null,
        },
        currentRank: currentRank.get(key) ?? null,
        rrfRank: rrfRank.get(key) ?? null,
        blindOrder: index + 1,
        // current 比较列表可能携带 Top-20 之外的诊断项；快照保留它们，
        // 但只把进入任一排序 Top-20 的候选列为正式指标池。
        primaryPool: isTop20Candidate(currentRank.get(key) ?? null, rrfRank.get(key) ?? null),
      }
    })
    if (values.length) await db.insert(evaluationCandidates).values(values)
  }

  async getRun(id: string, revealEvidence = false, db: Database = this.db) {
    const [run] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, id))
    if (!run) throw new NotFoundException('evaluation run not found')
    const rows = await db
      .select()
      .from(evaluationCandidates)
      .where(eq(evaluationCandidates.runId, id))
      .orderBy(asc(evaluationCandidates.blindOrder))
    const judgments = rows.length
      ? await db
          .select()
          .from(evaluationJudgments)
          .where(
            inArray(
              evaluationJudgments.candidateId,
              rows.map((row) => row.id),
            ),
          )
      : []
    const queryRows = rows.length
      ? await db
          .select({
            id: evaluationQueries.id,
            queryText: evaluationQueries.queryText,
            queryType: evaluationQueries.queryType,
          })
          .from(evaluationQueries)
          .where(inArray(evaluationQueries.id, [...new Set(rows.map((row) => row.queryId))]))
      : []
    const queryTextById = new Map(queryRows.map((row) => [row.id, row.queryText]))
    const queryTypeById = new Map(queryRows.map((row) => [row.id, row.queryType]))
    const byCandidate = new Map(judgments.map((row) => [row.candidateId, row]))
    // 只有自然发现查询的前 K 条准确率和分级排序指标依赖人工相关等级。指定目标直接使用
    // 冻结目标唯一标识与名次，不应阻塞证据揭示或要求无意义的人工标注。
    const allJudged = rows.every(
      (row) =>
        !requiresCandidateJudgment(
          queryTypeById.get(row.queryId),
          row.currentRank,
          row.rrfRank,
        ) || byCandidate.has(row.id),
    )
    if (revealEvidence && !allJudged) {
      throw new ConflictException(
        'source evidence remains hidden until primary labeling is complete',
      )
    }
    return {
      id: run.id,
      version_id: run.versionId,
      status: run.status,
      config: run.configJson,
      report: run.reportJson,
      error_code: run.errorCode,
      error_message: run.errorMessage,
      candidates: rows.map((row) => {
        const judgment = byCandidate.get(row.id)
        return {
          id: row.id,
          query_id: row.queryId,
          query_text: queryTextById.get(row.queryId) ?? '',
          requires_judgment: requiresCandidateJudgment(
            queryTypeById.get(row.queryId),
            row.currentRank,
            row.rrfRank,
          ),
          candidate_key: row.candidateKey,
          file_id: row.fileId,
          scene_id: row.sceneId,
          media_type: row.mediaType,
          start_time_seconds: row.startTimeSeconds === null ? null : Number(row.startTimeSeconds),
          end_time_seconds: row.endTimeSeconds === null ? null : Number(row.endTimeSeconds),
          judgment: judgment
            ? {
                relevance: judgment.relevance,
                unjudgeable: judgment.unjudgeable,
                diagnosis: judgment.diagnosisJson,
                notes: judgment.notes,
              }
            : null,
          ...(revealEvidence
            ? {
                file_generation: row.fileGeneration,
                source_evidence: row.sourceEvidenceJson,
                current_rank: row.currentRank,
                rrf_rank: row.rrfRank,
              }
            : {}),
        }
      }),
    }
  }

  async saveJudgment(
    runId: string,
    candidateId: string,
    input: { relevance?: number; unjudgeable?: boolean; diagnosis?: unknown; notes?: string },
  ) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [run] = await db
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.id, runId))
        .for('update')
      if (!run) throw new NotFoundException('evaluation run not found')
      if (run.status !== 'ready_for_labeling' && run.status !== 'labeled') {
        throw new ConflictException('judgments are immutable after the run is finalized or failed')
      }
      const [candidate] = await db
        .select()
        .from(evaluationCandidates)
        .where(and(eq(evaluationCandidates.id, candidateId), eq(evaluationCandidates.runId, runId)))
      if (!candidate) throw new NotFoundException('evaluation candidate not found')
      const relevance = input.unjudgeable
        ? null
        : z.number().int().min(0).max(2).parse(input.relevance)
      const values = {
        relevance,
        unjudgeable: Boolean(input.unjudgeable),
        diagnosisJson: input.diagnosis ?? null,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      }
      const [existing] = await db
        .select()
        .from(evaluationJudgments)
        .where(eq(evaluationJudgments.candidateId, candidateId))
      if (existing) {
        await db
          .update(evaluationJudgments)
          .set(values)
          .where(eq(evaluationJudgments.id, existing.id))
      } else {
        await db.insert(evaluationJudgments).values({ id: randomUUID(), candidateId, ...values })
      }
      await db
        .update(evaluationCandidates)
        .set({ labelStatus: 'judged' })
        .where(eq(evaluationCandidates.id, candidateId))
      const runCandidates = await db
        .select({
          labelStatus: evaluationCandidates.labelStatus,
          queryType: evaluationQueries.queryType,
          currentRank: evaluationCandidates.currentRank,
          rrfRank: evaluationCandidates.rrfRank,
        })
        .from(evaluationCandidates)
        .innerJoin(evaluationQueries, eq(evaluationCandidates.queryId, evaluationQueries.id))
        .where(eq(evaluationCandidates.runId, runId))
      const requiredCandidates = runCandidates.filter((row) =>
        requiresCandidateJudgment(row.queryType, row.currentRank, row.rrfRank),
      )
      if (
        requiredCandidates.length > 0 &&
        requiredCandidates.every((row) => row.labelStatus === 'judged')
      ) {
        await db
          .update(evaluationRuns)
          .set({ status: 'labeled', updatedAt: new Date() })
          .where(eq(evaluationRuns.id, runId))
      }
      return this.getRun(runId, false, db)
    })
  }

  async finalizeRun(runId: string) {
    return this.db.transaction(async (transaction) => {
      const db = transaction as Database
      const [lockedRun] = await db
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.id, runId))
        .for('update')
      if (!lockedRun) throw new NotFoundException('evaluation run not found')
      const blind = await this.getRun(runId, false, db)
      if (blind.status !== 'ready_for_labeling' && blind.status !== 'labeled') {
        throw new ConflictException('run is not ready')
      }
      if (
        blind.candidates.some(
          (candidate) => candidate.requires_judgment && !candidate.judgment,
        )
      ) {
        throw new ConflictException('all discovery candidates must be judged')
      }
      const revealed = await this.getRun(runId, true, db)
      const queries = await db
        .select()
        .from(evaluationQueries)
        .where(eq(evaluationQueries.versionId, lockedRun.versionId))
      const reports = queries.map((query) => {
        const candidates = revealed.candidates.filter(
          (candidate) => candidate.query_id === query.id,
        )
        // 指定目标指标不读人工等级；即使旧运行已经误标了部分候选，也传空 Map，避免
        // “无法判断”数量让人误以为它影响前 K 名命中率或平均倒数排名。
        const judgments = new Map<string, 0 | 1 | 2 | null>(
          query.queryType === 'discovery'
            ? candidates.flatMap((candidate) =>
                // 共同理想分母只能读取协议规定的两种排序前 20 名并集。更早阶段多标的
                // 诊断候选继续留库审计，但不能让正式分数依赖用户偶然多标了多少条。
                candidate.requires_judgment && candidate.judgment
                  ? [
                      [
                        candidate.candidate_key,
                        candidate.judgment.unjudgeable
                          ? null
                          : (candidate.judgment.relevance as 0 | 1 | 2),
                      ] as [string, 0 | 1 | 2 | null],
                    ]
                  : [],
              )
            : [],
        )
        const target = query.targetSceneId ?? query.targetAssetId
        const options = { knownTargetKey: target }
        return {
          query_id: query.id,
          current: calculateRankingMetrics(
            [...candidates]
              .filter((item) => item.current_rank !== null)
              .sort(
                (a, b) =>
                  (a.current_rank ?? Number.MAX_SAFE_INTEGER) -
                  (b.current_rank ?? Number.MAX_SAFE_INTEGER),
              )
              .map((item) => item.candidate_key),
            judgments,
            options,
          ),
          rrf: calculateRankingMetrics(
            [...candidates]
              .filter(
                (item) =>
                  item.rrf_rank !== null && item.rrf_rank !== undefined && item.rrf_rank <= 20,
              )
              .sort(
                (a, b) =>
                  (a.rrf_rank ?? Number.MAX_SAFE_INTEGER) - (b.rrf_rank ?? Number.MAX_SAFE_INTEGER),
              )
              .map((item) => item.candidate_key),
            judgments,
            options,
          ),
        }
      })
      const report = { queries: reports, generated_at: new Date().toISOString() }
      await db
        .update(evaluationRuns)
        .set({
          status: 'reported',
          reportJson: report,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationRuns.id, runId))
      return this.getRun(runId, true, db)
    })
  }

  async randomTargets(input: { libraryId?: string; limit: number; seed: string }) {
    const limit = z.number().int().min(1).max(20).parse(input.limit)
    const libraryFilter = input.libraryId
      ? eq(mediaFiles.libraryId, z.string().uuid().parse(input.libraryId))
      : undefined
    const imageRows = await this.db
      .select({
        fileId: mediaFiles.id,
        relativePath: mediaFiles.relativePath,
        mediaType: mediaFiles.mediaType,
      })
      .from(mediaFiles)
      .innerJoin(
        mediaAssets,
        and(eq(mediaAssets.fileId, mediaFiles.id), eq(mediaAssets.assetType, 'image')),
      )
      .innerJoin(
        vectorRefs,
        and(
          eq(vectorRefs.assetId, mediaAssets.id),
          eq(vectorRefs.collectionName, 'image_vectors'),
          eq(vectorRefs.status, 'indexed'),
        ),
      )
      .where(and(isNull(mediaFiles.deletedAt), libraryFilter))
    const sceneRows = await this.db
      .select({
        fileId: mediaFiles.id,
        relativePath: mediaFiles.relativePath,
        mediaType: mediaFiles.mediaType,
        sceneId: videoScenes.id,
        start: videoScenes.startTimeSeconds,
        end: videoScenes.endTimeSeconds,
      })
      .from(videoScenes)
      .innerJoin(mediaFiles, eq(videoScenes.fileId, mediaFiles.id))
      .innerJoin(
        mediaAssets,
        and(eq(mediaAssets.sceneId, videoScenes.id), eq(mediaAssets.assetType, 'video_frame')),
      )
      .innerJoin(
        vectorRefs,
        and(
          eq(vectorRefs.assetId, mediaAssets.id),
          eq(vectorRefs.collectionName, 'video_frame_vectors'),
          eq(vectorRefs.status, 'indexed'),
        ),
      )
      .where(
        and(
          isNull(mediaFiles.deletedAt),
          eq(videoScenes.indexGeneration, mediaFiles.indexGeneration),
          libraryFilter,
        ),
      )
    const seenVideos = new Set<string>()
    const targets = [
      ...imageRows.map((row) => ({ ...row, sceneId: null, start: null, end: null })),
      ...sceneRows
        .sort((a, b) =>
          this.seedKey(input.seed, a.sceneId).localeCompare(this.seedKey(input.seed, b.sceneId)),
        )
        .filter((row) => !seenVideos.has(row.fileId) && Boolean(seenVideos.add(row.fileId))),
    ]
      .sort((a, b) =>
        this.seedKey(input.seed, a.sceneId ?? a.fileId).localeCompare(
          this.seedKey(input.seed, b.sceneId ?? b.fileId),
        ),
      )
      .slice(0, limit)
      .map((row) => ({
        file_id: row.fileId,
        scene_id: row.sceneId,
        media_type: row.mediaType,
        relative_path: row.relativePath,
        start_time_seconds: row.start === null ? null : Number(row.start),
        end_time_seconds: row.end === null ? null : Number(row.end),
      }))
    return { items: targets }
  }

  private candidateKey(item: SearchItem) {
    // 与生产倒数排名融合的语义身份一致：视频按正式场景唯一标识合并；图片和转录文本
    // 按媒体资产唯一标识合并，避免同一业务对象重复占据结果位置。
    return item.scene_id ?? item.asset_id
  }
  private async validateFrozenTarget(db: Database, query: typeof evaluationQueries.$inferSelect) {
    if (query.targetSceneId) {
      const [scene] = await db
        .select({ id: videoScenes.id })
        .from(videoScenes)
        .innerJoin(mediaFiles, eq(videoScenes.fileId, mediaFiles.id))
        .where(
          and(
            eq(videoScenes.id, query.targetSceneId),
            eq(videoScenes.fileId, query.targetFileId!),
            eq(videoScenes.indexGeneration, mediaFiles.indexGeneration),
            isNull(mediaFiles.deletedAt),
          ),
        )
      if (!scene) throw new Error('frozen target scene generation is no longer current')
    }
    if (query.targetAssetId) {
      const [asset] = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .innerJoin(mediaFiles, eq(mediaAssets.fileId, mediaFiles.id))
        .where(
          and(
            eq(mediaAssets.id, query.targetAssetId),
            eq(mediaAssets.fileId, query.targetFileId!),
            eq(mediaAssets.assetType, 'image'),
            isNull(mediaFiles.deletedAt),
          ),
        )
      if (!asset) throw new Error('frozen target image asset is no longer available')
    }
  }
  private seedKey(seed: string, identity: string) {
    return createHash('sha256').update(`${seed}:${identity}`).digest('hex')
  }
  private async requireDraft(id: string, db: Database = this.db, lock = false) {
    const query = db.select().from(evaluationVersions).where(eq(evaluationVersions.id, id))
    const [version] = lock ? await query.for('update') : await query
    if (!version) throw new NotFoundException('evaluation version not found')
    if (version.status !== 'draft') throw new ConflictException('evaluation version is frozen')
    return version
  }
  private setResponse(row: typeof evaluationSets.$inferSelect) {
    return { id: row.id, name: row.name, description: row.description }
  }
  private versionResponse(row: typeof evaluationVersions.$inferSelect) {
    return {
      id: row.id,
      set_id: row.setId,
      version: row.version,
      status: row.status,
      frozen_at: row.frozenAt?.toISOString() ?? null,
    }
  }
  private queryResponse(row: typeof evaluationQueries.$inferSelect) {
    return {
      id: row.id,
      version_id: row.versionId,
      query_text: row.queryText,
      query_type: row.queryType,
      intent_category: row.intentCategory,
      must_have: row.mustHaveJson,
      optional: row.optionalJson,
      exclusions: row.exclusionsJson,
      target_file_id: row.targetFileId,
      target_scene_id: row.targetSceneId,
      target_asset_id: row.targetAssetId,
    }
  }
}
