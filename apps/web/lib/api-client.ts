export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'unknown'

export const queryExpansionModes = ['original', 'translate', 'expand'] as const
export type QueryExpansionMode = (typeof queryExpansionModes)[number]

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
  error_code?: string | null
  error_details?: unknown
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
  query_expansion_mode?: QueryExpansionMode
  include_diagnostics?: boolean
  search_scope?: SearchScope
  ranking_mode?: RankingMode
}

export type SearchScope = 'visual' | 'spoken' | 'all'
export type RankingMode = 'current' | 'rrf'
export type RankingSignal = 'visual' | 'caption' | 'lexical'

export interface SearchResultItem {
  asset_id: string
  merged_asset_ids?: string[]
  file_id: string
  media_type: MediaType
  path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
  scene_id?: string | null
  best_frame_time_seconds?: number | null
  score: number
  score_kind?: string
  primary_reason?: string
  confidence?: 'high' | 'low'
  reason?: 'vector_match' | string
  reasons?: string[]
  source_scores?: Record<string, number>
  diagnostics?: {
    source_rank: number
    caption?: {
      text: string
      prompt_version: string | null
    }
    query_variant_hits: Array<{
      text: string
      source: 'original' | 'deepseek'
      weight: number
      raw_score: number
      weighted_score: number
      winning: boolean
    }>
  }
  ranking_diagnostics?: {
    source_ranks: Partial<Record<RankingSignal, number>>
    rrf_contributions: Partial<Record<RankingSignal, number>>
    primary_signal: RankingSignal
  }
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
  query_diagnostics?: {
    query_expansion_mode: QueryExpansionMode
    query_variants: Array<{
      text: string
      weight: number
      source: 'original' | 'deepseek'
    }>
  }
}

export interface EvaluationVersion {
  id: string
  set_id: string
  version: number
  status: 'draft' | 'frozen'
  frozen_at: string | null
  queries?: EvaluationQuery[]
}

export interface EvaluationQuery {
  id: string
  version_id: string
  query_text: string
  query_type: 'known_target' | 'discovery'
  search_scope: 'visual' | 'spoken' | 'all' | null
  intent_category: string
  must_have: string[]
  optional: string[]
  exclusions: string[]
  target_file_id: string | null
  target_scene_id: string | null
}

export interface EvaluationSet {
  id: string
  name: string
  description: string | null
  latest_version: EvaluationVersion | null
}

/**
 * 单条查询在某一种排序下的测评指标。发现类查询使用 Precision/nDCG，指定目标查询
 * 使用 Hit/MRR；不适用的字段是 null，不能当成 0 分。
 */
export interface EvaluationRankingMetrics {
  precisionAt5: number | null
  precisionAt10: number | null
  ndcgAt10: number | null
  ndcgAt20: number | null
  hitAt5: number | null
  hitAt10: number | null
  hitAt20: number | null
  reciprocalRank: number | null
  unjudgeableCount: number
}

export interface EvaluationReport {
  generated_at: string
  queries: Array<{
    query_id: string
    current: EvaluationRankingMetrics
    rrf: EvaluationRankingMetrics
  }>
}

export interface EvaluationRunSummary {
  id: string
  version_id: string
  set_id: string
  set_name: string
  version: number
  status: EvaluationRunStatus
  query_count: number
  candidate_count: number
  required_candidate_count: number
  judged_required_candidate_count: number
  judged_candidate_count: number
  report: EvaluationReport | null
  error_code: string | null
  error_message: string | null
  created_at: string
  finished_at: string | null
}

export interface EvaluationRunListResponse {
  items: EvaluationRunSummary[]
  total: number
  limit: number
  offset: number
}

export type EvaluationRunStatus =
  | 'pending'
  | 'retrieving'
  | 'ready_for_labeling'
  | 'labeled'
  | 'reported'
  | 'failed'

export interface EvaluationTarget {
  file_id: string
  scene_id: string | null
  media_type: MediaType
  relative_path: string
  start_time_seconds: number | null
  end_time_seconds: number | null
}

export interface EvaluationRun {
  id: string
  version_id: string
  status: EvaluationRunStatus
  error_code: string | null
  error_message: string | null
  config?: unknown
  report: EvaluationReport | null
  queries?: Array<{
    id: string
    query_text: string
    query_type: 'known_target' | 'discovery'
    search_scope: 'visual' | 'spoken' | 'all' | null
    intent_category: string
  }>
  candidates: Array<{
    id: string
    query_id: string
    query_text: string
    candidate_key: string
    file_id: string
    scene_id: string | null
    media_type: MediaType
    start_time_seconds: number | null
    end_time_seconds: number | null
    // 自然发现需要分级相关标注；指定目标只读取冻结目标的名次。
    requires_judgment: boolean
    judgment: { relevance: number | null; unjudgeable: boolean } | null
    current_rank?: number | null
    rrf_rank?: number | null
  }>
}

