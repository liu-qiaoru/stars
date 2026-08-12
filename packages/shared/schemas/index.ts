import { z } from 'zod'
import { indexProfiles, jobTypes, mediaTypes, vectorCollectionNames } from '../constants/index.js'

const uuidSchema = z.string().uuid()
const nonNegativeIntegerSchema = z.number().int().min(0)
const positiveNumberSchema = z.number().positive()
const nonNegativeNumberSchema = z.number().min(0)
const collectionSchema = z.enum(vectorCollectionNames)
const indexProfileSchema = z.enum(indexProfiles)

/**
 * 使用 Unicode code point（字符代码点）计数，避免 JavaScript 把一个表情符号算成两个字符。
 * Agent 协议的长度上限是隐私、成本和数据库边界，因此不能静默截断。
 */
function unicodeStringSchema(fieldName: string, maximum: number) {
  return z
    .string()
    .min(1)
    .refine((value) => [...value].length <= maximum, {
      message: `${fieldName} must contain at most ${maximum} Unicode characters`,
    })
}

// Agent V1 是 Server 控制的固定状态机。模型输出和 API 输入都只能使用这些状态，
// 不能自造“思考中”或跳过等待授权边界的状态。
export const agentRunStatusSchema = z.enum([
  'queued',
  'extracting_intent',
  'waiting_for_user_input',
  'searching',
  'waiting_for_export_selection',
  'waiting_for_confirmation',
  'succeeded',
  'failed',
  'timed_out',
  'completed_with_errors',
  'cancel_requested',
  'cancelled',
  'expired',
  'outcome_unknown',
])

export const agentNextStepSchema = z.enum(['extracting_intent', 'searching'])
export const agentExternalCallStatusSchema = z.enum([
  'not_dispatched',
  'dispatched',
  'completed',
  'outcome_unknown',
])

const agentConditionSchema = z
  .object({
    source_text: unicodeStringSchema('source_text', 200),
    kind: z.enum(['must_have', 'optional', 'exclusion']),
    evidence_type: z.enum(['visual', 'spoken', 'metadata', 'unknown']),
  })
  .strict()

