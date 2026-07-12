import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest'
import { mediaTypes } from '@local-media-agent/shared/constants'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import {
  listSearchResultMetadata,
  listTextSearchResultMetadata,
  listVideoSceneBounds,
  type Database,
} from '../database/repositories.js'
import { QDRANT_CLIENT } from '../qdrant/qdrant.module.js'
import {
  VECTOR_COLLECTIONS,
  type VectorCollectionConfig,
  type VectorCollectionName,
} from '../qdrant/vector-collections.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { QueryExpansionService, type QueryVariant } from './query-expansion.service.js'
import {
  buildHybridResults,
  type HybridCandidateInput,
  type HybridReason,
} from './search-hybrid.js'
import { SearchQueryVectorService } from './search-query-vector.service.js'
import {
  collapseVideoFramesByScene,
  type SceneBound,
  type VideoFrameCandidate,
} from './search-scene-maxsim.js'

const baseSearchCollections = [
  { collection: 'image_vectors', mediaTypes: ['image'] },
  { collection: 'video_frame_vectors', mediaTypes: ['video'] },
] as const satisfies {
  collection: VectorCollectionName
  mediaTypes: readonly (typeof mediaTypes)[number][]
}[]

const videoSegmentSearchCollection = {
  collection: 'video_segment_vectors',
  mediaTypes: ['video'],
} as const satisfies {
  collection: VectorCollectionName
  mediaTypes: readonly (typeof mediaTypes)[number][]
}

const captionSearchCollection = {
  collection: 'caption_text_vectors',
  mediaTypes: ['image', 'video'],
} as const satisfies {
  collection: VectorCollectionName
  mediaTypes: readonly (typeof mediaTypes)[number][]
}

