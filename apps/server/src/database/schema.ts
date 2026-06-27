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

// libraries/media_files/media_assets 是 PostgreSQL 事实来源。
// 原始文件留在用户磁盘；数据库只保存路径、派生资产、文本/OCR/transcript 和索引状态。
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
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('media_files_library_path_unique').on(table.libraryId, table.path),
    index('media_files_library_id_idx').on(table.libraryId),
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
    startTimeSeconds: numeric('start_time_seconds'),
    endTimeSeconds: numeric('end_time_seconds'),
    frameTimeSeconds: numeric('frame_time_seconds'),
    contentHash: text('content_hash'),
    textContent: text('text_content'),
    metadataJson: jsonb('metadata_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('media_assets_file_id_idx').on(table.fileId)],
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
    errorMessage: text('error_message'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('jobs_claim_idx').on(table.status, table.priority, table.createdAt)],
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
  vectorRefs: many(vectorRefs),
}))

export const mediaAssetsRelations = relations(mediaAssets, ({ one, many }) => ({
  file: one(mediaFiles, {
    fields: [mediaAssets.fileId],
    references: [mediaFiles.id],
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
