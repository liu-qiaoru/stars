import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import {
  agentRunEvents,
  agentRuns,
  agentToolCalls,
  jobs,
  libraries,
  mediaAssets,
  mediaFiles,
  vectorRefs,
  videoScenes,
} from './schema.js'
import type * as schema from './schema.js'

type JsonValue = unknown
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>

type InsertLibrary = typeof libraries.$inferInsert
type InsertMediaFile = typeof mediaFiles.$inferInsert
type InsertMediaAsset = typeof mediaAssets.$inferInsert
type InsertVectorRef = typeof vectorRefs.$inferInsert
type InsertJob = typeof jobs.$inferInsert
type InsertAgentRun = typeof agentRuns.$inferInsert
type InsertAgentRunEvent = typeof agentRunEvents.$inferInsert
type InsertAgentToolCall = typeof agentToolCalls.$inferInsert
// 必须与 Python worker 的 point id 生成 namespace 保持一致，否则重索引会产生不同 Qdrant point。
const POINT_NAMESPACE = 'f3f4e35a-688d-4f79-99e0-91f9480a5827'

export async function createLibrary(db: Database, input: Pick<InsertLibrary, 'name' | 'rootPath'>) {
  const [row] = await db
    .insert(libraries)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function createMediaFile(
  db: Database,
  input: Pick<
    InsertMediaFile,
    'libraryId' | 'path' | 'relativePath' | 'mediaType' | 'sizeBytes' | 'mtimeMs'
  > &
    Partial<
      Pick<InsertMediaFile, 'contentHash' | 'durationSeconds' | 'width' | 'height' | 'codec'>
    >,
) {
  const [row] = await db
    .insert(mediaFiles)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function createMediaAsset(
  db: Database,
  input: Pick<InsertMediaAsset, 'fileId' | 'assetType'> &
    Partial<
      Pick<
        InsertMediaAsset,
        | 'path'
        | 'sceneId'
        | 'startTimeSeconds'
        | 'endTimeSeconds'
        | 'frameTimeSeconds'
        | 'contentHash'
        | 'textContent'
        | 'metadataJson'
      >
    >,
) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function createVectorRef(
  db: Database,
  input: Pick<
    InsertVectorRef,
    | 'assetId'
    | 'fileId'
    | 'libraryId'
    | 'collectionName'
    | 'pointId'
    | 'modelName'
    | 'modelVersion'
    | 'vectorKind'
    | 'vectorDim'
    | 'distance'
    | 'contentHash'
    | 'indexProfile'
  > &
    Partial<Pick<InsertVectorRef, 'status'>>,
) {
  // point_id 由 worker 按 vector-index-design 的确定性规则生成；repository 只保存引用关系。
  const [row] = await db
    .insert(vectorRefs)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function createJob(
  db: Database,
  input: Pick<InsertJob, 'jobType'> &
    Partial<Pick<InsertJob, 'priority' | 'maxAttempts' | 'timeoutSeconds' | 'fileId'>> & {
      inputJson: JsonValue
    },
) {
  // input_json 必须来自 packages/shared 的 job schema，Python worker 只消费生成后的 JSON Schema。
  // fileId 用于单文件媒体任务（index_media/embed_*/transcribe/generate_caption/export_clip），
  // 方便按文件查询活跃任务；scan_library 等多文件任务不填。
  const [row] = await db
    .insert(jobs)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function listPendingEmbeddingVectorRefs(db: Database, limitCount = 100) {
  // 这里扫描的是 PostgreSQL 中 pending 的 vector_refs，而不是 Qdrant。
  // Python worker 负责真正读取文件、生成 embedding、写 Qdrant，并把 ref 标成 indexed。
  return db
    .select({
      vectorRefId: vectorRefs.id,
      vectorRefUpdatedAt: vectorRefs.updatedAt,
      assetId: vectorRefs.assetId,
      fileId: vectorRefs.fileId,
      libraryId: vectorRefs.libraryId,
      collectionName: vectorRefs.collectionName,
      pointId: vectorRefs.pointId,
      modelName: vectorRefs.modelName,
      modelVersion: vectorRefs.modelVersion,
      vectorKind: vectorRefs.vectorKind,
      vectorDim: vectorRefs.vectorDim,
      assetType: mediaAssets.assetType,
      assetPath: mediaAssets.path,
      startTimeSeconds: mediaAssets.startTimeSeconds,
      endTimeSeconds: mediaAssets.endTimeSeconds,
      metadataJson: mediaAssets.metadataJson,
      frameTimeSeconds: mediaAssets.frameTimeSeconds,
      filePath: mediaFiles.path,
      mediaType: mediaFiles.mediaType,
    })
    .from(vectorRefs)
    .innerJoin(mediaAssets, eq(vectorRefs.assetId, mediaAssets.id))
    .innerJoin(mediaFiles, eq(vectorRefs.fileId, mediaFiles.id))
    .where(
      and(
        eq(vectorRefs.status, 'pending'),
        inArray(vectorRefs.collectionName, [
          'image_vectors',
          'video_frame_vectors',
          'caption_text_vectors',
        ]),
        isNull(mediaFiles.deletedAt),
        // 排除 purge_queued 文件：阶段 3 的破坏性重索引即将删除其派生数据，
        // 协调器不应再为它创建新的 embedding 任务，避免边删边写的竞争。
        sql`${mediaFiles.indexStatus} <> 'purge_queued'`,
      ),
    )
    .orderBy(asc(vectorRefs.createdAt))
    .limit(limitCount)
}

// 阶段 3：会对索引派生数据产生影响的媒体任务类型。重索引前若存在这些 queued/running 任务，
// 必须阻止 purge，避免和正在写入的索引竞争。
const MEDIA_INDEX_JOB_TYPES = [
  'index_media',
  'purge_video_index',
  'embed_image',
  'embed_video_frame',
  'embed_text_asset',
  'generate_caption',
] as const

/**
 * 列出某文件仍处于 queued/running 的媒体索引任务。
 *
 * 同时匹配 jobs.file_id 外键和 input_json->>'file_id'：阶段 2 起新媒体任务会填 file_id 列，
 * 但保留 input_json 兜底以兼容未填列的历史/异常任务。供重索引前的并发阻止检查使用。
 */
export async function getActiveMediaJobsForFile(db: Database, fileId: string) {
  return db
    .select({
      id: jobs.id,
      jobType: jobs.jobType,
      status: jobs.status,
    })
    .from(jobs)
    .where(
      and(
        or(eq(jobs.fileId, fileId), sql`${jobs.inputJson}->>'file_id' = ${fileId}`),
        inArray(jobs.jobType, [...MEDIA_INDEX_JOB_TYPES]),
        inArray(jobs.status, ['queued', 'running']),
      ),
    )
    .orderBy(desc(jobs.createdAt))
}

/**
 * 同一事务内把文件标记为 purge_queued 并创建 purge_video_index 任务。
 *
 * 事务保证"状态翻转 + 任务入库"原子完成：任一步失败都不留下 purge_queued 却无任务的半成品。
 * 调用方必须先用 getActiveMediaJobsForFile 确认无活跃媒体任务。
 */
export async function createVideoReindex(db: Database, fileId: string) {
  return db.transaction(async (tx) => {
    await tx
      .update(mediaFiles)
      .set({ indexStatus: 'purge_queued', updatedAt: new Date() })
      .where(eq(mediaFiles.id, fileId))
    const [job] = await tx
      .insert(jobs)
      .values({
        id: randomUUID(),
        jobType: 'purge_video_index',
        fileId,
        inputJson: { file_id: fileId },
      })
      .returning()
    return job
  })
}

export async function resetVectorRefsForCollection(
  db: Database,
  input: Pick<
    InsertVectorRef,
    'collectionName' | 'modelName' | 'modelVersion' | 'vectorKind' | 'vectorDim' | 'distance'
  >,
) {
  // Collection 维度或模型版本变化时，旧 Qdrant points 不再可信。
  // 这里只重置 PostgreSQL refs 为 pending；实际重新写入仍交给 embedding job。
  const rows = await db
    .select()
    .from(vectorRefs)
    .where(eq(vectorRefs.collectionName, input.collectionName))

  let updated = 0
  for (const row of rows) {
    await db
      .update(vectorRefs)
      .set({
        pointId: deterministicPointId({
          assetId: row.assetId,
          collectionName: input.collectionName,
          modelName: input.modelName,
          modelVersion: input.modelVersion,
          vectorKind: input.vectorKind,
          contentHash: row.contentHash,
        }),
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        vectorKind: input.vectorKind,
        vectorDim: input.vectorDim,
        distance: input.distance,
        status: 'pending',
        updatedAt: new Date(),
      })
      .where(eq(vectorRefs.id, row.id))
    updated += 1
  }

  return updated
}

function deterministicPointId(input: {
  assetId: string
  collectionName: string
  modelName: string
  modelVersion: string
  vectorKind: string
  contentHash: string
}) {
  const namespace = Buffer.from(POINT_NAMESPACE.replaceAll('-', ''), 'hex')
  const name = Buffer.from(
    [
      input.assetId,
      input.collectionName,
      input.modelName,
      input.modelVersion,
      input.vectorKind,
      input.contentHash,
    ].join('|'),
    'utf8',
  )
  const digest = createHash('sha1').update(namespace).update(name).digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function listAttemptedEmbeddingJobs(db: Database) {
  return db
    .select({
      jobType: jobs.jobType,
      inputJson: jobs.inputJson,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.jobType, ['embed_image', 'embed_video_frame', 'embed_text_asset']),
        inArray(jobs.status, ['queued', 'running', 'failed', 'succeeded']),
      ),
    )
}

export async function getFileWithAssetsAndVectors(db: Database, fileId: string) {
  const file = (await db.query.mediaFiles.findFirst({
    where: eq(mediaFiles.id, fileId),
    with: {
      assets: true,
      vectorRefs: true,
    },
  })) as
    | (typeof mediaFiles.$inferSelect & {
        assets: (typeof mediaAssets.$inferSelect)[]
        vectorRefs: (typeof vectorRefs.$inferSelect)[]
      })
    | undefined

  if (!file) {
    return undefined
  }

  const { assets, vectorRefs: refs, ...fileRow } = file
  return {
    file: fileRow,
    assets,
    vectorRefs: refs,
  }
}

export async function getMediaFile(db: Database, fileId: string) {
  const [row] = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, fileId), isNull(mediaFiles.deletedAt)))
    .limit(1)

  return row
}

export interface SearchMetadataFilters {
  mediaTypes?: string[]
  libraryIds?: string[]
}

export async function listSearchResultMetadata(
  db: Database,
  collectionName: string,
  pointIds: string[],
  filters: SearchMetadataFilters = {},
) {
  if (pointIds.length === 0) {
    return []
  }

  // Qdrant 只返回 point id 和 score；最终 API 结果必须回 PostgreSQL 补齐事实字段。
  // 软删除、library/media type、stale、场景 generation 一致性与模型版本都在这里兜底，
  // 避免 Qdrant payload 漏同步或重索引残留导致脏结果。
  const conditions = [
    eq(vectorRefs.collectionName, collectionName),
    inArray(vectorRefs.pointId, pointIds),
    eq(vectorRefs.status, 'indexed'),
    isNull(mediaFiles.deletedAt),
    isNull(libraries.deletedAt),
    sql`COALESCE(${mediaAssets.metadataJson}->>'stale', 'false') <> 'true'`,
    // 视频候选必须引用真实场景行（scene_id 非空）。图片资产 scene_id 为空，不受影响。
    sql`NOT (${mediaFiles.mediaType} = 'video' AND ${mediaAssets.sceneId} IS NULL)`,
    // 视频候选的场景必须属于文件当前 index_generation；LEFT JOIN 找不到场景行（已删除）
    // 或 generation 不一致都视为上一轮重索引残留，必须拒绝。
    sql`NOT (
      ${mediaFiles.mediaType} = 'video'
      AND ${mediaAssets.sceneId} IS NOT NULL
      AND ${videoScenes.indexGeneration} IS DISTINCT FROM ${mediaFiles.indexGeneration}
    )`,
    // 视频检索只接受 scene-caption-v2 的 caption，避免历史 caption-v1 与新场景 Caption 重叠。
    sql`NOT (
      ${mediaFiles.mediaType} = 'video'
      AND ${mediaAssets.assetType} = 'caption'
      AND COALESCE(${mediaAssets.metadataJson}->>'prompt_version', '') <> 'scene-caption-v2'
    )`,
  ]
  if (filters.mediaTypes?.length) {
    conditions.push(inArray(mediaFiles.mediaType, filters.mediaTypes))
  }
  if (filters.libraryIds?.length) {
    conditions.push(inArray(mediaFiles.libraryId, filters.libraryIds))
  }
  // 模型版本一致性由确定性 point_id + status='indexed' 保证：模型变化会改变 point_id 并把旧 ref
  // 重置为 pending，旧 Qdrant point 回表时找不到 indexed ref 即被拒绝，无需在此再按模型名过滤。

  return db
    .select({
      pointId: vectorRefs.pointId,
      assetId: mediaAssets.id,
      assetType: mediaAssets.assetType,
      fileId: mediaFiles.id,
      mediaType: mediaFiles.mediaType,
      path: mediaFiles.path,
      // scene_id 是正式列：视频帧/caption 引用真实 video_scenes 行，图片为 null。
      sceneId: mediaAssets.sceneId,
      startTimeSeconds: mediaAssets.startTimeSeconds,
      endTimeSeconds: mediaAssets.endTimeSeconds,
      // 视频场景边界来自 video_scenes；用于搜索结果的时间窗口与诊断展示。
      sceneStartTimeSeconds: videoScenes.startTimeSeconds,
      sceneEndTimeSeconds: videoScenes.endTimeSeconds,
      frameTimeSeconds: mediaAssets.frameTimeSeconds,
      textContent: mediaAssets.textContent,
      metadataJson: mediaAssets.metadataJson,
    })
    .from(vectorRefs)
    .innerJoin(mediaAssets, eq(vectorRefs.assetId, mediaAssets.id))
    .innerJoin(mediaFiles, eq(vectorRefs.fileId, mediaFiles.id))
    .innerJoin(libraries, eq(vectorRefs.libraryId, libraries.id))
    // LEFT JOIN：图片资产 scene_id 为 null；视频资产 scene_id 指向 video_scenes。
    .leftJoin(videoScenes, eq(mediaAssets.sceneId, videoScenes.id))
    .where(and(...conditions))
}

export async function listTextSearchResultMetadata(
  db: Database,
  input: {
    query: string
    filters?: SearchMetadataFilters
    limit: number
    offset: number
  },
) {
  // FTS 复用 media_assets.text_content：阶段 2 删除 OCR 后，全文检索只来自 text_chunk
  // （音频/视频语音转录）。使用 simple config 是当前 MVP 的可移植选择；中文分词优化留给后续阶段。
  const rank = sql<number>`ts_rank_cd(media_assets.text_tsv, plainto_tsquery('simple', ${input.query}))`
  const conditions = [
    eq(mediaAssets.assetType, 'text_chunk'),
    sql`media_assets.text_tsv @@ plainto_tsquery('simple', ${input.query})`,
    isNull(mediaFiles.deletedAt),
    isNull(libraries.deletedAt),
  ]
  if (input.filters?.mediaTypes?.length) {
    conditions.push(inArray(mediaFiles.mediaType, input.filters.mediaTypes))
  }
  if (input.filters?.libraryIds?.length) {
    conditions.push(inArray(mediaFiles.libraryId, input.filters.libraryIds))
  }

  return db
    .select({
      assetId: mediaAssets.id,
      assetType: mediaAssets.assetType,
      fileId: mediaFiles.id,
      mediaType: mediaFiles.mediaType,
      path: mediaFiles.path,
      sceneId: mediaAssets.sceneId,
      startTimeSeconds: mediaAssets.startTimeSeconds,
      endTimeSeconds: mediaAssets.endTimeSeconds,
      metadataJson: mediaAssets.metadataJson,
      score: rank,
    })
    .from(mediaAssets)
    .innerJoin(mediaFiles, eq(mediaAssets.fileId, mediaFiles.id))
    .innerJoin(libraries, eq(mediaFiles.libraryId, libraries.id))
    .where(and(...conditions))
    .orderBy(desc(rank), asc(mediaAssets.startTimeSeconds))
    .limit(input.limit)
    .offset(input.offset)
}

export async function listLibraries(db: Database) {
  return db
    .select()
    .from(libraries)
    .where(isNull(libraries.deletedAt))
    .orderBy(asc(libraries.createdAt))
}

export async function getLibrary(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.id, id), isNull(libraries.deletedAt)))
    .limit(1)

  return row
}