// SearchService 负责把多个召回来源统一成一个响应：
// Qdrant 做视觉向量召回，PostgreSQL FTS 做 transcript/OCR 文本召回，最终在内存里合并 rerank。
const searchRequestSchema = z.object({
  query: z.string().min(1),
  media_types: z.array(z.enum(mediaTypes)).optional().default([]),
  library_ids: z.array(z.string().uuid()).optional().default([]),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
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

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name)

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: Pick<QdrantClient, 'search'>,
    @Inject(SearchQueryVectorService) private readonly queryVectorService: SearchQueryVectorService,
    @Inject(QueryExpansionService) private readonly queryExpansionService: QueryExpansionService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async search(input: SearchRequest) {
    const searchStartedAt = performance.now()
    const request = this.parseRequest(input)
    const sourceLimit = this.sourceLimit(request)
    const availableCollections = [
      baseSearchCollections[0],
      ...(this.settings.videoSegmentSearchEnabled !== false ? [videoSegmentSearchCollection] : []),
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
      ? await this.queryExpansionService.expand(request.query)
      : []
    const expansionDurationMs = performance.now() - expansionStartedAt

    const vectorStartedAt = performance.now()
    const vectorGroups = await Promise.all(
      selectedCollections.map(async ({ collection }) => {
        const config = VECTOR_COLLECTIONS[collection]
        const points = await this.searchCollection(collection, {
          queryVariants,
          vectorConfig: config,
          libraryIds: request.library_ids,
          limit: sourceLimit,
          embedQuery,
        })
        const results = await this.hydrateResults(collection, points, {
          mediaTypes: vectorMediaTypes,
          libraryIds: request.library_ids,
        })

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
    },
  ) {
    const byPointId = new Map<string, Schemas['ScoredPoint']>()
    for (const variant of input.queryVariants) {
      const points = await this.qdrantClient.search(collection, {
        // Search API 只读取 Qdrant；query embedding 由本地 model service 同步生成，批量媒体 embedding 仍走 worker job。
        vector: await input.embedQuery(variant.text, input.vectorConfig),
        filter: this.buildFilter(input.libraryIds),
        limit: input.limit,
        offset: 0,
        with_payload: false,
        with_vector: false,
      })
      const shouldLogExpansionDiagnostics =
        input.queryVariants.length > 1 || variant.source !== 'original'
      if (shouldLogExpansionDiagnostics) {
        const topRawScore = Math.max(0, ...points.map((point) => point.score))
        this.logger.log(
          `collection=${collection} variant="${variant.text}" source=${variant.source} weight=${variant.weight.toFixed(
            2,
          )} raw_hits=${points.length} top_raw_score=${topRawScore} top_weighted_score=${
            topRawScore * variant.weight
          }`,
        )
      }
      for (const point of points) {
        if (typeof point.id !== 'string') {
          continue
        }
        const weightedScore = point.score * variant.weight
        const existing = byPointId.get(point.id)
        if (!existing || weightedScore > existing.score) {
          byPointId.set(point.id, { ...point, score: weightedScore })
        }
      }
    }

    return [...byPointId.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit)
  }

  private sourceLimit(request: ParsedSearchRequest) {
    // 先 overfetch 再合并/分页，避免同 asset 或相邻视频窗口折叠后结果池过小。
    // 300 是当前内存合并的保护上限，深分页的限制记录在 API contract 中。
    return Math.min(300, Math.max(30, (request.offset + request.limit) * 3))
  }

  private async hydrateResults(
    collection: VectorCollectionName,
    points: Schemas['ScoredPoint'][],
    filters: { mediaTypes: string[]; libraryIds: string[] },
  ) {
    const pointIds = points
      .map((point) => point.id)
      .filter((id): id is string => typeof id === 'string')
    const rows = await listSearchResultMetadata(this.db, collection, pointIds, filters)
    const metadataByPointId = new Map(rows.map((row) => [row.pointId, row]))

    // Qdrant 决定 collection 内排序；PostgreSQL 只补事实字段，所以这里按 Qdrant 返回顺序重组。
    return points.flatMap((point) => {
      if (typeof point.id !== 'string') {
        return []
      }
      const row = metadataByPointId.get(point.id)
      if (!row) {
        return []
      }
      const frameTimeSeconds = row.frameTimeSeconds === null ? null : Number(row.frameTimeSeconds)
      const startTimeSeconds =
        row.startTimeSeconds === null ? frameTimeSeconds : Number(row.startTimeSeconds)
      const endTimeSeconds =
        row.endTimeSeconds === null ? frameTimeSeconds : Number(row.endTimeSeconds)
      return [
        {
          asset_id: row.assetId,
          file_id: row.fileId,
          media_type: row.mediaType,
          path: row.path,
          start_time_seconds: startTimeSeconds,
          end_time_seconds: endTimeSeconds,
          scene_id: this.sceneId(row.metadataJson),
          score: point.score,
          reason: this.vectorReason(collection),
        },
      ]
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
            scene_id: this.sceneId(row.metadataJson),
            score: Number(row.score),
            reason,
          },
        ]
      }),
    }
  }

  private textSearchReason(assetType: string, mediaType: string): HybridReason | undefined {
    // 同一个 text_search source 里有 transcript 与 OCR 两种语义，必须按 asset/media type 区分给用户解释。
    if (assetType === 'text_chunk' && (mediaType === 'audio' || mediaType === 'video')) {
      return 'transcript_match'
    }
    if (assetType === 'image' || assetType === 'video_frame') {
      return 'ocr_match'
    }
    return undefined
  }

  private async toHybridCandidates(groups: SearchResultGroup[]): Promise<HybridCandidateInput[]> {
    // 统一候选是 reranker 的输入层：只保留合并和打分需要的字段，不把 group 展示结构泄漏进去。
    const candidatesByGroup = groups.map((group) => ({
      collection: group.collection,
      candidates: group.results.flatMap((result) => {
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
            reasons: [reason],
            source_scores: { [group.collection]: result.score },
          } satisfies HybridCandidateInput,
        ]
      }),
    }))
    const frameCandidates = candidatesByGroup
      .filter((group) => group.collection === 'video_frame_vectors')
      .flatMap((group) => group.candidates)
      .filter((candidate): candidate is VideoFrameCandidate => candidate.media_type === 'video')
    const sceneKeys = [
      ...new Map(
        frameCandidates.flatMap((candidate) =>
          candidate.scene_id
            ? [
                [
                  `${candidate.file_id}|${candidate.scene_id}`,
                  { fileId: candidate.file_id, sceneId: candidate.scene_id },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ]
    const sceneRows = await listVideoSceneBounds(this.db, sceneKeys)
    const sceneBounds: SceneBound[] = sceneRows.map((row) => {
      if (row.startTimeSeconds === null || row.endTimeSeconds === null) {
        throw new Error(
          `Video segment boundary is null for file_id=${row.fileId} scene_id=${row.sceneId}`,
        )
      }
      return {
        file_id: row.fileId,
        scene_id: row.sceneId,
        start_time_seconds: Number(row.startTimeSeconds),
        end_time_seconds: Number(row.endTimeSeconds),
      }
    })
    const collapsedFrames = collapseVideoFramesByScene(frameCandidates, sceneBounds)
    if (frameCandidates.length > 0) {
      this.logger.log(
        `scene_maxsim raw_frame_hits=${frameCandidates.length} collapsed_scenes=${collapsedFrames.length} ` +
          `results=${collapsedFrames
            .map((candidate) => {
              const score = candidate.source_scores.video_frame_vectors ?? 0
              return `${candidate.file_id}/${candidate.scene_id ?? candidate.asset_id}:best_time=${candidate.best_frame_time_seconds}:score=${score.toFixed(4)}:merged=${candidate.merged_asset_ids?.length ?? 1}`
            })
            .join(',')}`,
      )
    }
    const otherCandidates = candidatesByGroup
      .filter((group) => group.collection !== 'video_frame_vectors')
      .flatMap((group) => group.candidates)
    return [...otherCandidates, ...collapsedFrames]
  }

  private hybridReason(reason: string): HybridReason | undefined {
    if (
      reason === 'vector_match' ||
      reason === 'transcript_match' ||
      reason === 'ocr_match' ||
      reason === 'caption_match'
    ) {
      return reason
    }
    return undefined
  }

  private sceneId(metadata: unknown) {
    if (typeof metadata !== 'object' || metadata === null || !('scene_id' in metadata)) {
      return null
    }
    const sceneId = metadata.scene_id
    return typeof sceneId === 'string' ? sceneId : null
  }
}
