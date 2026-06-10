import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest'
import { mediaTypes } from '@local-media-agent/shared/constants'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import { listSearchResultMetadata, type Database } from '../database/repositories.js'
import { QDRANT_CLIENT } from '../qdrant/qdrant.module.js'
import { VECTOR_COLLECTIONS, type VectorCollectionName } from '../qdrant/vector-collections.js'
import { SearchQueryVectorService } from './search-query-vector.service.js'

const supportedSearchCollections = [
  { collection: 'image_vectors', mediaType: 'image' },
  { collection: 'video_segment_vectors', mediaType: 'video' },
] as const satisfies { collection: VectorCollectionName; mediaType: (typeof mediaTypes)[number] }[]

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

@Injectable()
export class SearchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QDRANT_CLIENT) private readonly qdrantClient: Pick<QdrantClient, 'search'>,
    @Inject(SearchQueryVectorService) private readonly queryVectorService: SearchQueryVectorService,
  ) {}

  async search(input: SearchRequest) {
    const request = this.parseRequest(input)
    const requestedMediaTypes = request.media_types.length
      ? request.media_types
      : supportedSearchCollections.map((entry) => entry.mediaType)
    const selectedCollections = supportedSearchCollections.filter((entry) =>
      requestedMediaTypes.includes(entry.mediaType),
    )

    const groups = await Promise.all(
      selectedCollections.map(async ({ collection }) => {
        const config = VECTOR_COLLECTIONS[collection]
        const points = await this.qdrantClient.search(collection, {
          // Search API 只读取 Qdrant；query embedding 由本地 model service 同步生成，批量媒体 embedding 仍走 worker job。
          vector: await this.queryVectorService.embedQuery(request.query, config.vectorDim),
          filter: this.buildFilter(request.library_ids),
          limit: request.limit,
          offset: request.offset,
          with_payload: false,
          with_vector: false,
        })
        const results = await this.hydrateResults(collection, points, {
          mediaTypes: requestedMediaTypes,
          libraryIds: request.library_ids,
        })

        return {
          collection,
          score_kind: this.scoreKindForDistance(config.distance),
          results,
        }
      }),
    )

    return {
      limit: request.limit,
      offset: request.offset,
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
      return [
        {
          asset_id: row.assetId,
          file_id: row.fileId,
          media_type: row.mediaType,
          path: row.path,
          start_time_seconds: row.startTimeSeconds === null ? null : Number(row.startTimeSeconds),
          end_time_seconds: row.endTimeSeconds === null ? null : Number(row.endTimeSeconds),
          scene_id: this.sceneId(row.metadataJson),
          score: point.score,
          reason: 'vector_match',
        },
      ]
    })
  }

  private scoreKindForDistance(distance: string) {
    return distance === 'Cosine' ? 'cosine_similarity' : distance.toLowerCase()
  }

  private sceneId(metadata: unknown) {
    if (typeof metadata !== 'object' || metadata === null || !('scene_id' in metadata)) {
      return null
    }
    const sceneId = metadata.scene_id
    return typeof sceneId === 'string' ? sceneId : null
  }
}
