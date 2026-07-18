import { relations } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

// libraries/media_files/media_assets/video_scenes 是 PostgreSQL 事实来源。
// 原始文件留在用户磁盘；数据库只保存路径、派生资产（图片/视频帧/转录文本/Caption）、
// 视频场景身份与时间边界、向量引用和索引状态。OCR 能力已在阶段 2 删除，不再有 OCR 文本。
export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    status: text('status').notNull().default('active'),
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('libraries_root_path_unique').on(table.rootPath)],
)

export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().notNull(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    relativePath: text('relative_path').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull(),
    contentHash: text('content_hash'),
    indexStatus: text('index_status').notNull().default('pending'),
    durationSeconds: numeric('duration_seconds'),
    width: integer('width'),
    height: integer('height'),
    codec: text('codec'),
    // index_generation 在破坏性重索引（阶段 3 的 purge_video_index）时递增，用于识别异步搜索
    // 校验期间发生的重索引；阶段 2 先建列并默认 0，递增逻辑在阶段 3 实现。
    indexGeneration: integer('index_generation').notNull().default(0),
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('media_files_library_path_unique').on(table.libraryId, table.path),
    index('media_files_library_id_idx').on(table.libraryId),
  ],
)

// video_scenes 保存视频场景的身份与时间边界。它是视频帧/视频 Caption 引用的正式来源，
// 取代旧的 asset_type='video_segment' + metadata_json.scene_id 做法。Qdrant 中不存在
// 场景本身的向量 Point，只按 scene_id 分组检索帧向量。删除文件会级联删除其全部场景。
export const videoScenes = pgTable(
  'video_scenes',
  {
    id: uuid('id').primaryKey().notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    sceneKey: text('scene_key').notNull(),
    // 时间列沿用 numeric（与 media_assets 的秒数字段一致），避免精确数值与浮点混用。
    startTimeSeconds: numeric('start_time_seconds').notNull(),
    endTimeSeconds: numeric('end_time_seconds').notNull(),
    detectionStrategy: text('detection_strategy').notNull(),
    strategyFingerprint: text('strategy_fingerprint').notNull(),
    indexGeneration: integer('index_generation').notNull(),
    ...timestamps,
  },
  (table) => [
    // 同一文件在同一 generation 下场景键唯一；重索引产生新 generation 时旧场景可被清理。
    uniqueIndex('video_scenes_file_key_generation_unique').on(
      table.fileId,
      table.sceneKey,
      table.indexGeneration,
    ),
    index('video_scenes_file_id_idx').on(table.fileId),
  ],
)

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    assetType: text('asset_type').notNull(),
    path: text('path'),
    // scene_id 是正式外键：视频帧与视频 Caption 必须引用真实 video_scenes 行；
    // 图片、图片 Caption 和纯音频转录 text_chunk 可为空。Qdrant Payload 冗余保存同一
    // scene_id 只用于分组与诊断，最终事实以本列为准。
    sceneId: uuid('scene_id').references(() => videoScenes.id, { onDelete: 'cascade' }),
    startTimeSeconds: numeric('start_time_seconds'),
    endTimeSeconds: numeric('end_time_seconds'),
    frameTimeSeconds: numeric('frame_time_seconds'),
    contentHash: text('content_hash'),
    textContent: text('text_content'),
    metadataJson: jsonb('metadata_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('media_assets_file_id_idx').on(table.fileId),
    index('media_assets_scene_id_idx').on(table.sceneId),
    // asset_type + file_id 是常用过滤（例如列某文件的所有 video_frame），建立复合索引。
    index('media_assets_file_type_idx').on(table.fileId, table.assetType),
  ],
)