export type ShadowRerankStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'completed_with_errors'
  | 'failed'
  | 'not_applicable'

export interface ShadowRerankRun {
  id: string
  evaluation_run_id: string
  status: ShadowRerankStatus
  provider: string
  requested_model: 'qwen3-vl-rerank'
  response_model: string | null
  model_snapshot: string | null
  region: string | null
  protocol_version: string
  execution_number: number
  execution_history?: ShadowRerankRun[]
  query_count: number
  succeeded_count: number
  failed_count: number
  not_applicable_count: number
  actual_sample_count: number
  request_bytes: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  latency_ms: number | null
  billed_cost_cny: number | null
  estimated_cost_cny: number | null
  review_status: 'not_run'
  error: { code: string; message: string; details: unknown } | null
  metric_summary: {
    successful_samples: {
      n: number
      rrf: EvaluationRankingMetrics | null
      shadow: EvaluationRankingMetrics | null
    }
    full_product_samples: {
      n: number
      rrf: EvaluationRankingMetrics | null
      shadow_with_rrf_fallback: EvaluationRankingMetrics | null
    }
  }
  attempts: Array<{
    id: string
    query_id: string
    query_text: string
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown' | 'not_applicable'
    external_call_status: 'not_dispatched' | 'dispatched' | 'completed' | 'outcome_unknown'
    provider_request_id: string | null
    response_model: string | null
    model_snapshot: string | null
    region: string | null
    query_fingerprint: string | null
    evidence_fingerprint: string | null
    response_fingerprint: string | null
    request_bytes: number | null
    input_tokens: number | null
    output_tokens: number | null
    total_tokens: number | null
    latency_ms: number | null
    billed_cost_cny: number | null
    estimated_cost_cny: number | null
    usage_reconciliation: {
      source: 'aliyun_model_monitor'
      provider_request_id: string
      total_tokens: number
      text_input_tokens: number
      image_input_tokens: number
      estimated_cost_cny: number
      observed_at: string
    } | null
    actual_candidate_count: number
    actual_result_count: number
    metrics: {
      rrf: EvaluationRankingMetrics
      shadow: EvaluationRankingMetrics
    } | null
    error: { code: string; message: string; details: unknown } | null
    applicability_reason: string | null
    rankings: Array<{
      candidate_id: string
      candidate_key: string
      rrf_rank: number
      shadow_rank: number | null
      relevance_score: number | null
    }>
  }>
  created_at: string
  finished_at: string | null
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
  preview?: {
    candidate_key: string
    file_id: string
    file_generation: number
    scene_id: string
    scene_start_seconds: number
    scene_end_seconds: number
    start_time_seconds: number
    end_time_seconds: number
    output_format: 'mp4'
    requires_confirmation: true
  }
}

export interface AgentRunDetail {
  id: string
  status: string
  next_step?: string
  prompt: string
  summary: string | null
  waiting_step_id?: string | null
  error?: { code: string; message: string } | null
  intent?: {
    goal: string
    search_scope: SearchScope
    media_types: MediaType[]
    conditions: Array<{
      source_text: string
      kind: 'must_have' | 'optional' | 'exclusion'
      evidence_type: string
    }>
  } | null
  resolved_scope?: {
    search_scope: SearchScope
    media_types: MediaType[]
    library_ids: string[]
  } | null
  conditions?: Array<{
    condition_id: string
    source_text: string
    kind: 'must_have' | 'optional' | 'exclusion'
    evidence_type: string
  }>
  steps?: Array<{
    step_attempt_id: string
    step: string
    status: string
  }>
  tool_calls: AgentToolCallSummary[]
  events: Array<{
    event_id: string
    type: string
    tool_call_id?: string | null
    created_at: string
    payload: unknown
  }>
  candidates?: Array<{
    candidate_key: string
    file_id: string
    file_generation: number
    asset_id: string
    scene_id: string | null
    scene_start_seconds: number | null
    scene_end_seconds: number | null
    rank: number
    retrieval: {
      score?: number
      score_kind?: string
      primary_reason?: string
      reasons?: string[]
      source_scores?: Record<string, number>
    }
    review_status: 'not_run'
    unverified_condition_ids?: string[]
  }>
  export_job?: {
    id: string
    status: string
    progress: number
    result: unknown
    error_message: string | null
  } | null
}