export async function getLibraryMediaCounts(db: Database, libraryId: string) {
  const rows = await db.select().from(mediaFiles).where(eq(mediaFiles.libraryId, libraryId))
  return {
    mediaCount: rows.length,
    indexedCount: rows.filter((row) => row.indexStatus === 'indexed').length,
    failedCount: rows.filter((row) => row.indexStatus === 'failed').length,
  }
}

export async function listLibraryMediaFiles(
  db: Database,
  input: { libraryId: string; limit: number; offset: number; query?: string },
) {
  const conditions = and(
    eq(mediaFiles.libraryId, input.libraryId),
    isNull(mediaFiles.deletedAt),
    input.query ? ilike(mediaFiles.relativePath, `%${input.query}%`) : undefined,
  )
  const [items, totalRows] = await Promise.all([
    db
      .select({
        id: mediaFiles.id,
        relativePath: mediaFiles.relativePath,
        mediaType: mediaFiles.mediaType,
        indexStatus: mediaFiles.indexStatus,
      })
      .from(mediaFiles)
      .where(conditions)
      .orderBy(asc(mediaFiles.relativePath), asc(mediaFiles.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(mediaFiles).where(conditions),
  ])
  return {
    items,
    total: Number(totalRows[0]?.total ?? 0),
  }
}

export async function updateLibraryStatus(
  db: Database,
  id: string,
  status: 'active' | 'disabled' | 'deleted',
) {
  const now = new Date()
  const [row] = await db
    .update(libraries)
    .set({
      status,
      updatedAt: now,
      deletedAt: status === 'deleted' ? now : null,
    })
    .where(eq(libraries.id, id))
    .returning()

  return row
}

export async function listJobs(db: Database, input: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const offset = Math.max(input.offset ?? 0, 0)
  const [rows, totalRows] = await Promise.all([
    db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(jobs),
  ])
  const total = Number(totalRows[0]?.total ?? 0)

  return { rows, total, limit, offset }
}

export async function resolveJobFilePaths(
  db: Database,
  rows: Array<{ id: string; inputJson: unknown }>,
) {
  const pathsByJobId = new Map<string, Set<string>>()
  const fileIdsByJobId = new Map<string, string[]>()
  const assetIdsByJobId = new Map<string, string[]>()
  const allFileIds = new Set<string>()
  const allAssetIds = new Set<string>()

  for (const row of rows) {
    const input = recordValue(row.inputJson)
    const paths = new Set<string>()

    for (const key of ['path', 'frame_path', 'root_path', 'export_path']) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) {
        paths.add(value)
      }
    }

    const fileIds: string[] = []
    if (typeof input.file_id === 'string' && input.file_id.length > 0) {
      fileIds.push(input.file_id)
      allFileIds.add(input.file_id)
    }

    const assetIds: string[] = []
    if (typeof input.asset_id === 'string' && input.asset_id.length > 0) {
      assetIds.push(input.asset_id)
      allAssetIds.add(input.asset_id)
    }
    if (Array.isArray(input.asset_ids)) {
      for (const assetId of input.asset_ids) {
        if (typeof assetId === 'string' && assetId.length > 0) {
          assetIds.push(assetId)
          allAssetIds.add(assetId)
        }
      }
    }

    pathsByJobId.set(row.id, paths)
    fileIdsByJobId.set(row.id, fileIds)
    assetIdsByJobId.set(row.id, assetIds)
  }

  const filePathById = new Map<string, string>()
  if (allFileIds.size > 0) {
    const fileRows = await db
      .select({ id: mediaFiles.id, path: mediaFiles.path })
      .from(mediaFiles)
      .where(inArray(mediaFiles.id, [...allFileIds]))
    for (const file of fileRows) {
      filePathById.set(file.id, file.path)
    }
  }

  const assetFilePathById = new Map<string, string>()
  if (allAssetIds.size > 0) {
    const assetRows = await db
      .select({ assetId: mediaAssets.id, filePath: mediaFiles.path })
      .from(mediaAssets)
      .innerJoin(mediaFiles, eq(mediaAssets.fileId, mediaFiles.id))
      .where(inArray(mediaAssets.id, [...allAssetIds]))
    for (const asset of assetRows) {
      assetFilePathById.set(asset.assetId, asset.filePath)
    }
  }

  const result = new Map<string, string[]>()
  for (const row of rows) {
    const paths = pathsByJobId.get(row.id) ?? new Set<string>()

    for (const fileId of fileIdsByJobId.get(row.id) ?? []) {
      const path = filePathById.get(fileId)
      if (path) {
        paths.add(path)
      }
    }
    for (const assetId of assetIdsByJobId.get(row.id) ?? []) {
      const path = assetFilePathById.get(assetId)
      if (path) {
        paths.add(path)
      }
    }

    result.set(row.id, [...paths])
  }

  return result
}

