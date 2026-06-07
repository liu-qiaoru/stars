export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'unknown'

export interface LibrarySummary {
  id: string
  name: string
  root_path: string
  enabled: boolean
  media_count?: number
  indexed_count?: number
  failed_count?: number
}

export interface JobSummary {
  id: string
  job_type: string
  status: string
  progress: number
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface SearchRequest {
  query: string
  media_types: MediaType[]
  library_ids: string[]
  limit: number
  offset: number
}

export interface SearchResultItem {
  asset_id: string
  file_id: string
  media_type: MediaType
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  score: number
  reason: 'vector_match' | string
}

export interface SearchResultGroup {
  collection: string
  score_kind: string
  results: SearchResultItem[]
}

export interface SearchResponse {
  limit: number
  offset: number
  groups: SearchResultGroup[]
}

export interface MediaAsset {
  id: string
  asset_type: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  cache_path: string | null
  text_content: string | null
}

export interface ExportClipRequest {
  file_id: string
  start_time_seconds: number
  end_time_seconds: number
  output_format?: 'mp4' | 'mov'
}

export interface HealthResponse {
  status: string
  dependencies: { database: string; qdrant: string }
}

export interface MediaDetail {
  id: string
  library_id: string
  path: string
  media_type: MediaType
  size_bytes: number
  duration_seconds?: number
  width?: number
  height?: number
  codec?: string
  index_status: string
  assets_limit: number
  assets_offset: number
  assets_total: number
  assets: MediaAsset[]
}

interface ApiClientOptions {
  baseUrl?: string
  fetcher?: typeof fetch
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (
    options.baseUrl ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://127.0.0.1:4000'
  ).replace(/\/$/, '')
  const fetcher = options.fetcher ?? fetch

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`)
    }
    return (await response.json()) as T
  }

  return {
    getHealth: () => request<HealthResponse>('/health', { method: 'GET' }),
    listLibraries: () => request<{ items: LibrarySummary[] }>('/libraries', { method: 'GET' }),
    createLibrary: (input: { name: string; root_path: string }) =>
      request<LibrarySummary>('/libraries', { method: 'POST', body: JSON.stringify(input) }),
    scanLibrary: (id: string) =>
      request<{ job_id: string; status: string }>(`/libraries/${id}/scan`, { method: 'POST' }),
    listJobs: () => request<{ items: JobSummary[] }>('/jobs', { method: 'GET' }),
    searchMedia: (input: SearchRequest) =>
      request<SearchResponse>('/search', { method: 'POST', body: JSON.stringify(input) }),
    getMedia: (id: string) =>
      request<MediaDetail>(`/media/${id}?include_assets=true&assets_limit=50&assets_offset=0`, {
        method: 'GET',
      }),
    exportClip: (input: ExportClipRequest) =>
      request<{ job_id: string; status: string }>('/clips/export', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createAgentRun: (input: { prompt: string; allow_external_vlm: boolean }) =>
      request<{ run_id: string; status: string; message?: string }>('/agent/runs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  }
}
