export const jobTypes = [
  'scan_library',
  'probe_media',
  'index_media',
  'embed_image',
  'embed_video_frame',
  'export_clip',
] as const

export const jobStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'stale',
] as const

export const mediaTypes = ['image', 'video', 'audio', 'document', 'unknown'] as const

export const mediaAssetTypes = [
  'image',
  'video_frame',
  'video_segment',
  'audio_segment',
  'text_chunk',
  'thumbnail',
  'transcript_chunk',
  'ocr_chunk',
] as const

export const vectorCollectionNames = [
  'image_vectors',
  'video_frame_vectors',
  'video_segment_vectors',
  'audio_segment_vectors',
  'text_chunk_vectors',
] as const

export const indexProfiles = ['light', 'balanced', 'dense'] as const