export async function getJob(db: Database, id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
  return row
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export async function claimNextJob(db: Database, workerId: string, now = new Date()) {
  // PostgreSQL worker claim uses an atomic status guard so concurrent workers cannot claim the same queued job.
  const [candidate] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(desc(jobs.priority), asc(jobs.createdAt))
    .limit(1)

  if (!candidate) {
    return undefined
  }

  const [claimed] = await db
    .update(jobs)
    .set({
      status: 'running',
      lockedBy: workerId,
      lockedAt: now,
      heartbeatAt: now,
      attempt: candidate.attempt + 1,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'queued')))
    .returning()

  return claimed
}

export async function reclaimStaleJobs(db: Database, now = new Date()) {
  // worker 可能崩溃或被用户停掉；heartbeat 超时后把 running job 放回 queued，
  // 让同一个 PostgreSQL 队列可以被下一个 worker 继续处理。
  const runningJobs = await db.select().from(jobs).where(eq(jobs.status, 'running'))
  const staleIds = runningJobs
    .filter((job) => {
      if (!job.heartbeatAt) {
        return true
      }
      return now.getTime() - job.heartbeatAt.getTime() > job.timeoutSeconds * 1000
    })
    .map((job) => job.id)

  for (const id of staleIds) {
    await db
      .update(jobs)
      .set({
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, id))
  }

  return staleIds.length
}

