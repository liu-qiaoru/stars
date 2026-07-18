import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest'
import { mediaTypes } from '@local-media-agent/shared/constants'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import {
  listSearchResultMetadata,
  listTextSearchResultMetadata,
  type Database,
} from '../database/repositories.js'
import { QDRANT_CLIENT } from '../qdrant/qdrant.module.js'
import {
  VECTOR_COLLECTIONS,
  type VectorCollectionConfig,
  type VectorCollectionName,
} from '../qdrant/vector-collections.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import {
  QueryExpansionService,
  queryExpansionModes,
  type QueryExpansionMode,
  type QueryVariant,
} from './query-expansion.service.js'
import {
  buildHybridResults,
  type HybridCandidateInput,
  type HybridReason,
} from './search-hybrid.js'
import { SearchQueryVectorService } from './search-query-vector.service.js'
import { routeQueryVariantsForCollection } from './search-query-routing.js'

const baseSearchCollections = [
  { collection: 'image_vectors', mediaTypes: ['image'] },
  { collection: 'video_frame_vectors', mediaTypes: ['video'] },
] as const satisfies {
  collection: VectorCollectionName
  mediaTypes: readonly (typeof mediaTypes)[number][]
}[]

const captionSearchCollection = {
  collection: 'caption_text_vectors',
  mediaTypes: ['image', 'video'],
} as const satisfies {
  collection: VectorCollectionName
  mediaTypes: readonly (typeof mediaTypes)[number][]
}

// 这些 collection 的视频候选必须携带稳定 scene_id（视频帧向量、视频 Caption）。
// 回表时用该集合判断哪些 collection 的视频 Point 缺少场景身份需要拒绝。
const videoSceneIdentityCollections = new Set<VectorCollectionName>([
  'video_frame_vectors',
  'caption_text_vectors',
])

// SearchService 负责把多个召回来源统一成一个响应：
// Qdrant 做视觉向量召回，PostgreSQL FTS 做 transcript/OCR 文本召回，最终在内存里合并 rerank。
const searchRequestSchema = z.object({
  query: z.string().min(1),
  media_types: z.array(z.enum(mediaTypes)).optional().default([]),
  library_ids: z.array(z.string().uuid()).optional().default([]),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  query_expansion_mode: z.enum(queryExpansionModes).optional().default('expand'),
  include_diagnostics: z.boolean().optional().default(false),
})

export type SearchRequest = z.input<typeof searchRequestSchema>
type ParsedSearchRequest = z.output<typeof searchRequestSchema>
type QdrantFilter = NonNullable<Schemas['SearchRequest']['filter']>
type SearchResultItem = Awaited<ReturnType<SearchService['hydrateResults']>>[number]
type SearchResultGroup = {
  collection: string
  score_kind: string
  results: SearchResultItem[]
}

type QueryVariantHitDiagnostic = {
  text: string
  source: QueryVariant['source']
  weight: number
  raw_score: number
  weighted_score: number
  winning: boolean
}

