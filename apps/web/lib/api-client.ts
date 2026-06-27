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
  merged_asset_ids?: string[]
  file_id: string
  media_type: MediaType
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  scene_id?: string | null
  score: number
  score_kind?: string
  primary_reason?: string
  reason?: 'vector_match' | string
  reasons?: string[]
  source_scores?: Record<string, number>
}

export interface SearchResultGroup {
  collection: string
  score_kind: string
  results: SearchResultItem[]
}

export interface SearchResponse {
  limit: number
  offset: number
  // Phase 14 后 results 是主展示列表；groups 保留给旧响应兼容和召回调试。
  results?: SearchResultItem[]
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

export interface AgentToolCallSummary {
  tool_call_id: string
  name: string
  status: string
  summary: string
  requires_confirmation?: boolean
}

export interface AgentRunDetail {
  id: string
  status: string
  prompt: string
  summary: string | null
  tool_calls: AgentToolCallSummary[]
  events: Array<{
    event_id: string
    type: string
    tool_call_id?: string | null
    created_at: string
    payload: unknown
  }>
  results: Array<{
    file_id: string
    asset_id: string
    start_time_seconds: number | null
    end_time_seconds: number | null
    score: number
    summary: string
  }>
}

interface ApiClientOptions {
  baseUrl?: string
  fetcher?: typeof fetch
}

export function createApiClient(options: ApiClientOptions = {}) {
  // 前端只通过这个薄 client 访问 NestJS API，页面组件不拼 URL，也不直接理解后端端口/env。
  const baseUrl = (
    options.baseUrl ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://127.0.0.1:4000'
  ).replace(/\/$/, '')
  const fetcher = options.fetcher ?? fetch

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // 当前 MVP 的错误处理只抛状态码；需要用户可见错误时在具体 workspace 里转换为文案。
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
    getAgentRun: (id: string) =>
      request<AgentRunDetail>(`/agent/runs/${id}`, {
        method: 'GET',
      }),
    confirmAgentToolCall: (id: string, toolCallId: string) =>
      request<{ job_id: string; status: string }>(`/agent/runs/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ tool_call_id: toolCallId }),
      }),
  }
}
