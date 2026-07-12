import { createHash, randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
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
} from '../database/schema.js'
import { SearchService } from '../search/search.service.js'
import { calculateRankingMetrics, rankByRrf, type EvaluationSignal } from './evaluation-metrics.js'

const queryInputSchema = z.object({
  query_text: z.string().trim().min(1),
  query_type: z.enum(['known_target', 'discovery']),
  intent_category: z.string().trim().min(1),
  must_have: z.array(z.string().trim().min(1)).min(1),
  optional: z.array(z.string().trim().min(1)).default([]),
  exclusions: z.array(z.string().trim().min(1)).default([]),
  target_file_id: z.string().uuid().nullable().default(null),
  target_scene_id: z.string().trim().min(1).nullable().default(null),
})

type SourceEvidence = {
  collection: string
  signal: EvaluationSignal
  rank: number
  raw_score: number
  asset_id: string
}

@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name)

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SearchService) private readonly searchService: SearchService,
  ) {}

  async createSet(input: { name: string; description?: string }) {
    const name = z.string().trim().min(1).parse(input.name)
    const setId = randomUUID()
    const versionId = randomUUID()
    const [set] = await this.db
      .insert(evaluationSets)
      .values({
        id: setId,
        name,
        description: input.description?.trim() || null,
      })
      .returning()
    await this.db.insert(evaluationVersions).values({ id: versionId, setId, version: 1 })
    return { ...set, version_id: versionId, version: 1, status: 'draft' }
  }

  async listSets() {
    const rows = await this.db.select().from(evaluationSets).orderBy(asc(evaluationSets.createdAt))
    const items = await Promise.all(
      rows.map(async (row) => {
        const versions = await this.db
          .select()
          .from(evaluationVersions)
          .where(eq(evaluationVersions.setId, row.id))
          .orderBy(asc(evaluationVersions.version))
        const latest = versions.at(-1)
        return {
          ...this.setResponse(row),
          latest_version: latest ? this.versionResponse(latest) : null,
        }
      }),
    )
    return { items }
  }

  async getVersion(versionId: string) {
    const [version] = await this.db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, versionId))
    if (!version) throw new NotFoundException('evaluation version not found')
    const queries = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, versionId))
      .orderBy(asc(evaluationQueries.createdAt))
    return {
      ...this.versionResponse(version),
      queries: queries.map((row) => this.queryResponse(row)),
    }
  }

  async createVersion(setId: string) {
    const [set] = await this.db.select().from(evaluationSets).where(eq(evaluationSets.id, setId))
    if (!set) throw new NotFoundException('evaluation set not found')
    const versions = await this.db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.setId, setId))
      .orderBy(asc(evaluationVersions.version))
    const latest = versions.at(-1)
    if (!latest) throw new Error(`evaluation set has no version set_id=${setId}`)
    const nextId = randomUUID()
    await this.db
      .insert(evaluationVersions)
      .values({ id: nextId, setId, version: latest.version + 1 })
    const previousQueries = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, latest.id))
    if (previousQueries.length) {
      await this.db.insert(evaluationQueries).values(
        previousQueries.map((query) => ({
          id: randomUUID(),
          versionId: nextId,
          queryText: query.queryText,
          queryType: query.queryType,
          intentCategory: query.intentCategory,
          mustHaveJson: query.mustHaveJson,
          optionalJson: query.optionalJson,
          exclusionsJson: query.exclusionsJson,
          targetFileId: query.targetFileId,
          targetSceneId: query.targetSceneId,
        })),
      )
    }
    return this.getVersion(nextId)
  }

  async addQuery(versionId: string, input: unknown) {
    const parsed = queryInputSchema.parse(input)
    const version = await this.requireDraftVersion(versionId)
    if (parsed.query_type === 'known_target' && !parsed.target_file_id) {
      throw new BadRequestException('known_target query requires target_file_id')
    }
    if (parsed.query_type === 'discovery' && (parsed.target_file_id || parsed.target_scene_id)) {
      throw new BadRequestException('discovery query cannot define a target')
    }
    if (parsed.target_file_id) {
      const [target] = await this.db
        .select({ id: mediaFiles.id })
        .from(mediaFiles)
        .where(and(eq(mediaFiles.id, parsed.target_file_id), sql`${mediaFiles.deletedAt} is null`))
      if (!target) throw new BadRequestException('target media file is unavailable')
      if (parsed.target_scene_id) {
        const [scene] = await this.db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.fileId, parsed.target_file_id),
              eq(mediaAssets.assetType, 'video_segment'),
              sql`${mediaAssets.metadataJson}->>'scene_id' = ${parsed.target_scene_id}`,
            ),
          )
        if (!scene)
          throw new BadRequestException('target scene does not belong to target media file')
      }
    }
    const [row] = await this.db
      .insert(evaluationQueries)
      .values({
        id: randomUUID(),
        versionId: version.id,
        queryText: parsed.query_text,
        queryType: parsed.query_type,
        intentCategory: parsed.intent_category,
        mustHaveJson: parsed.must_have,
        optionalJson: parsed.optional,
        exclusionsJson: parsed.exclusions,
        targetFileId: parsed.target_file_id,
        targetSceneId: parsed.target_scene_id,
      })
      .returning()
    return this.queryResponse(row)
  }

  async updateQuery(versionId: string, queryId: string, input: unknown) {
    const parsed = queryInputSchema.parse(input)
    await this.requireDraftVersion(versionId)
    const [existing] = await this.db
      .select()
      .from(evaluationQueries)
      .where(and(eq(evaluationQueries.id, queryId), eq(evaluationQueries.versionId, versionId)))
    if (!existing) throw new NotFoundException('evaluation query not found')
    if (parsed.query_type === 'known_target' && !parsed.target_file_id)
      throw new BadRequestException('known_target query requires target_file_id')
    const [row] = await this.db
      .update(evaluationQueries)
      .set({
        queryText: parsed.query_text,
        queryType: parsed.query_type,
        intentCategory: parsed.intent_category,
        mustHaveJson: parsed.must_have,
        optionalJson: parsed.optional,
        exclusionsJson: parsed.exclusions,
        targetFileId: parsed.target_file_id,
        targetSceneId: parsed.target_scene_id,
        updatedAt: new Date(),
      })
      .where(eq(evaluationQueries.id, queryId))
      .returning()
    return this.queryResponse(row!)
  }

  async listRuns(versionId?: string) {
    const rows = await this.db
      .select()
      .from(evaluationRuns)
      .where(versionId ? eq(evaluationRuns.versionId, versionId) : undefined)
      .orderBy(asc(evaluationRuns.createdAt))
    return {
      items: rows.map((run) => ({
        id: run.id,
        version_id: run.versionId,
        status: run.status,
        error_stage: run.errorStage,
        error_message: run.errorMessage,
        created_at: run.createdAt.toISOString(),
      })),
    }
  }

  async freezeVersion(versionId: string) {
    await this.requireDraftVersion(versionId)
    const [queryTotal] = await this.db
      .select({ value: count() })
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, versionId))
    if (!queryTotal || queryTotal.value === 0)
      throw new BadRequestException('cannot freeze an empty evaluation version')
    const [row] = await this.db
      .update(evaluationVersions)
      .set({ status: 'frozen', frozenAt: new Date(), updatedAt: new Date() })
      .where(eq(evaluationVersions.id, versionId))
      .returning()
    return this.versionResponse(row!)
  }

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
    const config = {
      query_expansion: false,
      video_segment_vectors: false,
      source_depth: 20,
      rrf_k: 60,
      source_weights: { visual: 1, caption: 1, lexical: 1 },
    }
    await this.db.insert(evaluationRuns).values({
      id: runId,
      versionId,
      status: 'retrieving',
      libraryIdsJson: libraryIds,
      configJson: config,
    })
    try {
      await this.executeRun(runId, versionId, libraryIds)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.db
        .update(evaluationRuns)
        .set({
          status: 'failed',
          errorStage: 'retrieving',
          errorMessage: message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationRuns.id, runId))
      this.logger.error(`evaluation_run_failed run_id=${runId} stage=retrieving error=${message}`)
      throw error
    }
    return this.getRun(runId, false)
  }

  async getRun(runId: string, revealEvidence = false) {
    const [run] = await this.db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId))
    if (!run) throw new NotFoundException('evaluation run not found')
    const allCandidates = await this.db
      .select()
      .from(evaluationCandidates)
      .where(eq(evaluationCandidates.runId, runId))
      .orderBy(asc(evaluationCandidates.displayOrder))
    const candidates = revealEvidence
      ? allCandidates
      : allCandidates.filter((row) => row.primaryPool)
    const queryIds = [...new Set(candidates.map((row) => row.queryId))]
    const judgments = queryIds.length
      ? await this.db
          .select()
          .from(evaluationJudgments)
          .where(inArray(evaluationJudgments.queryId, queryIds))
      : []
    const judgmentByKey = new Map(
      judgments.map((row) => [`${row.queryId}:${row.candidateKey}`, row]),
    )
    if (
      revealEvidence &&
      allCandidates.some(
        (row) => !judgmentByKey.has(`${row.queryId}:${row.candidateKey}`) && row.primaryPool,
      )
    ) {
      throw new ConflictException(
        'source evidence remains hidden until primary labeling is complete',
      )
    }
    return {
      id: run.id,
      version_id: run.versionId,
      status: run.status,
      config: run.configJson,
      corpus: run.corpusJson,
      report: run.reportJson,
      error_stage: run.errorStage,
      error_message: run.errorMessage,
      candidates: candidates.map((row) => {
        const judgment = judgmentByKey.get(`${row.queryId}:${row.candidateKey}`)
        return {
          id: row.id,
          query_id: row.queryId,
          candidate_key: row.candidateKey,
          file_id: row.fileId,
          scene_id: row.sceneId,
          media_type: row.mediaType,
          start_time_seconds: row.startTimeSeconds === null ? null : Number(row.startTimeSeconds),
          end_time_seconds: row.endTimeSeconds === null ? null : Number(row.endTimeSeconds),
          primary_pool: row.primaryPool,
          judgment: judgment
            ? {
                relevance: judgment.relevance,
                unjudgeable: judgment.unjudgeable,
                diagnosis: judgment.diagnosis,
                notes: judgment.notes,
              }
            : null,
          ...(revealEvidence || judgment
            ? {
                source_evidence: row.sourceEvidenceJson,
                current_rank: row.currentRank,
                current_score: Number(row.currentScore),
                current_included: row.currentIncluded,
                rrf_rank: row.rrfRank,
                rrf_score: Number(row.rrfScore),
                rrf_contributions: row.rrfContributionsJson,
              }
            : {}),
        }
      }),
    }
  }

  async saveJudgment(
    runId: string,
    candidateId: string,
    input: { relevance?: number | null; unjudgeable?: boolean; diagnosis?: string; notes?: string },
  ) {
    const [candidate] = await this.db
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
      diagnosis: input.diagnosis ?? null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    }
    const [existing] = await this.db
      .select()
      .from(evaluationJudgments)
      .where(
        and(
          eq(evaluationJudgments.queryId, candidate.queryId),
          eq(evaluationJudgments.candidateKey, candidate.candidateKey),
        ),
      )
    if (existing)
      await this.db
        .update(evaluationJudgments)
        .set(values)
        .where(eq(evaluationJudgments.id, existing.id))
    else
      await this.db.insert(evaluationJudgments).values({
        id: randomUUID(),
        queryId: candidate.queryId,
        candidateKey: candidate.candidateKey,
        ...values,
      })
    return this.getRun(runId, false)
  }

  async finalizeRun(runId: string) {
    const run = await this.getRun(runId, true)
    if (run.status !== 'ready_for_labeling' && run.status !== 'labeled')
      throw new ConflictException('run is not ready for reporting')
    if (run.candidates.some((candidate) => candidate.primary_pool && !candidate.judgment))
      throw new ConflictException('all primary candidates must be judged')
    const queries = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, run.version_id))
    const reports = queries.map((query) => {
      const candidates = run.candidates.filter(
        (candidate) => candidate.query_id === query.id && candidate.primary_pool,
      )
      const judgments = new Map(
        candidates.map((candidate) => [
          candidate.candidate_key,
          candidate.judgment!.unjudgeable ? null : (candidate.judgment!.relevance as 0 | 1 | 2),
        ]),
      )
      const targetKey = query.targetFileId
        ? this.candidateKey(query.targetFileId, query.targetSceneId)
        : null
      return {
        query_id: query.id,
        query_text: query.queryText,
        current: calculateRankingMetrics(
          [...candidates]
            .filter((item) => item.current_included)
            .sort(
              (a, b) =>
                (a.current_rank ?? Number.MAX_SAFE_INTEGER) -
                (b.current_rank ?? Number.MAX_SAFE_INTEGER),
            )
            .map((item) => item.candidate_key),
          judgments,
          { knownTargetKey: targetKey },
        ),
        rrf: calculateRankingMetrics(
          [...candidates]
            .sort(
              (a, b) =>
                (a.rrf_rank ?? Number.MAX_SAFE_INTEGER) - (b.rrf_rank ?? Number.MAX_SAFE_INTEGER),
            )
            .map((item) => item.candidate_key),
          judgments,
          { knownTargetKey: targetKey },
        ),
      }
    })
    const report = { queries: reports, generated_at: new Date().toISOString() }
    await this.db
      .update(evaluationRuns)
      .set({
        status: 'reported',
        reportJson: report,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(evaluationRuns.id, runId))
    return this.getRun(runId, true)
  }

  private async executeRun(runId: string, versionId: string, libraryIds: string[]) {
    // 一次运行只写一份不可变来源快照；current 与 RRF 都从这些候选证据派生，禁止二次召回。
    const queries = await this.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.versionId, versionId))
      .orderBy(asc(evaluationQueries.createdAt))
    const fileFilter = libraryIds.length
      ? and(sql`${mediaFiles.deletedAt} is null`, inArray(mediaFiles.libraryId, libraryIds))
      : sql`${mediaFiles.deletedAt} is null`
    const pointFilter = libraryIds.length
      ? and(eq(vectorRefs.status, 'indexed'), inArray(vectorRefs.libraryId, libraryIds))
      : eq(vectorRefs.status, 'indexed')
    const [nonVideoCount] = await this.db
      .select({ value: count() })
      .from(mediaFiles)
      .where(and(fileFilter, sql`${mediaFiles.mediaType} <> 'video'`))
    const [sceneCount] = await this.db
      .select({ value: sql<number>`count(distinct ${mediaAssets.metadataJson}->>'scene_id')` })
      .from(mediaAssets)
      .innerJoin(mediaFiles, eq(mediaAssets.fileId, mediaFiles.id))
      .where(and(fileFilter, eq(mediaAssets.assetType, 'video_segment')))
    const pointCounts = await this.db
      .select({ collection: vectorRefs.collectionName, value: count() })
      .from(vectorRefs)
      .where(pointFilter)
      .groupBy(vectorRefs.collectionName)
    const semanticCandidateCount =
      Number(nonVideoCount?.value ?? 0) + Number(sceneCount?.value ?? 0)
    const diagnosticDepth = Math.min(50, Math.max(20, Math.ceil(semanticCandidateCount * 0.2)))
    const corpus = {
      active_files: semanticCandidateCount,
      diagnostic_depth: diagnosticDepth,
      primary_depth: 20,
      collection_points: Object.fromEntries(pointCounts.map((row) => [row.collection, row.value])),
      source_actual_depths: {} as Record<string, Record<string, number>>,
    }
    for (const query of queries) {
      const result = await this.searchService.searchForEvaluation(
        { query: query.queryText, media_types: [], library_ids: libraryIds },
        diagnosticDepth,
      )
      if (!result.executed_collections)
        throw new Error('evaluation search did not report executed collections')
      for (const collection of ['image_vectors', 'video_frame_vectors', 'caption_text_vectors']) {
        if (!result.executed_collections.includes(collection as 'image_vectors'))
          throw new Error(`required evaluation source is unavailable source=${collection}`)
      }
      if (!result.groups.some((group) => group.collection === 'text_search'))
        throw new Error('required evaluation source is unavailable source=text_search')
      corpus.source_actual_depths[query.id] = Object.fromEntries(
        result.groups.map((group) => [group.collection, group.results.length]),
      )
      const sceneWindows = result.groups
        .flatMap((group) => group.results)
        .flatMap((item) =>
          item.scene_id && item.start_time_seconds !== null && item.end_time_seconds !== null
            ? [
                {
                  fileId: item.file_id,
                  sceneId: item.scene_id,
                  start: item.start_time_seconds,
                  end: item.end_time_seconds,
                },
              ]
            : [],
        )
      const evidenceByKey = new Map<
        string,
        { item: (typeof result.groups)[number]['results'][number]; evidence: SourceEvidence[] }
      >()
      for (const group of result.groups) {
        const signal = this.signalForCollection(group.collection)
        const collapsedSourceResults = new Map<string, (typeof group.results)[number]>()
        for (const item of group.results) {
          const alignedSceneId =
            signal === 'lexical' && !item.scene_id
              ? this.alignTimeWindowToScene(
                  item.file_id,
                  item.start_time_seconds,
                  item.end_time_seconds,
                  sceneWindows,
                )
              : (item.scene_id ?? null)
          const key = this.candidateKey(
            item.file_id,
            alignedSceneId,
            item.start_time_seconds,
            item.end_time_seconds,
          )
          if (!collapsedSourceResults.has(key)) collapsedSourceResults.set(key, item)
        }
        ;[...collapsedSourceResults.entries()].forEach(([key, item], index) => {
          const rank = index + 1
          const current = evidenceByKey.get(key) ?? { item, evidence: [] }
          current.evidence = current.evidence.filter(
            (entry) => entry.collection !== group.collection,
          )
          current.evidence.push({
            collection: group.collection,
            signal,
            rank,
            raw_score: item.score,
            asset_id: item.asset_id,
          })
          evidenceByKey.set(key, current)
        })
      }
      const rankingInputs = [...evidenceByKey.entries()].map(([candidateKey, value]) => ({
        candidateKey,
        sourceRanks: Object.fromEntries(
          value.evidence.map((entry) => [entry.signal, entry.rank]),
        ) as Partial<Record<EvaluationSignal, number>>,
      }))
      const rrf = rankByRrf(rankingInputs)
      const rrfByKey = new Map(rrf.map((row) => [row.candidateKey, row]))
      const currentByKey = new Map(
        (result.results ?? []).map((row, index) => [
          this.candidateKey(
            row.file_id,
            row.scene_id ?? null,
            row.start_time_seconds,
            row.end_time_seconds,
          ),
          { rank: index + 1, score: row.score },
        ]),
      )
      let nextFilteredRank = currentByKey.size + 1
      let displayOrder = 0
      const stableBlindOrder = [...evidenceByKey.entries()].sort(([left], [right]) =>
        this.blindOrderKey(runId, query.id, left).localeCompare(
          this.blindOrderKey(runId, query.id, right),
        ),
      )
      for (const [candidateKey, value] of stableBlindOrder) {
        const rrfRow = rrfByKey.get(candidateKey)!
        const current = currentByKey.get(candidateKey) ?? { rank: nextFilteredRank++, score: 0 }
        const currentIncluded = currentByKey.has(candidateKey)
        const primaryPool = value.evidence.some((entry) => entry.rank <= 20)
        await this.db.insert(evaluationCandidates).values({
          id: randomUUID(),
          runId,
          queryId: query.id,
          candidateKey,
          fileId: value.item.file_id,
          sceneId: value.item.scene_id ?? null,
          mediaType: value.item.media_type,
          startTimeSeconds: value.item.start_time_seconds?.toString() ?? null,
          endTimeSeconds: value.item.end_time_seconds?.toString() ?? null,
          displayOrder: displayOrder++,
          primaryPool,
          sourceEvidenceJson: value.evidence,
          currentRank: current.rank,
          currentScore: current.score.toString(),
          currentIncluded,
          rrfRank: rrfRow.rank,
          rrfScore: rrfRow.score.toString(),
          rrfContributionsJson: rrfRow.contributions,
        })
      }
    }
    await this.db
      .update(evaluationRuns)
      .set({ status: 'ready_for_labeling', corpusJson: corpus, updatedAt: new Date() })
      .where(eq(evaluationRuns.id, runId))
    this.logger.log(`evaluation_run_ready run_id=${runId} queries=${queries.length}`)
  }

  private signalForCollection(collection: string): EvaluationSignal {
    // 显式穷举允许进入评测的 collection；新增或拼错名称必须 fail fast，不能默认为 visual。
    if (collection === 'caption_text_vectors') return 'caption'
    if (collection === 'text_search') return 'lexical'
    if (collection === 'image_vectors' || collection === 'video_frame_vectors') return 'visual'
    throw new Error(`unsupported evaluation collection collection=${collection}`)
  }

  private alignTimeWindowToScene(
    fileId: string,
    start: number | null,
    end: number | null,
    scenes: Array<{ fileId: string; sceneId: string; start: number; end: number }>,
  ) {
    if (start === null || end === null) return null
    const matches = scenes.filter(
      (scene) => scene.fileId === fileId && start < scene.end && end > scene.start,
    )
    const unique = [...new Set(matches.map((scene) => scene.sceneId))]
    return unique.length === 1 ? unique[0]! : null
  }

  private candidateKey(
    fileId: string,
    sceneId: string | null,
    start?: number | null,
    end?: number | null,
  ) {
    if (sceneId) return `${fileId}:scene:${sceneId}`
    if (start !== undefined && start !== null) return `${fileId}:time:${start}:${end ?? start}`
    return `${fileId}:file`
  }

  private blindOrderKey(runId: string, queryId: string, candidateKey: string) {
    return createHash('sha256').update(`${runId}|${queryId}|${candidateKey}`).digest('hex')
  }

  private async requireDraftVersion(versionId: string) {
    const [version] = await this.db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, versionId))
    if (!version) throw new NotFoundException('evaluation version not found')
    if (version.status !== 'draft') throw new ConflictException('evaluation version is immutable')
    return version
  }

  private setResponse(row: typeof evaluationSets.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }
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
    }
  }
}
