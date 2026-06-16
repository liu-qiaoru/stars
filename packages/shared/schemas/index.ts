import { z } from 'zod'
import { indexProfiles, jobTypes, mediaTypes, vectorCollectionNames } from '../constants/index.js'

const uuidSchema = z.string().uuid()
const nonNegativeIntegerSchema = z.number().int().min(0)
const positiveNumberSchema = z.number().positive()
const nonNegativeNumberSchema = z.number().min(0)
const collectionSchema = z.enum(vectorCollectionNames)
const indexProfileSchema = z.enum(indexProfiles)

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

export const indexMediaInputSchema = z.object({
  file_id: uuidSchema,
  index_profile: indexProfileSchema,
  segment_strategy: z.enum(['fixed_30s', 'scene_detection']),
})

export const indexMediaOutputSchema = z.object({
  assets_created: nonNegativeIntegerSchema,
  vector_refs_created: nonNegativeIntegerSchema,
  collections: z.array(collectionSchema),
  segment_strategy: z.enum(['fixed_30s', 'scene_detection']),
  fallback: z.boolean(),
  fallback_reason: z.string().min(1).optional(),
  scenes_detected: nonNegativeIntegerSchema.optional(),
  keyframes_selected: nonNegativeIntegerSchema.optional(),
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

export const runOcrInputSchema = z.object({
  asset_ids: z.array(uuidSchema).min(1),
  engine: z.literal('paddleocr').default('paddleocr'),
  language: z.string().min(1).default('ch'),
})

export const runOcrOutputSchema = z.object({
  assets_processed: nonNegativeIntegerSchema,
  text_written: nonNegativeIntegerSchema,
  skipped_no_text: nonNegativeIntegerSchema,
})

export const embedImageInputSchema = z.object({
  asset_id: uuidSchema,
  path: z.string().min(1),
  collection: z.literal('image_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const embedVideoFrameInputSchema = z.object({
  asset_id: uuidSchema,
  frame_path: z.string().min(1),
  frame_time_seconds: nonNegativeNumberSchema.optional(),
  collection: z.union([z.literal('video_frame_vectors'), z.literal('video_segment_vectors')]),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const embeddingOutputSchema = z.object({
  point_id: uuidSchema,
  collection: collectionSchema,
  vector_dim: z.number().int().positive(),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const exportClipInputSchema = z.object({
  file_id: uuidSchema,
  start_time_seconds: nonNegativeNumberSchema,
  end_time_seconds: positiveNumberSchema,
  output_format: z.enum(['mp4', 'mov']).default('mp4'),
}).refine((input) => input.end_time_seconds > input.start_time_seconds, {
  message: 'end_time_seconds must be greater than start_time_seconds',
  path: ['end_time_seconds'],
})

export const exportClipOutputSchema = z.object({
  export_path: z.string().min(1),
  duration_seconds: positiveNumberSchema,
})

export const jobInputSchemas = {
  scan_library: scanLibraryInputSchema,
  probe_media: probeMediaInputSchema,
  index_media: indexMediaInputSchema,
  transcribe_audio: transcribeAudioInputSchema,
  run_ocr: runOcrInputSchema,
  embed_image: embedImageInputSchema,
  embed_video_frame: embedVideoFrameInputSchema,
  export_clip: exportClipInputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>

export const jobOutputSchemas = {
  scan_library: scanLibraryOutputSchema,
  probe_media: probeMediaOutputSchema,
  index_media: indexMediaOutputSchema,
  transcribe_audio: transcribeAudioOutputSchema,
  run_ocr: runOcrOutputSchema,
  embed_image: embeddingOutputSchema,
  embed_video_frame: embeddingOutputSchema,
  export_clip: exportClipOutputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>
