import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
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

// PostgreSQL 的 tsvector 是为全文检索准备的“词项集合”类型。Drizzle 没有内置的
// tsvector 列构造器，因此在这里声明最小映射；业务代码仍只读写 text_content，
// text_tsv 由数据库自动生成，不能由 Server 或 Python Worker 手工覆盖。
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

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
    // simple 配置不会按英语规则删除或变形词，适合中英文混合的语音转录文本。
    // 生成列与 text_content 永远在同一次数据库写入中保持一致，避免异步索引遗漏。
    textTsv: tsvector('text_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("text_content", ''))`,
    ),
    metadataJson: jsonb('metadata_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('media_assets_file_id_idx').on(table.fileId),
    index('media_assets_scene_id_idx').on(table.sceneId),
    // asset_type + file_id 是常用过滤（例如列某文件的所有 video_frame），建立复合索引。
    index('media_assets_file_type_idx').on(table.fileId, table.assetType),
    // GIN（Generalized Inverted Index，广义倒排索引）记录“词项出现在哪些行”，
    // 搜索时无需逐行扫描全部转录文本，因此媒体库增长后仍能保持可用响应速度。
    index('media_assets_text_tsv_idx').using('gin', table.textTsv),
    // 同一文件、同一时间窗只能有一个转录文本块。where 让约束只作用于 text_chunk，
    // 不会误伤时间相同但用途不同的图片、视频帧或 Caption Asset。
    uniqueIndex('media_assets_text_chunk_unique')
      .on(table.fileId, table.startTimeSeconds, table.endTimeSeconds)
      .where(sql`${table.assetType} = 'text_chunk'`),
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
    // generate_caption/export_clip 都填写）；scan_library 等多文件任务可空。
    fileId: uuid('file_id').references(() => mediaFiles.id),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // Worker 的领取顺序是 priority DESC、created_at ASC；索引方向必须完全一致，
    // 否则 PostgreSQL 在大队列中仍需额外排序后才能取得第一条任务。
    index('jobs_claim_idx').on(table.status, table.priority.desc(), table.createdAt.asc()),
    index('jobs_file_id_idx').on(table.fileId),
  ],
)

// 六张 evaluation_* 表把“可编辑查询”“一次不可变召回快照”和“人工判断”分开保存。
// 指定视频目标与候选都直接引用 video_scenes.id；不再从 metadata_json 猜测场景身份。
export const evaluationSets = pgTable('evaluation_sets', {
  id: uuid('id').primaryKey().notNull(),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
})

export const evaluationVersions = pgTable(
  'evaluation_versions',
  {
    id: uuid('id').primaryKey().notNull(),
    setId: uuid('set_id')
      .notNull()
      .references(() => evaluationSets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('evaluation_versions_set_version_unique').on(table.setId, table.version)],
)

export const evaluationQueries = pgTable(
  'evaluation_queries',
  {
    id: uuid('id').primaryKey().notNull(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => evaluationVersions.id, { onDelete: 'cascade' }),
    queryText: text('query_text').notNull(),
    queryType: text('query_type').notNull(),
    intentCategory: text('intent_category').notNull(),
    mustHaveJson: jsonb('must_have_json').notNull().default([]),
    optionalJson: jsonb('optional_json').notNull().default([]),
    exclusionsJson: jsonb('exclusions_json').notNull().default([]),
    // 冻结版本保留目标 UUID；不以外键阻塞后续媒体重索引删除，创建查询时显式校验。
    targetFileId: uuid('target_file_id'),
    targetSceneId: uuid('target_scene_id'),
    // 图片的 RRF 语义身份是 Asset UUID，因此在查询创建时冻结，不能在报告阶段重新查询。
    targetAssetId: uuid('target_asset_id'),
    ...timestamps,
  },
  (table) => [index('evaluation_queries_version_idx').on(table.versionId)],
)

export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => evaluationVersions.id),
    status: text('status').notNull().default('pending'),
    libraryIdsJson: jsonb('library_ids_json').notNull().default([]),
    configJson: jsonb('config_json').notNull(),
    corpusJson: jsonb('corpus_json').notNull().default({}),
    reportJson: jsonb('report_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('evaluation_runs_version_idx').on(table.versionId)],
)

export const evaluationCandidates = pgTable(
  'evaluation_candidates',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id')
      .notNull()
      .references(() => evaluationQueries.id, { onDelete: 'cascade' }),
    candidateKey: text('candidate_key').notNull(),
    // 快照只保存当时的 UUID，不建立到可重索引媒体表的外键。否则清理旧 Asset/Scene
    // 会被历史评测阻塞；写快照前仍由 EvaluationService 显式验证身份与 generation。
    assetId: uuid('asset_id').notNull(),
    fileId: uuid('file_id').notNull(),
    sceneId: uuid('scene_id'),
    fileGeneration: integer('file_generation').notNull(),
    mediaType: text('media_type').notNull(),
    startTimeSeconds: numeric('start_time_seconds'),
    endTimeSeconds: numeric('end_time_seconds'),
    sourceEvidenceJson: jsonb('source_evidence_json').notNull().default([]),
    currentRank: integer('current_rank'),
    rrfRank: integer('rrf_rank'),
    blindOrder: integer('blind_order').notNull(),
    labelStatus: text('label_status').notNull().default('pending'),
    primaryPool: boolean('primary_pool').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('evaluation_candidates_run_query_key_unique').on(
      table.runId,
      table.queryId,
      table.candidateKey,
    ),
    index('evaluation_candidates_run_idx').on(table.runId),
  ],
)

export const evaluationJudgments = pgTable(
  'evaluation_judgments',
  {
    id: uuid('id').primaryKey().notNull(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => evaluationCandidates.id, { onDelete: 'cascade' }),
    relevance: integer('relevance'),
    unjudgeable: boolean('unjudgeable').notNull().default(false),
    diagnosisJson: jsonb('diagnosis_json'),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [uniqueIndex('evaluation_judgments_candidate_unique').on(table.candidateId)],
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
