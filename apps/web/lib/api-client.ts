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

export interface LibraryMediaItem {
  id: string
  relative_path: string
  media_type: MediaType
  index_status: string
}

export interface LibraryMediaListResponse {
  items: LibraryMediaItem[]
  total: number
  limit: number
  offset: number
}

export interface JobSummary {
  id: string
  job_type: string
  status: string
  progress: number
  file_paths: string[]
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface JobListResponse {
  items: JobSummary[]
  total: number
  limit: number
  offset: number
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
  confidence?: 'high' | 'low'
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

export interface EvaluationSetSummary {
  id: string
  name: string
  description: string | null
  latest_version: EvaluationVersionSummary | null
}

export interface EvaluationVersionSummary {
  id: string
  set_id: string
  version: number
  status: 'draft' | 'frozen'
  frozen_at: string | null
}

export interface EvaluationQuery {
  id: string
  version_id: string
  query_text: string
  query_type: 'known_target' | 'discovery'
  intent_category: string
  must_have: string[]
  optional: string[]
  exclusions: string[]
  target_file_id: string | null
  target_scene_id: string | null
}

export interface EvaluationCandidate {
  id: string
  query_id: string
  candidate_key: string
  file_id: string
  scene_id: string | null
  media_type: MediaType
  start_time_seconds: number | null
  end_time_seconds: number | null
  primary_pool: boolean
  judgment: {
    relevance: number | null
    unjudgeable: boolean
    diagnosis: string | null
    notes: string | null
  } | null
  current_rank?: number
  current_included?: boolean
  rrf_rank?: number
  rrf_score?: number
  source_evidence?: unknown
}

export interface EvaluationRun {
  id: string
  version_id: string
  status: string
  config: unknown
  corpus: unknown
  report: { queries: unknown[]; generated_at: string } | null
  error_stage: string | null
  error_message: string | null
  candidates: EvaluationCandidate[]
}

export interface MediaAsset {
  id: string
  asset_type: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  cache_path: string | null
  text_content: string | null
  metadata_json?: Record<string, unknown>
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

  function withQuery(path: string, input: Record<string, number | string | undefined>) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        params.set(key, String(value))
      }
    }
    const query = params.toString()
    return query ? `${path}?${query}` : path
  }

  return {
    getHealth: () => request<HealthResponse>('/health', { method: 'GET' }),
    listLibraries: () => request<{ items: LibrarySummary[] }>('/libraries', { method: 'GET' }),
    createLibrary: (input: { name: string; root_path: string }) =>
      request<LibrarySummary>('/libraries', { method: 'POST', body: JSON.stringify(input) }),
    scanLibrary: (id: string) =>
      request<{ job_id: string; status: string }>(`/libraries/${id}/scan`, { method: 'POST' }),
    listLibraryMedia: (
      id: string,
      input: { limit?: number; offset?: number; query?: string } = {},
    ) =>
      request<LibraryMediaListResponse>(withQuery(`/libraries/${id}/media`, input), {
        method: 'GET',
      }),
    listJobs: (input: { limit?: number; offset?: number } = {}) =>
      request<JobListResponse>(withQuery('/jobs', input), { method: 'GET' }),
    mediaContentUrl: (
      id: string,
      input: { startTimeSeconds?: number | null; endTimeSeconds?: number | null } = {},
    ) => {
      const fragment =
        input.startTimeSeconds === null || input.startTimeSeconds === undefined
          ? ''
          : `#t=${[
              Math.max(0, input.startTimeSeconds),
              input.endTimeSeconds === null || input.endTimeSeconds === undefined
                ? undefined
                : Math.max(0, input.endTimeSeconds),
            ]
              .filter((value) => value !== undefined)
              .join(',')}`
      return `${baseUrl}/media/${id}/content${fragment}`
    },
    searchMedia: (input: SearchRequest) =>
      request<SearchResponse>('/search', { method: 'POST', body: JSON.stringify(input) }),
    listEvaluationSets: () =>
      request<{ items: EvaluationSetSummary[] }>('/evaluation/sets', { method: 'GET' }),
    createEvaluationSet: (input: { name: string; description?: string }) =>
      request<EvaluationSetSummary & { version_id: string }>('/evaluation/sets', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getEvaluationVersion: (id: string) =>
      request<EvaluationVersionSummary & { queries: EvaluationQuery[] }>(
        `/evaluation/versions/${id}`,
        { method: 'GET' },
      ),
    createEvaluationVersion: (setId: string) =>
      request<EvaluationVersionSummary & { queries: EvaluationQuery[] }>(
        `/evaluation/sets/${setId}/versions`,
        { method: 'POST' },
      ),
    addEvaluationQuery: (versionId: string, input: Omit<EvaluationQuery, 'id' | 'version_id'>) =>
      request<EvaluationQuery>(`/evaluation/versions/${versionId}/queries`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    freezeEvaluationVersion: (versionId: string) =>
      request<EvaluationVersionSummary>(`/evaluation/versions/${versionId}/freeze`, {
        method: 'POST',
      }),
    startEvaluationRun: (versionId: string, libraryIds: string[]) =>
      request<EvaluationRun>(`/evaluation/versions/${versionId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ library_ids: libraryIds }),
      }),
    getEvaluationRun: (id: string, revealEvidence = false) =>
      request<EvaluationRun>(`/evaluation/runs/${id}?reveal_evidence=${revealEvidence}`, {
        method: 'GET',
      }),
    listEvaluationRuns: (versionId?: string) =>
      request<{
        items: Array<{
          id: string
          version_id: string
          status: string
          error_stage: string | null
          error_message: string | null
          created_at: string
        }>
      }>(`/evaluation/runs${versionId ? `?version_id=${versionId}` : ''}`, { method: 'GET' }),
    exportEvaluationRun: (id: string) =>
      request<EvaluationRun>(`/evaluation/runs/${id}/export`, { method: 'GET' }),
    saveEvaluationJudgment: (
      runId: string,
      candidateId: string,
      input: {
        relevance?: number | null
        unjudgeable?: boolean
        diagnosis?: string
        notes?: string
      },
    ) =>
      request<EvaluationRun>(`/evaluation/runs/${runId}/candidates/${candidateId}/judgment`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    finalizeEvaluationRun: (runId: string) =>
      request<EvaluationRun>(`/evaluation/runs/${runId}/finalize`, { method: 'POST' }),
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
