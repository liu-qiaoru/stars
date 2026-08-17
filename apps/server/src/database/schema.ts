import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
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
    // Phase E 只允许人工冻结为 visual 的查询外发图像。旧评测行保持 null，
    // 不从查询文本或 AgentIntent 猜测范围，避免意外扩大隐私授权。
    searchScope: text('search_scope'),
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

// Phase F 先保存“待用户审核的 60 对建议”，再单独保存条件级人工真值。
// 建议组别不是标签；candidate_review 状态下禁止调用 VLM，也不产生 passed/rejected。
export const evaluationVlmBlindDatasets = pgTable(
  'evaluation_vlm_blind_datasets',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull().default('candidate_review'),
    targetCaseCount: integer('target_case_count').notNull().default(60),
    proposalFingerprint: text('proposal_fingerprint').notNull(),
    frozenFingerprint: text('frozen_fingerprint'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // 指纹是整份 60 对建议包的内容身份。数据库唯一索引是并发导入的
    // 最终防线：单凭“先 SELECT 再 INSERT”会让两个 Server 同时各写一份。
    uniqueIndex('evaluation_vlm_blind_datasets_proposal_fingerprint_unique').on(
      table.proposalFingerprint,
    ),
  ],
)

export const evaluationVlmBlindCases = pgTable(
  'evaluation_vlm_blind_cases',
  {
    id: uuid('id').primaryKey().notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evaluationVlmBlindDatasets.id, { onDelete: 'cascade' }),
    proposalId: text('proposal_id').notNull(),
    sourceEvaluationRunId: uuid('source_evaluation_run_id').notNull(),
    sourceCandidateId: uuid('source_candidate_id').notNull(),
    // 替代案例使用新行保存，并指向被用户拒绝的上一代案例。旧行永远不改回 pending，
    // 因而人工拒绝、备注和时间仍可审计；null 表示最初导入的 60 条建议。
    replacesCaseId: uuid('replaces_case_id').references(
      (): AnyPgColumn => evaluationVlmBlindCases.id,
      { onDelete: 'restrict' },
    ),
    queryText: text('query_text').notNull(),
    candidateKey: text('candidate_key').notNull(),
    fileId: uuid('file_id').notNull(),
    sceneId: uuid('scene_id').notNull(),
    startTimeSeconds: numeric('start_time_seconds').notNull(),
    endTimeSeconds: numeric('end_time_seconds').notNull(),
    proposedGroup: text('proposed_group').notNull(),
    reviewedGroup: text('reviewed_group'),
    reviewStatus: text('review_status').notNull().default('pending'),
    selectionBasis: text('selection_basis').notNull(),
    reviewNotes: text('review_notes'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_cases_dataset_proposal_unique').on(
      table.datasetId,
      table.proposalId,
    ),
    uniqueIndex('evaluation_vlm_blind_cases_dataset_candidate_unique').on(
      table.datasetId,
      table.sourceCandidateId,
    ),
    // 一条被拒案例至多拥有一个直接后继。重复点击生成接口会复用现状，
    // 并发请求也由数据库唯一约束阻止生成两条替代链分支。
    uniqueIndex('evaluation_vlm_blind_cases_replaces_unique').on(table.replacesCaseId),
    index('evaluation_vlm_blind_cases_dataset_status_idx').on(table.datasetId, table.reviewStatus),
  ],
)

export const evaluationVlmBlindConditions = pgTable(
  'evaluation_vlm_blind_conditions',
  {
    id: uuid('id').primaryKey().notNull(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evaluationVlmBlindCases.id, { onDelete: 'cascade' }),
    conditionId: text('condition_id').notNull(),
    kind: text('kind').notNull(),
    sourceText: text('source_text').notNull(),
    ordinal: integer('ordinal').notNull(),
    // uncertain 必须由第二人复核；冻结前 Service 会要求 final_verdict 明确写入。
    firstVerdict: text('first_verdict'),
    secondVerdict: text('second_verdict'),
    finalVerdict: text('final_verdict'),
    labelNotes: text('label_notes'),
    firstLabeledAt: timestamp('first_labeled_at', { withTimezone: true }),
    secondLabeledAt: timestamp('second_labeled_at', { withTimezone: true }),
    finalLabeledAt: timestamp('final_labeled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_conditions_case_condition_unique').on(
      table.caseId,
      table.conditionId,
    ),
    uniqueIndex('evaluation_vlm_blind_conditions_case_ordinal_unique').on(
      table.caseId,
      table.ordinal,
    ),
  ],
)