export async function markJobSucceeded(
  db: Database,
  id: string,
  resultJson: JsonValue,
  now = new Date(),
) {
  const [row] = await db
    .update(jobs)
    .set({
      status: 'succeeded',
      progress: 100,
      resultJson,
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(jobs.id, id))
    .returning()

  return row
}

export async function heartbeatJob(db: Database, id: string, now = new Date()) {
  const [row] = await db
    .update(jobs)
    .set({
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'running')))
    .returning()

  return row
}

export async function createAgentRun(db: Database, input: Pick<InsertAgentRun, 'prompt'>) {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function updateAgentRun(
  db: Database,
  id: string,
  input: Partial<Pick<InsertAgentRun, 'status' | 'summary' | 'finishedAt'>>,
  now = new Date(),
) {
  const [row] = await db
    .update(agentRuns)
    .set({
      ...input,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, id))
    .returning()

  return row
}

export async function createAgentRunEvent(
  db: Database,
  input: Pick<InsertAgentRunEvent, 'runId' | 'eventType' | 'payloadJson'> &
    Partial<Pick<InsertAgentRunEvent, 'toolCallId'>>,
) {
  const [row] = await db
    .insert(agentRunEvents)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function createAgentToolCall(
  db: Database,
  input: Pick<InsertAgentToolCall, 'runId' | 'toolCallId' | 'toolName' | 'status' | 'inputJson'> &
    Partial<Pick<InsertAgentToolCall, 'outputJson' | 'errorMessage' | 'requiresConfirmation'>>,
) {
  const [row] = await db
    .insert(agentToolCalls)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning()

  return row
}

export async function updateAgentToolCall(
  db: Database,
  runId: string,
  toolCallId: string,
  input: Partial<
    Pick<
      InsertAgentToolCall,
      'status' | 'outputJson' | 'errorMessage' | 'requiresConfirmation' | 'confirmedAt'
    >
  >,
  now = new Date(),
) {
  const [row] = await db
    .update(agentToolCalls)
    .set({
      ...input,
      updatedAt: now,
    })
    .where(and(eq(agentToolCalls.runId, runId), eq(agentToolCalls.toolCallId, toolCallId)))
    .returning()

  return row
}

export async function getAgentRunWithEventsAndTools(db: Database, id: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1)
  if (!run) {
    return undefined
  }

  const events = await db
    .select()
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, id))
    .orderBy(asc(agentRunEvents.createdAt))
  const toolCalls = await db
    .select()
    .from(agentToolCalls)
    .where(eq(agentToolCalls.runId, id))
    .orderBy(asc(agentToolCalls.createdAt))

  return { ...run, events, toolCalls }
}

export async function getAgentToolCall(db: Database, runId: string, toolCallId: string) {
  const [row] = await db
    .select()
    .from(agentToolCalls)
    .where(and(eq(agentToolCalls.runId, runId), eq(agentToolCalls.toolCallId, toolCallId)))
    .limit(1)

  return row
}

export type AgentRunRow = typeof agentRuns.$inferSelect
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect
export type AgentToolCallRow = typeof agentToolCalls.$inferSelect
