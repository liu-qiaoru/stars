import { z } from 'zod'
import { indexProfiles, jobTypes, mediaTypes, vectorCollectionNames } from '../constants/index.js'

const uuidSchema = z.string().uuid()
const nonNegativeIntegerSchema = z.number().int().min(0)
const positiveNumberSchema = z.number().positive()
const nonNegativeNumberSchema = z.number().min(0)
const collectionSchema = z.enum(vectorCollectionNames)
const indexProfileSchema = z.enum(indexProfiles)

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

export const exportClipInputSchema = z
  .object({
    file_id: uuidSchema,
    start_time_seconds: nonNegativeNumberSchema,
    end_time_seconds: positiveNumberSchema,
    output_format: z.enum(['mp4', 'mov']).default('mp4'),
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
  export_clip: exportClipOutputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>