// AgentIntent 只分类用户原文中的意图和条件，故意没有 query 字段。
// Phase B 将校验 source_text 是原 prompt 的连续子串，检索仍使用完整原文。
export const agentIntentSchema = z
  .object({
    goal: z.enum(['search', 'inspect', 'export_clip']),
    search_scope: z.enum(['visual', 'spoken', 'all']),
    media_types: z.array(z.enum(mediaTypes)).max(4),
    library_references: z.array(unicodeStringSchema('library_reference', 200)).max(10),
    conditions: z.array(agentConditionSchema).max(30),
    needs_clarification: z.boolean(),
    clarification_reason: unicodeStringSchema('clarification_reason', 500).nullable(),
    requested_effect: z
      .object({
        type: z.literal('export_clip'),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((intent, context) => {
    for (const kind of ['must_have', 'optional', 'exclusion'] as const) {
      if (intent.conditions.filter((condition) => condition.kind === kind).length > 10) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${kind} conditions must contain at most 10 items`,
          path: ['conditions'],
        })
      }
    }
  })

export const createAgentRunInputSchema = z
  .object({
    prompt: unicodeStringSchema('prompt', 4000),
    // 文本和视觉授权必须分开。允许发 prompt 不等于允许发候选帧。
    allow_external_text: z.boolean(),
    allow_external_visual: z.boolean().optional().default(false),
    library_ids: z.array(uuidSchema).max(100).optional().default([]),
    media_types: z.array(z.enum(mediaTypes)).max(4).optional().default([]),
  })
  .strict()

export const resumeAgentRunInputSchema = z
  .object({
    waiting_step_id: uuidSchema,
    client_request_id: z.string().min(1).max(200),
    // Phase B 不允许模型二次解释自由文本；该动作明确覆盖为无副作用只读搜索。
    response: z.literal('continue_as_read_only_search_with_resolved_scope'),
  })
  .strict()

export const cancelAgentRunInputSchema = z
  .object({
    client_request_id: z.string().min(1).max(200),
    reason: unicodeStringSchema('reason', 500).optional(),
  })
  .strict()

export const retryUnknownAgentRunInputSchema = z
  .object({
    step_attempt_id: uuidSchema,
    client_request_id: z.string().min(1).max(200),
  })
  .strict()

// Phase C 的选择请求只接受冻结候选身份和场景内时间范围。输出格式在 V1 冻结为 mp4，
// 浏览器不能提交任意输出路径或 FFmpeg 参数。
export const agentExportSelectionInputSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    start_time_seconds: nonNegativeNumberSchema,
    end_time_seconds: positiveNumberSchema,
    output_format: z.literal('mp4').default('mp4'),
  })
  .strict()
  .refine((input) => input.end_time_seconds > input.start_time_seconds, {
    message: 'end_time_seconds must be greater than start_time_seconds',
    path: ['end_time_seconds'],
  })

export const confirmAgentExportInputSchema = z
  .object({
    waiting_step_id: uuidSchema,
    tool_call_id: z.string().min(1).max(300),
    client_request_id: z.string().min(1).max(200),
  })
  .strict()

export const agentErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    retryable: z.boolean(),
  })
  .strict()

// 这里是跨语言 job 协议的事实来源：NestJS 创建 job，Python worker 读取生成的 JSON Schema 校验输入。
// 新 job type 必须先在这里声明输入/输出，再生成 packages/shared/generated/job-schemas.json。
export const jobTypeSchema = z.enum(jobTypes)

export const scanLibraryInputSchema = z.object({
  library_id: uuidSchema,
  root_path: z.string().min(1),
  scan_mode: z.enum(['mtime_size', 'full']),
})

export const scanLibraryOutputSchema = z.object({
  discovered: nonNegativeIntegerSchema,
  created: nonNegativeIntegerSchema,
  updated: nonNegativeIntegerSchema,
  skipped: nonNegativeIntegerSchema,
  failed: nonNegativeIntegerSchema,
})

export const probeMediaInputSchema = z.object({
  file_id: uuidSchema,
  path: z.string().min(1),
  media_type: z.enum(mediaTypes),
})

export const probeMediaOutputSchema = z.object({
  duration_seconds: nonNegativeNumberSchema.optional(),
  width: nonNegativeIntegerSchema.optional(),
  height: nonNegativeIntegerSchema.optional(),
  codec: z.string().min(1).optional(),
  streams: nonNegativeIntegerSchema,
})

// index_media 不再携带 segment_strategy：旧 fixed_30s fallback 已删除，视频索引只走
// PySceneDetect 场景检测；检测失败直接让任务失败，不再回退到固定窗口。
export const indexMediaInputSchema = z.object({
  file_id: uuidSchema,
  index_profile: indexProfileSchema,
})

// 输出不再有 segment_strategy / fallback / fallback_reason / keyframes_selected /
// keyframe_density：场景检测要么成功写出 video_scenes 与 video_frame，要么结构化失败。
export const indexMediaOutputSchema = z.object({
  assets_created: nonNegativeIntegerSchema,
  vector_refs_created: nonNegativeIntegerSchema,
  collections: z.array(collectionSchema),
  scenes_detected: nonNegativeIntegerSchema.optional(),
  frames_created: nonNegativeIntegerSchema.optional(),
})

export const transcribeAudioInputSchema = z.object({
  file_id: uuidSchema,
  path: z.string().min(1),
  media_type: z.enum(['video', 'audio']),
  model: z.string().min(1).default('base'),
  language: z.string().min(1).default('auto'),
})

export const transcribeAudioOutputSchema = z.object({
  chunks_created: nonNegativeIntegerSchema,
  language: z.string().min(1),
  duration_seconds: nonNegativeNumberSchema.optional(),
})

export const embedImageInputSchema = z.object({
  asset_id: uuidSchema,
  path: z.string().min(1),
  collection: z.literal('image_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

// 视频帧向量只写入 video_frame_vectors；video_segment_vectors 集合已删除（场景不再有独立向量点）。
export const embedVideoFrameInputSchema = z.object({
  asset_id: uuidSchema,
  frame_path: z.string().min(1),
  frame_time_seconds: nonNegativeNumberSchema.optional(),
  collection: z.literal('video_frame_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const embedTextAssetInputSchema = z.object({
  asset_id: uuidSchema,
  collection: z.literal('caption_text_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

// generate_caption 支持两种来源，由 prompt_version 决定（Worker 侧强制）：
// - caption-v1（图片）：source_asset_ids 给出图片 asset，无 scene_id。
// - scene-caption-v2（视频场景）：scene_id 给出正式 video_scenes.id，Worker 通过它取按时间
//   排序的场景帧；不再接受 video_segment 来源，也不再从 metadata_json.scene_id 解析。
export const generateCaptionInputSchema = z.object({
  file_id: uuidSchema,
  prompt_version: z.enum(['caption-v1', 'scene-caption-v2']).default('caption-v1'),
  source_asset_ids: z.array(uuidSchema).min(1).optional(),
  scene_id: uuidSchema.optional(),
  model_name: z.string().min(1).default('Qwen/Qwen2.5-VL-7B-Instruct'),
  model_version: z.string().min(1).default('qwen2.5-vl-7b-instruct'),
})

export const embeddingOutputSchema = z.object({
  point_id: uuidSchema,
  collection: collectionSchema,
  vector_dim: z.number().int().positive(),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const generateCaptionOutputSchema = z.object({
  caption_asset_id: uuidSchema,
  source_assets: z.array(uuidSchema).min(1),
  text_written: nonNegativeIntegerSchema,
  vector_ref_created: z.boolean().optional(),
})

export const candidateEvidenceStrategySchema = z.enum(['contact_sheet_v1', 'all_indexed_frames_v1'])

// 证据 Job 只携带冻结候选的稳定身份与小型协议选择。源视频路径、图片字节、Caption、
// 转录和向量都由 Worker 在本地重新读取 PostgreSQL 事实，绝不能穿过跨语言 Job 参数。
export const buildCandidateEvidenceInputSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    file_id: uuidSchema,
    file_generation: nonNegativeIntegerSchema,
    asset_id: uuidSchema,
    scene_id: uuidSchema,
    strategies: z.array(candidateEvidenceStrategySchema).min(1).max(2),
  })
  .strict()
  .refine((input) => new Set(input.strategies).size === input.strategies.length, {
    message: 'strategies must not contain duplicates',
    path: ['strategies'],
  })

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const candidateEvidenceManifestSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    file_id: uuidSchema,
    file_generation: nonNegativeIntegerSchema,
    asset_id: uuidSchema,
    scene_id: uuidSchema,
    frame_asset_ids: z.array(uuidSchema).min(1).max(12),
    frame_time_seconds: z.array(nonNegativeNumberSchema.finite()).min(1).max(12),
    strategy: candidateEvidenceStrategySchema,
    protocol_version: z.literal('candidate-evidence-v1'),
    frame_count: z.number().int().min(1).max(12),
    input_sha256: sha256Schema,
    artifact_sha256: sha256Schema,
    // artifact_id 是受控 API 标识，不是文件系统路径；浏览器只能经 Server 读取成功证据。
    artifact_id: z.string().regex(/^candidate-evidence\/[0-9a-f-]{36}\/artifact$/),
    protocol_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    format: z.enum(['png', 'json']),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    byte_size: z.number().int().positive(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.frame_count !== manifest.frame_asset_ids.length ||
      manifest.frame_count !== manifest.frame_time_seconds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frame_count must match frame ids and times',
        path: ['frame_count'],
      })
    }
    if (
      manifest.strategy === 'contact_sheet_v1' &&
      (manifest.format !== 'png' || manifest.width === null || manifest.height === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contact_sheet_v1 requires PNG dimensions',
        path: ['format'],
      })
    }
    if (
      manifest.strategy === 'all_indexed_frames_v1' &&
      (manifest.format !== 'json' || manifest.width !== null || manifest.height !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'all_indexed_frames_v1 is a dimensionless JSON artifact',
        path: ['format'],
      })
    }
  })

export const buildCandidateEvidenceOutputSchema = z
  .object({
    evidence_ids: z.array(uuidSchema).min(1).max(2),
    manifests: z.array(candidateEvidenceManifestSchema).min(1).max(2),
  })
  .strict()

export const exportClipInputSchema = z
  .object({
    file_id: uuidSchema,
    start_time_seconds: nonNegativeNumberSchema,
    end_time_seconds: positiveNumberSchema,
    output_format: z.enum(['mp4', 'mov']).default('mp4'),
    // Agent 确认使用稳定 UUID 生成唯一输出名；旧的 Media Detail 导出没有该字段，
    // 因此保持可选以维持已有 API 契约。
    export_request_id: uuidSchema.optional(),
  })
  .refine((input) => input.end_time_seconds > input.start_time_seconds, {
    message: 'end_time_seconds must be greater than start_time_seconds',
    path: ['end_time_seconds'],
  })

export const exportClipOutputSchema = z.object({
  export_path: z.string().min(1),
  duration_seconds: positiveNumberSchema,
})

// purge_video_index：单文件破坏性重索引。Server 在确认无活跃媒体任务后创建该任务；
// Worker 先删 Qdrant points，再在 PostgreSQL 事务中删除场景/帧/Caption/Vector Ref 等派生数据，
// 条件递增 index_generation（仅在文件仍为 purge_queued 时），然后把文件状态翻回 pending。
// 失败必须可安全重试：Qdrant/PG 清理都幂等，generation 递增受状态条件保护不重复。
export const purgeVideoIndexInputSchema = z.object({
  file_id: uuidSchema,
})

export const purgeVideoIndexOutputSchema = z.object({
  points_deleted: nonNegativeIntegerSchema,
  vector_refs_deleted: nonNegativeIntegerSchema,
  assets_deleted: nonNegativeIntegerSchema,
  scenes_deleted: nonNegativeIntegerSchema,
  index_generation: nonNegativeIntegerSchema,
  reindex_job_created: z.boolean(),
})

export const jobInputSchemas = {
  scan_library: scanLibraryInputSchema,
  probe_media: probeMediaInputSchema,
  index_media: indexMediaInputSchema,
  purge_video_index: purgeVideoIndexInputSchema,
  transcribe_audio: transcribeAudioInputSchema,
  embed_image: embedImageInputSchema,
  embed_video_frame: embedVideoFrameInputSchema,
  embed_text_asset: embedTextAssetInputSchema,
  generate_caption: generateCaptionInputSchema,
  build_candidate_evidence: buildCandidateEvidenceInputSchema,
  export_clip: exportClipInputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>

// 输出 schema 主要用于文档和测试一致性；worker 写 result_json，server/web 只按稳定字段展示。
export const jobOutputSchemas = {
  scan_library: scanLibraryOutputSchema,
  probe_media: probeMediaOutputSchema,
  index_media: indexMediaOutputSchema,
  purge_video_index: purgeVideoIndexOutputSchema,
  transcribe_audio: transcribeAudioOutputSchema,
  embed_image: embeddingOutputSchema,
  embed_video_frame: embeddingOutputSchema,
  embed_text_asset: embeddingOutputSchema,
  generate_caption: generateCaptionOutputSchema,
  build_candidate_evidence: buildCandidateEvidenceOutputSchema,
  export_clip: exportClipOutputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>
