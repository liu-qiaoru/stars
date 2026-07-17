// 跨语言共享的枚举常量。asset_type / collection / job_type 的最终取值以这里为唯一事实来源，
// Python worker 通过生成的 JSON Schema 校验，不维护第二份手写结构。
//
// 阶段 2 重建后的最终取值：
// - 不再有 OCR 能力，故 job_type 删除 run_ocr。
// - asset_type 只保留 image / video_frame / text_chunk / caption；删除 video_segment、
//   audio_segment、thumbnail、transcript_chunk、ocr_chunk 等占位或废弃类型。视频场景身份
//   改由独立的 video_scenes 表 + media_assets.scene_id 外键表达，不再是 asset_type。
// - 向量集合只保留 image_vectors / video_frame_vectors / caption_text_vectors；删除
//   video_segment_vectors（场景不再有独立向量点）、audio_segment_vectors、text_chunk_vectors。
export const jobTypes = [
  'scan_library',
  'probe_media',
  'index_media',
  'transcribe_audio',
  'embed_image',
  'embed_video_frame',
  'embed_text_asset',
  'generate_caption',
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
  'text_chunk',
  'caption',
] as const

export const vectorCollectionNames = [
  'image_vectors',
  'video_frame_vectors',
  'caption_text_vectors',
] as const

// index_profile 是 vector_ref 上记录"由哪种索引配置产出该向量"的标签（保留），与已删除的
// KEYFRAME_DENSITY 抽帧密度不是同一概念；阶段 2 后所有向量统一标记为 balanced。
export const indexProfiles = ['light', 'balanced', 'dense'] as const