// 候选 dataset 的 frozen 状态只表达“60 对身份不可变”。人工条件标签拥有独立会话，
// 避免为了显示标注进度而把候选状态改回可编辑，或把候选冻结误报成人工真值冻结。
export const evaluationVlmBlindLabelingSessions = pgTable(
  'evaluation_vlm_blind_labeling_sessions',
  {
    id: uuid('id').primaryKey().notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evaluationVlmBlindDatasets.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('labeling'),
    labelsFingerprint: text('labels_fingerprint'),
    labelsFrozenAt: timestamp('labels_frozen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_labeling_sessions_dataset_unique').on(table.datasetId),
  ],
)

// fake 演练与人工标签分开持久化。一个已冻结标签会话只生成一份演练身份；重复 POST
// 读取同一结果，不会把本地协议测试伪装成新的模型调用或累计费用。
export const evaluationVlmBlindFakeRuns = pgTable(
  'evaluation_vlm_blind_fake_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    labelingSessionId: uuid('labeling_session_id')
      .notNull()
      .references(() => evaluationVlmBlindLabelingSessions.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    provider: text('provider').notNull().default('fake'),
    protocolVersion: text('protocol_version').notNull().default('vlm-review-v1'),
    caseCount: integer('case_count').notNull().default(0),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    notApplicableCount: integer('not_applicable_count').notNull().default(0),
    externalCallCount: integer('external_call_count').notNull().default(0),
    metricsJson: jsonb('metrics_json'),
    errorJson: jsonb('error_json'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_fake_runs_session_unique').on(table.labelingSessionId),
  ],
)

export const evaluationVlmBlindFakeResults = pgTable(
  'evaluation_vlm_blind_fake_results',
  {
    id: uuid('id').primaryKey().notNull(),
    fakeRunId: uuid('fake_run_id')
      .notNull()
      .references(() => evaluationVlmBlindFakeRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evaluationVlmBlindCases.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    outputJson: jsonb('output_json'),
    errorJson: jsonb('error_json'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_fake_results_run_case_unique').on(
      table.fakeRunId,
      table.caseId,
    ),
  ],
)

// 独立视觉授权绑定 dataset、人工标签和证据三份指纹。它只授权一次 Phase F 能力盲测，
// 不会因为 AgentIntent 文本执行已开启而自动存在，也不保存 API Key。
export const evaluationVlmBlindVisualAuthorizations = pgTable(
  'evaluation_vlm_blind_visual_authorizations',
  {
    id: uuid('id').primaryKey().notNull(),
    labelingSessionId: uuid('labeling_session_id')
      .notNull()
      .references(() => evaluationVlmBlindLabelingSessions.id, { onDelete: 'cascade' }),
    datasetFingerprint: text('dataset_fingerprint').notNull(),
    labelsFingerprint: text('labels_fingerprint').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    preflightFingerprint: text('preflight_fingerprint').notNull(),
    maxCalls: integer('max_calls').notNull(),
    maxCostCny: numeric('max_cost_cny').notNull(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_visual_authorizations_preflight_unique').on(
      table.preflightFingerprint,
    ),
    index('evaluation_vlm_blind_visual_authorizations_session_idx').on(table.labelingSessionId),
  ],
)

// 真实能力盲测与 fake run 永久分表。父 run 冻结本次协议、指纹、预算和汇总指标；
// 打开历史页面只读这些列，不会重新构造请求或调用 Provider。
export const evaluationVlmBlindRealRuns = pgTable(
  'evaluation_vlm_blind_real_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    labelingSessionId: uuid('labeling_session_id')
      .notNull()
      .references(() => evaluationVlmBlindLabelingSessions.id, { onDelete: 'restrict' }),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => evaluationVlmBlindVisualAuthorizations.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('pending'),
    provider: text('provider').notNull().default('rightapi'),
    requestedModel: text('requested_model').notNull().default('qwen3.7-plus'),
    protocolVersion: text('protocol_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    datasetFingerprint: text('dataset_fingerprint').notNull(),
    labelsFingerprint: text('labels_fingerprint').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    caseCount: integer('case_count').notNull(),
    plannedCallCount: integer('planned_call_count').notNull(),
    externalCallCount: integer('external_call_count').notNull().default(0),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    unknownCount: integer('unknown_count').notNull().default(0),
    maxCalls: integer('max_calls').notNull(),
    maxCostCny: numeric('max_cost_cny').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    billedCostCny: numeric('billed_cost_cny'),
    metricsJson: jsonb('metrics_json'),
    errorJson: jsonb('error_json'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_real_runs_authorization_unique').on(table.authorizationId),
    index('evaluation_vlm_blind_real_runs_session_idx').on(table.labelingSessionId),
  ],
)

// 每个计划槽位拥有稳定 repetition；显式 retry-unknown 用更高 attempt_number 新建行，
// 从不覆盖原 dispatched attempt。step_attempt_id 是外部副作用的恢复身份。
export const evaluationVlmBlindRealAttempts = pgTable(
  'evaluation_vlm_blind_real_attempts',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evaluationVlmBlindRealRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evaluationVlmBlindCases.id, { onDelete: 'restrict' }),
    repetition: integer('repetition').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    retryOfAttemptId: uuid('retry_of_attempt_id').references(
      (): AnyPgColumn => evaluationVlmBlindRealAttempts.id,
      { onDelete: 'restrict' },
    ),
    stepAttemptId: uuid('step_attempt_id').notNull(),
    status: text('status').notNull().default('pending'),
    externalCallStatus: text('external_call_status').notNull().default('not_dispatched'),
    requestFingerprint: text('request_fingerprint'),
    responseFingerprint: text('response_fingerprint'),
    responseModel: text('response_model'),
    providerRequestId: text('provider_request_id'),
    requestBytes: integer('request_bytes'),
    imageCount: integer('image_count'),
    actualSampleCount: integer('actual_sample_count'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    billedCostCny: numeric('billed_cost_cny'),
    derivedStatus: text('derived_status'),
    errorJson: jsonb('error_json'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    latencyMs: integer('latency_ms'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_vlm_blind_real_attempts_slot_unique').on(
      table.runId,
      table.caseId,
      table.repetition,
      table.attemptNumber,
    ),
    uniqueIndex('evaluation_vlm_blind_real_attempts_step_unique').on(table.stepAttemptId),
    index('evaluation_vlm_blind_real_attempts_run_status_idx').on(table.runId, table.status),
  ],
)

export const evaluationVlmBlindRealResults = pgTable(
  'evaluation_vlm_blind_real_results',
  {
    id: uuid('id').primaryKey().notNull(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => evaluationVlmBlindRealAttempts.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evaluationVlmBlindCases.id, { onDelete: 'restrict' }),
    derivedStatus: text('derived_status').notNull(),
    outputJson: jsonb('output_json'),
    errorJson: jsonb('error_json'),
    ...timestamps,
  },
  (table) => [uniqueIndex('evaluation_vlm_blind_real_results_attempt_unique').on(table.attemptId)],
)

// Phase E 的影子重排事实与普通 evaluation_runs 分离：普通 Search/RRF 快照不可变，
// 影子失败也只能影响本表状态，绝不能回写 production candidate rank。
export const evaluationShadowRuns = pgTable(
  'evaluation_shadow_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    evaluationRunId: uuid('evaluation_run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    protocolVersion: text('protocol_version').notNull(),
    // 同一冻结 Evaluation 可以显式重跑，但每次真实外发必须拥有独立 run/attempt，
    // 这样第二次 smoke 不会覆盖第一次 request ID、指纹、错误和人工用量核对。
    executionNumber: integer('execution_number').notNull().default(1),
    status: text('status').notNull().default('pending'),
    provider: text('provider').notNull().default('dashscope'),
    requestedModel: text('requested_model').notNull().default('qwen3-vl-rerank'),
    responseModel: text('response_model'),
    modelSnapshot: text('model_snapshot'),
    region: text('region'),
    queryCount: integer('query_count').notNull().default(0),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    notApplicableCount: integer('not_applicable_count').notNull().default(0),
    actualSampleCount: integer('actual_sample_count').notNull().default(0),
    requestBytes: bigint('request_bytes', { mode: 'number' }).notNull().default(0),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    billedCostCny: numeric('billed_cost_cny'),
    estimatedCostCny: numeric('estimated_cost_cny'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorDetailsJson: jsonb('error_details_json'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('evaluation_shadow_runs_identity_unique').on(
      table.evaluationRunId,
      table.protocolVersion,
      table.executionNumber,
    ),
    index('evaluation_shadow_runs_status_idx').on(table.status, table.createdAt),
  ],
)

// 每条冻结视觉查询只有一个 Provider 尝试。dispatched 先于网络调用提交；Server 重启发现
// dispatched 且未 completed 时只写 outcome_unknown，禁止自动重放并产生第二次费用。
export const evaluationShadowAttempts = pgTable(
  'evaluation_shadow_attempts',
  {
    id: uuid('id').primaryKey().notNull(),
    shadowRunId: uuid('shadow_run_id')
      .notNull()
      .references(() => evaluationShadowRuns.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id')
      .notNull()
      .references(() => evaluationQueries.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'),
    externalCallStatus: text('external_call_status').notNull().default('not_dispatched'),
    providerRequestId: text('provider_request_id'),
    responseModel: text('response_model'),
    modelSnapshot: text('model_snapshot'),
    region: text('region'),
    queryFingerprint: text('query_fingerprint'),
    evidenceFingerprint: text('evidence_fingerprint'),
    responseFingerprint: text('response_fingerprint'),
    requestBytes: bigint('request_bytes', { mode: 'number' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    billedCostCny: numeric('billed_cost_cny'),
    estimatedCostCny: numeric('estimated_cost_cny'),
    actualCandidateCount: integer('actual_candidate_count').notNull().default(0),
    actualResultCount: integer('actual_result_count').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorDetailsJson: jsonb('error_details_json'),
    notApplicableReason: text('not_applicable_reason'),
    ...timestamps,
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('evaluation_shadow_attempts_query_unique').on(table.shadowRunId, table.queryId),
    uniqueIndex('evaluation_shadow_attempts_idempotency_unique').on(table.idempotencyKey),
    index('evaluation_shadow_attempts_status_idx').on(table.status, table.createdAt),
  ],
)

// Provider 响应未通过 Schema 时，API 返回的 token 必须保持 null。若维护者随后从阿里云
// 模型监控核对到用量，则在独立的一对一事实中记录来源和分项，既能恢复预算判断，也不会
// 把人工核对值冒充为 Provider 响应字段。
export const evaluationShadowUsageReconciliations = pgTable(
  'evaluation_shadow_usage_reconciliations',
  {
    id: uuid('id').primaryKey().notNull(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => evaluationShadowAttempts.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    providerRequestId: text('provider_request_id').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    textInputTokens: integer('text_input_tokens').notNull(),
    imageInputTokens: integer('image_input_tokens').notNull(),
    estimatedCostCny: numeric('estimated_cost_cny').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('evaluation_shadow_usage_reconciliations_attempt_unique').on(table.attemptId),
  ],
)

// 保存完整 20 个输入候选：Top-10 有 shadow_rank/score，其余保持 null。这样可以证明模型
// 没有改变或删除普通 RRF 候选，也能审计 Provider 是否漏项、重复或返回非法 index。
export const evaluationShadowRankings = pgTable(
  'evaluation_shadow_rankings',
  {
    id: uuid('id').primaryKey().notNull(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => evaluationShadowAttempts.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => evaluationCandidates.id, { onDelete: 'cascade' }),
    candidateKey: text('candidate_key').notNull(),
    rrfRank: integer('rrf_rank').notNull(),
    shadowRank: integer('shadow_rank'),
    relevanceScore: numeric('relevance_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('evaluation_shadow_rankings_candidate_unique').on(
      table.attemptId,
      table.candidateId,
    ),
    uniqueIndex('evaluation_shadow_rankings_rank_unique').on(table.attemptId, table.shadowRank),
    index('evaluation_shadow_rankings_attempt_idx').on(table.attemptId, table.rrfRank),
  ],
)

// agent_runs 是 Agent V1 恢复状态机的主事实。它不复用 Python jobs 队列：
// NestJS Server 用限时租约领取 run，Python Worker 仍只执行媒体重任务。
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().notNull(),
    status: text('status').notNull().default('queued'),
    prompt: text('prompt').notNull(),
    summary: text('summary'),
    // queued 或已提交一步的 run 必须明确记住下一个固定步骤，
    // 恢复时不能依赖 Provider 原始对话去猜“接下来做什么”。
    nextStep: text('next_step').notNull().default('extracting_intent'),
    enforcedScopeJson: jsonb('enforced_scope_json').notNull().default({}),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    // lease_version 是单调递增的 Fencing Token（隔离旧持有者的令牌）。
    // 结果提交必须同时匹配 owner + version + status，否则迟到写入更新 0 行。
    leaseVersion: integer('lease_version').notNull().default(0),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    currentStepAttemptId: uuid('current_step_attempt_id'),
    externalCallStatus: text('external_call_status'),
    waitingStepId: uuid('waiting_step_id'),
    waitingExpiresAt: timestamp('waiting_expires_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    cancelReason: text('cancel_reason'),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // 执行器先按状态和最早可领取时间找候选，再用条件 UPDATE 争抢唯一租约。
    index('agent_runs_claim_idx').on(table.status, table.nextAttemptAt, table.createdAt),
    index('agent_runs_waiting_expiry_idx').on(table.status, table.waitingExpiresAt),
  ],
)

// 文本与视觉授权按 run 分开保存。同一个 Provider/模型也不能让“可发 prompt”
// 自动扩大为“可发候选图片”，更不能把一次 run 的授权复用到下一次。
export const agentRunAuthorizations = pgTable(
  'agent_run_authorizations',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    allowExternalText: boolean('allow_external_text').notNull().default(false),
    allowExternalVisual: boolean('allow_external_visual').notNull().default(false),
    textScopeJson: jsonb('text_scope_json').notNull().default({}),
    visualScopeJson: jsonb('visual_scope_json').notNull().default({}),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agent_run_authorizations_run_unique').on(table.runId)],
)

// 每次成功领取都创建新的 step_attempt_id。外部调用前先把 dispatched 提交到这张表，
// 因此 Server 崩溃后能区分“尚未发出，可重试”和“已发出但结果不明，不可自动重放”。
export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepAttemptId: uuid('step_attempt_id').notNull(),
    stepKind: text('step_kind').notNull(),
    status: text('status').notNull(),
    inputFingerprint: text('input_fingerprint'),
    inputJson: jsonb('input_json').notNull().default({}),
    outputJson: jsonb('output_json'),
    externalCallStatus: text('external_call_status').notNull().default('not_dispatched'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agent_run_steps_attempt_unique').on(table.stepAttemptId),
    index('agent_run_steps_run_idx').on(table.runId, table.createdAt),
  ],
)

// resume/retry 输入使用 (run_id, client_request_id) 唯一约束作为数据库级幂等边界。
export const agentRunInputs = pgTable(
  'agent_run_inputs',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    waitingStepId: uuid('waiting_step_id'),
    stepAttemptId: uuid('step_attempt_id'),
    clientRequestId: text('client_request_id').notNull(),
    inputType: text('input_type').notNull(),
    responseJson: jsonb('response_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_run_inputs_client_request_unique').on(table.runId, table.clientRequestId),
    index('agent_run_inputs_run_idx').on(table.runId, table.createdAt),
  ],
)

// Phase C 才会创建导出副作用；Phase A 先用唯一 effect_key 冻结幂等事实边界。
export const agentSideEffects = pgTable(
  'agent_side_effects',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    effectKey: text('effect_key').notNull(),
    toolCallId: text('tool_call_id'),
    status: text('status').notNull().default('pending'),
    jobId: uuid('job_id').references(() => jobs.id),
    confirmationJson: jsonb('confirmation_json'),
    ...timestamps,
  },
  (table) => [uniqueIndex('agent_side_effects_run_effect_unique').on(table.runId, table.effectKey)],
)

// 检索后冻结候选身份，后续选择/确认将用 file_generation 拒绝过期候选。
// Phase A 只建立数据库协议，Phase B 才会在一次原文检索后写入候选。
export const agentRunCandidates = pgTable(
  'agent_run_candidates',
  {
    id: uuid('id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    candidateKey: text('candidate_key').notNull(),
    fileId: uuid('file_id').notNull(),
    fileGeneration: integer('file_generation').notNull(),
    assetId: uuid('asset_id').notNull(),
    sceneId: uuid('scene_id'),
    sceneStartSeconds: numeric('scene_start_seconds'),
    sceneEndSeconds: numeric('scene_end_seconds'),
    rank: integer('rank').notNull(),
    retrievalJson: jsonb('retrieval_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_run_candidates_run_key_unique').on(table.runId, table.candidateKey),
    index('agent_run_candidates_run_rank_idx').on(table.runId, table.rank),
  ],
)

// Candidate Evidence（候选证据）是 Phase D 的长期业务事实，不只存在 jobs.result_json。
// Server 用 source_type/source_id 证明候选来自哪个冻结快照；Python Worker 只写本地派生
// 文件和 manifest。artifact_path 永不进入普通 API，浏览器只能经受控 artifact 路由读取。
export const candidateEvidence = pgTable(
  'candidate_evidence',
  {
    id: uuid('id').primaryKey().notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    candidateKey: text('candidate_key').notNull(),
    fileId: uuid('file_id').notNull(),
    fileGeneration: integer('file_generation').notNull(),
    assetId: uuid('asset_id').notNull(),
    sceneId: uuid('scene_id').notNull(),
    strategy: text('strategy').notNull(),
    protocolVersion: text('protocol_version').notNull(),
    status: text('status').notNull().default('queued'),
    jobId: uuid('job_id').references(() => jobs.id),
    manifestJson: jsonb('manifest_json'),
    inputSha256: text('input_sha256'),
    artifactSha256: text('artifact_sha256'),
    artifactPath: text('artifact_path'),
    artifactMimeType: text('artifact_mime_type'),
    artifactWidth: integer('artifact_width'),
    artifactHeight: integer('artifact_height'),
    artifactByteSize: bigint('artifact_byte_size', { mode: 'number' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorDetailsJson: jsonb('error_details_json'),
    retentionClass: text('retention_class').notNull().default('cache_24h'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    ...timestamps,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('candidate_evidence_identity_unique').on(
      table.sourceType,
      table.sourceId,
      table.candidateKey,
      table.fileGeneration,
      table.strategy,
      table.protocolVersion,
    ),
    index('candidate_evidence_job_idx').on(table.jobId),
    index('candidate_evidence_expiry_idx').on(table.retentionClass, table.expiresAt),
  ],
)

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
  authorizations: many(agentRunAuthorizations),
  steps: many(agentRunSteps),
  inputs: many(agentRunInputs),
  sideEffects: many(agentSideEffects),
  candidates: many(agentRunCandidates),
}))
