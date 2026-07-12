import type { MediaType } from './api-client'

const mediaTypeLabels: Record<MediaType, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
  unknown: '未知',
}

const collectionLabels: Record<string, string> = {
  image_vectors: '图片向量',
  video_segment_vectors: '视频片段向量',
  video_frame_vectors: '视频帧向量',
  caption_text_vectors: 'Caption 文本向量',
}

const scoreKindLabels: Record<string, string> = {
  cosine_similarity: '余弦相似度',
  hybrid_score: '混合排序分',
  ts_rank_cd: '全文检索分',
}

const reasonLabels: Record<string, string> = {
  vector_match: '视觉命中',
  transcript_match: '转写命中',
  ocr_match: 'OCR 命中',
  caption_match: 'Caption 命中',
}

const jobTypeLabels: Record<string, string> = {
  scan_library: '扫描素材库',
  probe_media: '探测媒体',
  index_media: '索引媒体',
  generate_caption: '生成 Caption',
  embed_text_asset: '文本向量化',
  export_clip: '导出片段',
}

const statusLabels: Record<string, string> = {
  queued: '等待中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  indexed: '已索引',
  pending: '待处理',
  probed: '已探测',
}

const assetTypeLabels: Record<string, string> = {
  image: '图片资产',
  video_segment: '视频片段',
  video_frame: '视频帧',
  audio_segment: '音频片段',
  caption: 'Caption 文本',
}

export function formatMediaType(mediaType: MediaType) {
  return mediaTypeLabels[mediaType] ?? mediaTypeLabels.unknown
}

export function formatCollection(collection: string) {
  return collectionLabels[collection] ?? collection
}

export function formatScoreKind(scoreKind: string) {
  return scoreKindLabels[scoreKind] ?? scoreKind
}

export function formatReason(reason: string) {
  return reasonLabels[reason] ?? reason
}

export function formatConfidence(confidence: string) {
  return confidence === 'low' ? '相关性较弱' : '高相关'
}

export function formatJobType(jobType: string) {
  return jobTypeLabels[jobType] ?? jobType
}

export function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

export function formatAssetType(assetType: string) {
  return assetTypeLabels[assetType] ?? assetType
}

function formatPlaybackTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}

export function formatTimeRange(startSeconds: number, endSeconds: number) {
  return `${formatPlaybackTime(startSeconds)} – ${formatPlaybackTime(endSeconds)}`
}
