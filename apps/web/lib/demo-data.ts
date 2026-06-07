import type { JobSummary, LibrarySummary, MediaDetail, SearchResponse } from './api-client'

export const demoLibraries: LibrarySummary[] = [
  {
    id: 'demo-library',
    name: '主素材库',
    root_path: '/本地媒体',
    enabled: true,
    media_count: 124,
    indexed_count: 48,
    failed_count: 2,
  },
]

export const demoSearchResponse: SearchResponse = {
  limit: 20,
  offset: 0,
  groups: [
    {
      collection: 'image_vectors',
      score_kind: 'cosine_similarity',
      results: [
        {
          asset_id: 'demo-image-asset',
          file_id: 'demo-image-file',
          media_type: 'image',
          path: '/本地媒体/发布会/主视觉.jpg',
          start_time_seconds: null,
          end_time_seconds: null,
          score: 0.91,
          reason: 'vector_match',
        },
      ],
    },
    {
      collection: 'video_segment_vectors',
      score_kind: 'cosine_similarity',
      results: [
        {
          asset_id: 'demo-video-asset',
          file_id: 'demo-video-file',
          media_type: 'video',
          path: '/本地媒体/发布会/新品发布.mp4',
          start_time_seconds: 120,
          end_time_seconds: 150,
          score: 0.82,
          reason: 'vector_match',
        },
      ],
    },
  ],
}

export const demoJobs: JobSummary[] = [
  {
    id: '扫描任务示例',
    job_type: 'scan_library',
    status: 'succeeded',
    progress: 100,
    error_message: null,
    created_at: '2026-06-02T10:01:00Z',
    updated_at: '2026-06-02T10:05:00Z',
  },
  {
    id: '索引任务示例',
    job_type: 'index_media',
    status: 'running',
    progress: 42,
    error_message: null,
    created_at: '2026-06-02T10:06:00Z',
    updated_at: '2026-06-02T10:08:00Z',
  },
]

export const demoMediaDetail: MediaDetail = {
  id: 'demo',
  library_id: 'demo-library',
  path: '/本地媒体/发布会/新品发布.mp4',
  media_type: 'video',
  size_bytes: 734003200,
  duration_seconds: 360,
  width: 1920,
  height: 1080,
  codec: 'h264',
  index_status: 'indexed',
  assets_limit: 50,
  assets_offset: 0,
  assets_total: 4,
  assets: [
    {
      id: 'segment-1',
      asset_type: 'video_segment',
      start_time_seconds: 0,
      end_time_seconds: 30,
      cache_path: null,
      text_content: null,
    },
    {
      id: 'segment-2',
      asset_type: 'video_segment',
      start_time_seconds: 120,
      end_time_seconds: 150,
      cache_path: null,
      text_content: null,
    },
  ],
}
