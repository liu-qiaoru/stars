import { z } from "zod";
import {
  indexProfiles,
  jobTypes,
  mediaTypes,
  vectorCollectionNames,
} from "../constants/index.js";

const uuidSchema = z.string().uuid();
const nonNegativeIntegerSchema = z.number().int().min(0);
const positiveNumberSchema = z.number().positive();
const nonNegativeNumberSchema = z.number().min(0);
const collectionSchema = z.enum(vectorCollectionNames);
const indexProfileSchema = z.enum(indexProfiles);

export const jobTypeSchema = z.enum(jobTypes);

export const scanLibraryInputSchema = z.object({
  library_id: uuidSchema,
  root_path: z.string().min(1),
  scan_mode: z.enum(["mtime_size", "full"]),
});

export const scanLibraryOutputSchema = z.object({
  discovered: nonNegativeIntegerSchema,
  created: nonNegativeIntegerSchema,
  updated: nonNegativeIntegerSchema,
  skipped: nonNegativeIntegerSchema,
  failed: nonNegativeIntegerSchema,
});

export const probeMediaInputSchema = z.object({
  file_id: uuidSchema,
  path: z.string().min(1),
  media_type: z.enum(mediaTypes),
});

export const probeMediaOutputSchema = z.object({
  duration_seconds: nonNegativeNumberSchema.optional(),
  width: nonNegativeIntegerSchema.optional(),
  height: nonNegativeIntegerSchema.optional(),
  codec: z.string().min(1).optional(),
  streams: nonNegativeIntegerSchema,
});

export const indexMediaInputSchema = z.object({
  file_id: uuidSchema,
  index_profile: indexProfileSchema,
  segment_strategy: z.enum(["fixed_30s", "scene_detection"]),
});

export const indexMediaOutputSchema = z.object({
  assets_created: nonNegativeIntegerSchema,
  vector_refs_created: nonNegativeIntegerSchema,
  collections: z.array(collectionSchema),
});

export const embedImageInputSchema = z.object({
  asset_id: uuidSchema,
  path: z.string().min(1),
  collection: z.literal("image_vectors"),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
});

export const embedVideoFrameInputSchema = z.object({
  asset_id: uuidSchema,
  frame_path: z.string().min(1),
  collection: z.union([z.literal("video_frame_vectors"), z.literal("video_segment_vectors")]),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
});

export const embedTextInputSchema = z.object({
  asset_id: uuidSchema,
  collection: z.union([z.literal("audio_segment_vectors"), z.literal("text_chunk_vectors")]),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
});

export const embeddingOutputSchema = z.object({
  point_id: uuidSchema,
  collection: collectionSchema,
  vector_dim: z.number().int().positive(),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
});

export const exportClipInputSchema = z.object({
  file_id: uuidSchema,
  start_time_seconds: nonNegativeNumberSchema,
  end_time_seconds: positiveNumberSchema,
  output_format: z.enum(["mp4", "mov"]).default("mp4"),
});

export const exportClipOutputSchema = z.object({
  export_path: z.string().min(1),
  duration_seconds: positiveNumberSchema,
});

export const jobInputSchemas = {
  scan_library: scanLibraryInputSchema,
  probe_media: probeMediaInputSchema,
  index_media: indexMediaInputSchema,
  embed_image: embedImageInputSchema,
  embed_video_frame: embedVideoFrameInputSchema,
  embed_text: embedTextInputSchema,
  export_clip: exportClipInputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>;

export const jobOutputSchemas = {
  scan_library: scanLibraryOutputSchema,
  probe_media: probeMediaOutputSchema,
  index_media: indexMediaOutputSchema,
  embed_image: embeddingOutputSchema,
  embed_video_frame: embeddingOutputSchema,
  embed_text: embeddingOutputSchema,
  export_clip: exportClipOutputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>;