// 搜索内部统一使用的"命中点"最小形态：Qdrant 返回的 point id 与（跨查询版本去重后的）分数。
// hydrateResults 只需要这两个字段回 PostgreSQL 补事实，无需 Qdrant payload 或向量。
type VectorPointHit = {
  id: string
  score: number
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name)

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: Pick<QdrantClient, 'search' | 'searchPointGroups'>,
    @Inject(SearchQueryVectorService) private readonly queryVectorService: SearchQueryVectorService,
    @Inject(QueryExpansionService) private readonly queryExpansionService: QueryExpansionService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async search(
    input: SearchRequest,
    options: { sourceLimit?: number } = {},
  ) {
    const searchStartedAt = performance.now()
    const request = this.parseRequest(input)
    const sourceLimit = options.sourceLimit ?? this.sourceLimit(request)
    const availableCollections = [
      baseSearchCollections[0],
      baseSearchCollections[1],
      ...(this.settings.captionSearchEnabled ? [captionSearchCollection] : []),
    ]
    const vectorMediaTypes = request.media_types.length
      ? request.media_types
      : [...new Set(availableCollections.flatMap((entry) => entry.mediaTypes))]
    const selectedCollections = availableCollections.filter((entry) =>
      entry.mediaTypes.some((mediaType) => vectorMediaTypes.includes(mediaType)),
    )
    const queryVectorCache = new Map<string, Promise<number[]>>()
    const embedQuery = (query: string, config: VectorCollectionConfig) => {
      const key = `${config.modelName}:${config.modelVersion}:${config.vectorDim}:${query}`
      const cached = queryVectorCache.get(key)
      if (cached) {
        return cached
      }
      const promise = this.queryVectorService.embedQuery(query, config)
      queryVectorCache.set(key, promise)
      return promise
    }
    const expansionStartedAt = performance.now()
    const queryVariants = selectedCollections.length
      ? await this.queryExpansionService.expand(request.query, request.query_expansion_mode)
      : []
    const expansionDurationMs = performance.now() - expansionStartedAt

    const vectorStartedAt = performance.now()
    const vectorGroups = await Promise.all(
      selectedCollections.map(async ({ collection }) => {
        const config = VECTOR_COLLECTIONS[collection]
        // 查询扩展先生成与通道无关的基础版本，再按目标模型选择实际查询语言。
        // 逐 Point 诊断只记录该通道真正执行的版本，避免 UI 把未参与检索的版本标成候选。
        const collectionQueryVariants = routeQueryVariantsForCollection(
          queryVariants,
          collection,
          request.query_expansion_mode,
        )
        const collectionResult = await this.searchCollection(collection, {
          queryVariants: collectionQueryVariants,
          vectorConfig: config,
          libraryIds: request.library_ids,
          limit: sourceLimit,
          embedQuery,
          includeDiagnostics: request.include_diagnostics,
        })
        const results = await this.hydrateResults(
          collection,
          collectionResult.points,
          {
            mediaTypes: vectorMediaTypes,
            libraryIds: request.library_ids,
          },
          {
            includeDiagnostics: request.include_diagnostics,
            queryVariantHitsByPointId: collectionResult.queryVariantHitsByPointId,
          },
        )

        return {
          collection,
          score_kind: this.scoreKindForDistance(config.distance),
          results,
        }
      }),
    )
    const vectorDurationMs = performance.now() - vectorStartedAt
    const textStartedAt = performance.now()
    const textGroup = await this.textSearchGroup(request, { limit: sourceLimit, offset: 0 })
    const textDurationMs = performance.now() - textStartedAt
    const groups = [...vectorGroups, ...(textGroup ? [textGroup] : [])]

    // groups 保留原始来源，便于调试召回；results 是前端/Agent 默认消费的统一排序列表。
    const hybridStartedAt = performance.now()
    const results = buildHybridResults(await this.toHybridCandidates(groups), {
      limit: request.limit,
      offset: request.offset,
    })
    const hybridDurationMs = performance.now() - hybridStartedAt
    this.logger.log(
      `search_timing variants=${queryVariants.length} collections=${selectedCollections.length} ` +
        `expansion_ms=${Math.round(expansionDurationMs)} vector_ms=${Math.round(vectorDurationMs)} ` +
        `fts_ms=${Math.round(textDurationMs)} hybrid_ms=${Math.round(hybridDurationMs)} ` +
        `total_ms=${Math.round(performance.now() - searchStartedAt)}`,
    )
    return {
      limit: request.limit,
      offset: request.offset,
      results,
      groups,
      // Caption 原文属于本地媒体派生内容。只有调用方显式请求诊断时才返回实际
      // 查询版本；逐 Point 证据也只会附加在对应 group result，默认响应保持原样。
      ...(request.include_diagnostics
        ? {
            query_diagnostics: {
              query_expansion_mode: request.query_expansion_mode as QueryExpansionMode,
              query_variants: queryVariants,
            },
          }
        : {}),
    }
  }

  private parseRequest(input: SearchRequest): ParsedSearchRequest {
    const parsed = searchRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message)
    }
    return parsed.data
  }

  // collection 已按 media type 选择，Qdrant 侧只需按 library_id 过滤。media_type 的 defense-in-depth 由 PostgreSQL JOIN 保障。
  private buildFilter(libraryIds: string[]): QdrantFilter | undefined {
    if (!libraryIds.length) {
      return undefined
    }
    return { must: [{ key: 'library_id', match: { any: libraryIds } }] }
  }

  private async searchCollection(
    collection: VectorCollectionName,
    input: {
      queryVariants: QueryVariant[]
      vectorConfig: VectorCollectionConfig
      libraryIds: string[]
      limit: number
      embedQuery: (query: string, config: VectorCollectionConfig) => Promise<number[]>
      includeDiagnostics: boolean
    },
  ) {
    // video_frame_vectors 用 Qdrant grouped search（group_by=scene_id, group_size=1）让服务端
    // 为每个场景只返回最高分代表帧（MaxSim）；其余 collection 用普通 search。两条路径都跨查询
    // 变体按"身份"去重并取最高加权分：grouped 的身份是场景 key，普通检索的身份是 point id。
    const grouped = collection === 'video_frame_vectors'
    const bestByGroupKey = new Map<string, VectorPointHit>()
    // 同一 Point 可能被原查询和多个扩展词命中。生产分数仍取最高 weighted_score；
    // 诊断模式额外保留所有原始分数，帮助判断错误候选究竟由哪个查询版本推高。
    const variantHitsByPointId = new Map<
      string,
      Array<Omit<QueryVariantHitDiagnostic, 'winning'>>
    >()
    const winningVariantTextByPointId = new Map<string, string>()

    for (const variant of input.queryVariants) {
      // Search API 只读取 Qdrant；query embedding 由本地 model service 同步生成，批量媒体 embedding 仍走 worker job。
      const vector = await input.embedQuery(variant.text, input.vectorConfig)
      const filter = this.buildFilter(input.libraryIds)
      const hits: Array<{ pointId: string; score: number; groupKey: string }> = grouped
        ? await this.searchGroupedHits(collection, vector, filter, input.limit)
        : (
            await this.qdrantClient.search(collection, {
              vector,
              filter,
              limit: input.limit,
              offset: 0,
              with_payload: false,
              with_vector: false,
            })
          )
            .filter(
              (point): point is Schemas['ScoredPoint'] & { id: string } =>
                typeof point.id === 'string',
            )
            .map((point) => ({ pointId: point.id, score: point.score, groupKey: point.id }))

      const shouldLogExpansionDiagnostics =
        input.queryVariants.length > 1 || variant.source !== 'original'
      if (shouldLogExpansionDiagnostics) {
        const topRawScore = Math.max(0, ...hits.map((hit) => hit.score))
        this.logger.log(
          `collection=${collection} variant="${variant.text}" source=${variant.source} weight=${variant.weight.toFixed(
            2,
          )} raw_hits=${hits.length} top_raw_score=${topRawScore} top_weighted_score=${
            topRawScore * variant.weight
          }`,
        )
      }
      for (const hit of hits) {
        const weightedScore = hit.score * variant.weight
        if (input.includeDiagnostics) {
          const pointHits = variantHitsByPointId.get(hit.pointId) ?? []
          pointHits.push({
            text: variant.text,
            source: variant.source,
            weight: variant.weight,
            raw_score: hit.score,
            weighted_score: weightedScore,
          })
          variantHitsByPointId.set(hit.pointId, pointHits)
        }
        const existing = bestByGroupKey.get(hit.groupKey)
        if (!existing || weightedScore > existing.score) {
          bestByGroupKey.set(hit.groupKey, { id: hit.pointId, score: weightedScore })
          // 相同加权分数保留先执行的查询版本，因此每个身份始终只有一个 winning。
          winningVariantTextByPointId.set(hit.pointId, variant.text)
        }
      }
    }

    return {
      // 先跨查询版本去重（按场景或 point），再执行来源内 Top-K 截断；否则一个场景/Point 可能重复占用深度。
      points: [...bestByGroupKey.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit),
      queryVariantHitsByPointId: new Map(
        [...variantHitsByPointId.entries()].map(([pointId, hits]) => [
          pointId,
          hits.map((hit) => ({
            ...hit,
            winning: hit.text === winningVariantTextByPointId.get(pointId),
          })),
        ]),
      ),
    }
  }

  // 对 video_frame_vectors 调用 Qdrant searchPointGroups：按 payload 的 scene_id 分组，每个场景只取
  // group_size=1 的最高分代表帧（服务端 MaxSim）。返回 {pointId, score, groupKey=scene_id} 统一结构，
  // 让 searchCollection 像普通检索一样按身份去重。groupKey 来自 Qdrant payload 的 scene_id，
  // 最终事实仍以 PostgreSQL media_assets.scene_id 为准，回表时校验。
  private async searchGroupedHits(
    collection: VectorCollectionName,
    vector: number[],
    filter: QdrantFilter | undefined,
    limit: number,
  ): Promise<Array<{ pointId: string; score: number; groupKey: string }>> {
    const result = await this.qdrantClient.searchPointGroups(collection, {
      vector,
      filter,
      group_by: 'scene_id',
      group_size: 1,
      limit,
      with_payload: false,
      with_vector: false,
    })
    return (result.groups ?? []).flatMap((group) => {
      const groupKey = typeof group.id === 'string' ? group.id : String(group.id ?? '')
      const best = group.hits.find((hit) => typeof hit.id === 'string')
      return best ? [{ pointId: best.id as string, score: best.score, groupKey }] : []
    })
  }

  private sourceLimit(request: ParsedSearchRequest) {
    // 先 overfetch 再合并/分页，避免同 asset 或相邻视频窗口折叠后结果池过小。
    // 300 是当前内存合并的保护上限，深分页的限制记录在 API contract 中。
    return Math.min(300, Math.max(30, (request.offset + request.limit) * 3))
  }

  private async hydrateResults(
    collection: VectorCollectionName,
    points: VectorPointHit[],
    filters: { mediaTypes: string[]; libraryIds: string[] },
    diagnostics: {
      includeDiagnostics: boolean
      queryVariantHitsByPointId: Map<string, QueryVariantHitDiagnostic[]>
    },
  ) {
    const pointIds = points.map((point) => point.id)
    const rows = await listSearchResultMetadata(this.db, collection, pointIds, {
      mediaTypes: filters.mediaTypes,
      libraryIds: filters.libraryIds,
    })
    const metadataByPointId = new Map(rows.map((row) => [row.pointId, row]))

    // Qdrant 决定 collection 内排序；PostgreSQL 只补事实字段，所以这里按 Qdrant 返回顺序重组。
    let rejectedMissingSceneId = 0
    const hydrated = points.flatMap((point) => {
      const row = metadataByPointId.get(point.id)
      if (!row) {
        return []
      }
      // scene_id 现在是 media_assets 的正式列（视频帧/caption 引用真实 video_scenes 行）。
      const sceneId = row.sceneId
      // 视频检索的业务单元是稳定场景。回表已拒绝缺场景/过期 generation/旧模型的 Point，
      // 这里再对缺 scene_id 的视频候选兜底拒绝，避免任何残留旧帧进入 groups 和 results。
      // 图片 Caption 也使用 caption_text_vectors，因此限定 mediaType=video，不误伤图片。
      if (
        row.mediaType === 'video' &&
        videoSceneIdentityCollections.has(collection) &&
        sceneId === null
      ) {
        rejectedMissingSceneId += 1
        return []
      }
      const frameTimeSeconds = row.frameTimeSeconds === null ? null : Number(row.frameTimeSeconds)
      const sceneStart =
        row.sceneStartTimeSeconds === null ? null : Number(row.sceneStartTimeSeconds)
      const sceneEnd = row.sceneEndTimeSeconds === null ? null : Number(row.sceneEndTimeSeconds)
      // 视频场景候选用 video_scenes 的权威边界作为播放窗口；图片/无场景资产用 asset 自身时间。
      const isVideoScene = row.mediaType === 'video' && sceneId !== null
      const startTimeSeconds = isVideoScene
        ? sceneStart
        : row.startTimeSeconds === null
          ? frameTimeSeconds
          : Number(row.startTimeSeconds)
      const endTimeSeconds = isVideoScene
        ? sceneEnd
        : row.endTimeSeconds === null
          ? frameTimeSeconds
          : Number(row.endTimeSeconds)
      return [
        {
          asset_id: row.assetId,
          file_id: row.fileId,
          media_type: row.mediaType,
          path: row.path,
          start_time_seconds: startTimeSeconds,
          end_time_seconds: endTimeSeconds,
          scene_id: sceneId,
          // 分组检索命中的代表帧时间（视频帧候选），用于诊断展示"该场景靠哪一帧命中"。
          best_frame_time_seconds: frameTimeSeconds,
          score: point.score,
          reason: this.vectorReason(collection),
          _point_id: point.id,
          _caption_text: row.assetType === 'caption' ? row.textContent : null,
          _prompt_version: this.promptVersion(row.metadataJson),
        },
      ]
    })
    if (rejectedMissingSceneId > 0) {
      // 只记录 collection 和数量，不记录本地路径、Caption 或查询文本。该日志用于区分
      // “Qdrant 没有召回”与“召回了迁移前旧 Point，但被场景完整性规则拒绝”。
      this.logger.warn(
        `search_scene_identity_rejected collection=${collection} count=${rejectedMissingSceneId}`,
      )
    }
    return hydrated.map((item, index) => {
      const { _point_id, _caption_text, _prompt_version, ...result } = item
      if (!diagnostics.includeDiagnostics) {
        // 私有字段只用于构造显式诊断，必须在默认响应序列化前全部移除。
        return result
      }
      return {
        ...result,
        diagnostics: {
          // 来源名次在 PostgreSQL 过滤 stale/软删除记录后重新连续编号，和用户实际看到的
          // group 顺序一致；不能直接沿用可能包含无效 Point 的 Qdrant 原始下标。
          source_rank: index + 1,
          ...(_caption_text
            ? { caption: { text: _caption_text, prompt_version: _prompt_version } }
            : {}),
          query_variant_hits: diagnostics.queryVariantHitsByPointId.get(_point_id) ?? [],
        },
      }
    })
  }

  private vectorReason(collection: VectorCollectionName): HybridReason {
    return collection === 'caption_text_vectors' ? 'caption_match' : 'vector_match'
  }

  private scoreKindForDistance(distance: string) {
    return distance === 'Cosine' ? 'cosine_similarity' : distance.toLowerCase()
  }

  private async textSearchGroup(
    request: ParsedSearchRequest,
    pagination: { limit: number; offset: number },
  ) {
    const textMediaTypes = request.media_types.length
      ? request.media_types.filter(
          (mediaType) => mediaType === 'image' || mediaType === 'audio' || mediaType === 'video',
        )
      : ['image', 'audio', 'video']
    if (textMediaTypes.length === 0) {
      return undefined
    }

    const rows = await listTextSearchResultMetadata(this.db, {
      query: request.query,
      filters: {
        mediaTypes: textMediaTypes,
        libraryIds: request.library_ids,
      },
      limit: pagination.limit,
      offset: pagination.offset,
    })

    return {
      collection: 'text_search',
      score_kind: 'ts_rank_cd',
      results: rows.flatMap((row) => {
        const reason = this.textSearchReason(row.assetType, row.mediaType)
        if (!reason) {
          return []
        }
        return [
          {
            asset_id: row.assetId,
            file_id: row.fileId,
            media_type: row.mediaType,
            path: row.path,
            start_time_seconds: row.startTimeSeconds === null ? null : Number(row.startTimeSeconds),
            end_time_seconds: row.endTimeSeconds === null ? null : Number(row.endTimeSeconds),
            scene_id: row.sceneId,
            // 转录文本是时间区间证据，没有代表帧时间。
            best_frame_time_seconds: null,
            score: Number(row.score),
            reason,
          },
        ]
      }),
    }
  }

  private textSearchReason(assetType: string, mediaType: string): HybridReason | undefined {
    // 阶段 2 删除 OCR 后，全文检索只剩 text_chunk 转录一种语义（image/video_frame 不再有 OCR 文本）。
    if (assetType === 'text_chunk' && (mediaType === 'audio' || mediaType === 'video')) {
      return 'transcript_match'
    }
    return undefined
  }

  private async toHybridCandidates(groups: SearchResultGroup[]): Promise<HybridCandidateInput[]> {
    // 统一候选是 reranker 的输入层：只保留合并和打分需要的字段，不把 group 展示结构泄漏进去。
    // 视频帧候选已在 searchCollection 的分组检索阶段按 scene_id 折叠（每场景一个代表帧），
    // 这里不再做内存折叠；best_frame_time_seconds 由 hydrateResults 从代表帧时间填入。
    return groups.flatMap((group) =>
      group.results.flatMap((result) => {
        const reason = this.hybridReason(result.reason)
        if (!reason) {
          return []
        }
        return [
          {
            asset_id: result.asset_id,
            file_id: result.file_id,
            media_type: result.media_type,
            path: result.path,
            start_time_seconds: result.start_time_seconds,
            end_time_seconds: result.end_time_seconds,
            scene_id: result.scene_id,
            best_frame_time_seconds: result.best_frame_time_seconds ?? null,
            reasons: [reason],
            source_scores: { [group.collection]: result.score },
          } satisfies HybridCandidateInput,
        ]
      }),
    )
  }

  private hybridReason(reason: string): HybridReason | undefined {
    if (
      reason === 'vector_match' ||
      reason === 'transcript_match' ||
      reason === 'caption_match'
    ) {
      return reason
    }
    return undefined
  }

  private promptVersion(metadata: unknown) {
    if (typeof metadata !== 'object' || metadata === null || !('prompt_version' in metadata)) {
      return null
    }
    return typeof metadata.prompt_version === 'string' ? metadata.prompt_version : null
  }
}