// vector_refs 是 PostgreSQL 与 Qdrant 的桥。Qdrant point 只负责向量召回，
// 命中后必须通过这里回表补齐 path、时间范围、软删除和 library 过滤。
export const vectorRefs = pgTable(
  'vector_refs',
  {
    id: uuid('id').primaryKey().notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    collectionName: text('collection_name').notNull(),
    pointId: uuid('point_id').notNull(),
    modelName: text('model_name').notNull(),
    modelVersion: text('model_version').notNull(),
    vectorKind: text('vector_kind').notNull(),
    vectorDim: integer('vector_dim').notNull(),
    distance: text('distance').notNull(),
    contentHash: text('content_hash').notNull(),
    indexProfile: text('index_profile').notNull(),
    status: text('status').notNull().default('pending'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('vector_refs_collection_point_unique').on(table.collectionName, table.pointId),
    index('vector_refs_asset_id_idx').on(table.assetId),
    index('vector_refs_file_id_idx').on(table.fileId),
    index('vector_refs_library_id_idx').on(table.libraryId),
    // 协调器按 collection + pending 状态批量寻找待嵌入 ref，是热路径过滤条件。
    index('vector_refs_collection_status_idx').on(table.collectionName, table.status),
  ],
)

// jobs 是跨语言队列：NestJS 创建/查询任务，Python worker claim 并执行媒体重任务。
// 不引入 Celery/BullMQ，是为了让本地 MVP 的任务状态和事实数据都留在 PostgreSQL。
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().notNull(),
    jobType: text('job_type').notNull(),
    status: text('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    timeoutSeconds: integer('timeout_seconds').notNull().default(3600),
    progress: integer('progress').notNull().default(0),
    inputJson: jsonb('input_json').notNull(),
    resultJson: jsonb('result_json'),
    // errorMessage 是给用户看的简短错误；error_code/error_details_json 给出机器可读的
    // 结构化错误码和技术诊断（阶段 2 起场景检测失败等确定性错误使用）。
    errorMessage: text('error_message'),
    errorCode: text('error_code'),
    errorDetailsJson: jsonb('error_details_json'),
    // file_id 是单文件媒体任务的正式外键（index_media/embed_*/transcribe_audio/
    // generate_caption/export_clip 都填写）；scan_library 等多文件任务可空。阶段 9 的
    // verify_multi_frame_search 涉及多文件，候选仍保存在 input_json 而非本列。
    fileId: uuid('file_id').references(() => mediaFiles.id),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_claim_idx').on(table.status, table.priority, table.createdAt),
    index('jobs_file_id_idx').on(table.fileId),
  ],
)

// agent_* 表保存一次 Agent 运行的 prompt、事件流和工具调用审计。
// 有副作用的 tool 会先进入 waiting_for_confirmation，确认后再创建真正的 job。
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().notNull(),
  status: text('status').notNull().default('running'),
  prompt: text('prompt').notNull(),
  summary: text('summary'),
  ...timestamps,
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    toolCallId: text('tool_call_id'),
    payloadJson: jsonb('payload_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_run_events_run_id_idx').on(table.runId)],
)

export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    status: text('status').notNull(),
    inputJson: jsonb('input_json').notNull().default({}),
    outputJson: jsonb('output_json'),
    errorMessage: text('error_message'),
    requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agent_tool_calls_run_tool_call_unique').on(table.runId, table.toolCallId),
  ],
)

export const librariesRelations = relations(libraries, ({ many }) => ({
  mediaFiles: many(mediaFiles),
  vectorRefs: many(vectorRefs),
}))

export const mediaFilesRelations = relations(mediaFiles, ({ one, many }) => ({
  library: one(libraries, {
    fields: [mediaFiles.libraryId],
    references: [libraries.id],
  }),
  assets: many(mediaAssets),
  videoScenes: many(videoScenes),
  vectorRefs: many(vectorRefs),
}))

export const videoScenesRelations = relations(videoScenes, ({ one, many }) => ({
  file: one(mediaFiles, {
    fields: [videoScenes.fileId],
    references: [mediaFiles.id],
  }),
  assets: many(mediaAssets),
}))

export const mediaAssetsRelations = relations(mediaAssets, ({ one, many }) => ({
  file: one(mediaFiles, {
    fields: [mediaAssets.fileId],
    references: [mediaFiles.id],
  }),
  scene: one(videoScenes, {
    fields: [mediaAssets.sceneId],
    references: [videoScenes.id],
  }),
  vectorRefs: many(vectorRefs),
}))

export const vectorRefsRelations = relations(vectorRefs, ({ one }) => ({
  asset: one(mediaAssets, {
    fields: [vectorRefs.assetId],
    references: [mediaAssets.id],
  }),
  file: one(mediaFiles, {
    fields: [vectorRefs.fileId],
    references: [mediaFiles.id],
  }),
  library: one(libraries, {
    fields: [vectorRefs.libraryId],
    references: [libraries.id],
  }),
}))

export const agentRunsRelations = relations(agentRuns, ({ many }) => ({
  events: many(agentRunEvents),
  toolCalls: many(agentToolCalls),
}))