export interface AgentSettingsResponse {
  provider: 'rightapi'
  model: 'qwen3.7-plus'
  prompt_version: string
  schema_version: string
  api_key: { configured: boolean }
  capabilities: {
    external_text_available: boolean
    external_visual_available: false
    rerank_available: false
    vlm_review_available: false
    unavailable_reasons: string[]
  }
  editable: {
    enabled: boolean
    tool_timeout_ms: number
    lease_duration_ms: number
    activity_timeout_ms: number
    waiting_ttl_seconds: number
    executor_interval_ms: number
    web_poll_interval_ms: number
  }
  apply_behavior: Record<string, 'immediate' | 'restart_required'>
  frozen: Record<string, boolean>
  persistence: 'process'
}

export type CandidateEvidenceStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface CandidateEvidenceSummary {
  id: string
  candidate_key: string
  file_id: string
  file_generation: number
  asset_id: string
  scene_id: string
  job_id: string | null
  status: CandidateEvidenceStatus
  strategy: 'contact_sheet_v1' | 'all_indexed_frames_v1'
  protocol_version: string
  frame_count: number | null
  artifact_url: string | null
  error: { code: string; message: string; details?: unknown } | null
}

export type CandidateEvidenceSource =
  | { type: 'agent_run_candidate'; run_id: string }
  | { type: 'evaluation_candidate'; run_id: string; candidate_id: string }

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

  async function request<T>(
    path: string,
    init: RequestInit = {},
    options: { emptySuccessAsNull?: boolean } = {},
  ): Promise<T> {
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
    if (options.emptySuccessAsNull) {
      const body = await response.text()
      // NestJS 的 Express 适配器会把 Controller 返回的 null 编码为 200 + 空正文，
      // 且测试/代理不一定保留 Content-Length。只有契约明确允许 null 的读取接口才
      // 读取正文并处理空值；非空内容仍严格 JSON.parse，不掩盖畸形响应。
      return (body.length === 0 ? null : JSON.parse(body)) as T
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
    getJob: (id: string, options: { signal?: AbortSignal } = {}) =>
      request<JobSummary>(`/jobs/${id}`, { method: 'GET', signal: options.signal }),
    retryJob: (id: string) =>
      request<{ job_id: string; status: string }>(`/jobs/${id}/retry`, { method: 'POST' }),
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
      request<{ items: EvaluationSet[] }>('/evaluation/sets', { method: 'GET' }),
    listEvaluationRuns: (input: { limit?: number; offset?: number; versionId?: string } = {}) =>
      request<EvaluationRunListResponse>(
        withQuery('/evaluation/runs', {
          limit: input.limit,
          offset: input.offset,
          version_id: input.versionId,
        }),
        { method: 'GET' },
      ),
    createEvaluationSet: (input: { name: string }) =>
      request<EvaluationSet & { version_id: string }>('/evaluation/sets', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getEvaluationVersion: (id: string) =>
      request<EvaluationVersion & { queries: EvaluationQuery[] }>(`/evaluation/versions/${id}`, {
        method: 'GET',
      }),
    listEvaluationTargets: (input: { libraryId?: string; limit?: number; seed?: string } = {}) =>
      request<{ items: EvaluationTarget[] }>(
        withQuery('/evaluation/targets/random', {
          library_id: input.libraryId,
          limit: input.limit,
          seed: input.seed,
        }),
        { method: 'GET' },
      ),
    addEvaluationQuery: (versionId: string, input: Omit<EvaluationQuery, 'id' | 'version_id'>) =>
      request<EvaluationQuery>(`/evaluation/versions/${versionId}/queries`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    freezeEvaluationVersion: (id: string) =>
      request<EvaluationVersion>(`/evaluation/versions/${id}/freeze`, { method: 'POST' }),
    startEvaluationRun: (id: string, libraryIds: string[]) =>
      request<EvaluationRun>(`/evaluation/versions/${id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ library_ids: libraryIds }),
      }),
    // 评测可能包含上千条盲标候选，不能假设用户会在一次页面会话中完成。
    // 通过不可变运行标识重新读取 PostgreSQL 快照，刷新页面后仍从首个未标候选继续。
    getEvaluationRun: (id: string) =>
      request<EvaluationRun>(`/evaluation/runs/${id}`, { method: 'GET' }),
    // 报告详情只有在正式指标池完成盲标后才允许揭示名次与来源证据。
    getEvaluationRunReport: (id: string) =>
      request<EvaluationRun>(`/evaluation/runs/${id}?reveal_evidence=true`, { method: 'GET' }),
    saveEvaluationJudgment: (
      runId: string,
      candidateId: string,
      input: { relevance?: number; unjudgeable?: boolean },
    ) =>
      request<EvaluationRun>(`/evaluation/runs/${runId}/candidates/${candidateId}/judgment`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    finalizeEvaluationRun: (id: string) =>
      request<EvaluationRun>(`/evaluation/runs/${id}/finalize`, { method: 'POST' }),
    startEvaluationShadowRerank: (id: string, signal?: AbortSignal) =>
      request<ShadowRerankRun>(`/evaluation/runs/${id}/shadow-rerank`, {
        method: 'POST',
        signal,
      }),
    retryEvaluationShadowRerank: (id: string, signal?: AbortSignal) =>
      request<ShadowRerankRun>(`/evaluation/runs/${id}/shadow-rerank/retry`, {
        method: 'POST',
        signal,
      }),
    getEvaluationShadowRerank: (id: string, signal?: AbortSignal) =>
      request<ShadowRerankRun | null>(
        `/evaluation/runs/${id}/shadow-rerank`,
        {
          method: 'GET',
          signal,
        },
        { emptySuccessAsNull: true },
      ),
    getMedia: (id: string) =>
      request<MediaDetail>(`/media/${id}?include_assets=true&assets_limit=50&assets_offset=0`, {
        method: 'GET',
      }),
    exportClip: (input: ExportClipRequest) =>
      request<{ job_id: string; status: string }>('/clips/export', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getAgentSettings: (options: { signal?: AbortSignal } = {}) =>
      request<AgentSettingsResponse>('/agent/settings', { method: 'GET', signal: options.signal }),
    saveAgentSettings: (input: AgentSettingsResponse['editable']) =>
      request<AgentSettingsResponse>('/agent/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    createAgentRun: (input: {
      prompt: string
      allow_external_text: boolean
      allow_external_visual?: boolean
      media_types?: MediaType[]
      library_ids?: string[]
    }) =>
      request<{ run_id: string; status: string; message?: string }>('/agent/runs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getAgentRun: (id: string, options: { signal?: AbortSignal } = {}) =>
      request<AgentRunDetail>(`/agent/runs/${id}`, {
        method: 'GET',
        signal: options.signal,
      }),
    createCandidateEvidence: (input: {
      source: CandidateEvidenceSource
      candidate_key: string
      strategies: Array<'contact_sheet_v1' | 'all_indexed_frames_v1'>
    }) =>
      request<{ items: CandidateEvidenceSummary[] }>('/candidate-evidence', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listCandidateEvidence: (
      input: {
        source_type: CandidateEvidenceSource['type']
        source_id: string
        candidate_key?: string
      },
      options: { signal?: AbortSignal } = {},
    ) =>
      request<{ items: CandidateEvidenceSummary[] }>(withQuery('/candidate-evidence', input), {
        method: 'GET',
        signal: options.signal,
      }),
    cancelCandidateEvidence: (id: string) =>
      request<CandidateEvidenceSummary>(`/candidate-evidence/${id}/cancel`, { method: 'POST' }),
    candidateEvidenceArtifactUrl: (id: string) => `${baseUrl}/candidate-evidence/${id}/artifact`,
    selectAgentExport: (
      id: string,
      input: {
        candidate_key: string
        start_time_seconds: number
        end_time_seconds: number
        output_format: 'mp4'
      },
    ) =>
      request<{
        run_id: string
        status: string
        waiting_step_id: string
        tool_call_id: string
        preview: {
          candidate_key: string
          file_id: string
          file_generation: number
          scene_id: string
          scene_start_seconds: number
          scene_end_seconds: number
          start_time_seconds: number
          end_time_seconds: number
          output_format: 'mp4'
          requires_confirmation: true
        }
      }>(`/agent/runs/${id}/export-selection`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    confirmAgentExport: (
      id: string,
      input: { waiting_step_id: string; tool_call_id: string; client_request_id: string },
    ) =>
      request<{ job_id: string; status: string; run_status: string }>(`/agent/runs/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    retryUnknownAgentRun: (
      id: string,
      input: { step_attempt_id: string; client_request_id: string },
    ) =>
      request<{ run_id: string; status: string }>(`/agent/runs/${id}/retry-unknown`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  }
}
