import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApiClient } from '../lib/api-client'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
})

describe('typed API client', () => {
  test('treats a successful empty shadow-rerank response as the documented not-run null state', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.getEvaluationShadowRerank('run-1')).resolves.toBeNull()
  })

  test('still rejects a non-empty malformed shadow-rerank response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{malformed', { status: 200 }))
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.getEvaluationShadowRerank('run-1')).rejects.toBeInstanceOf(SyntaxError)
  })

  test('requests libraries and creates scan jobs with stable routes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: 'lib-1', name: 'Main', root_path: '/media', enabled: true }],
          }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), { status: 200 }),
      )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.listLibraries()).resolves.toMatchObject({ items: [{ id: 'lib-1' }] })
    await expect(client.scanLibrary('lib-1')).resolves.toEqual({
      job_id: 'job-1',
      status: 'queued',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.local/libraries',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.local/libraries/lib-1/scan',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('posts search requests with media filters and pagination', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ limit: 12, offset: 24, groups: [] }), { status: 200 }),
    )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await client.searchMedia({
      query: 'red car',
      media_types: ['image', 'video'],
      library_ids: ['library-1'],
      limit: 12,
      offset: 24,
      query_expansion_mode: 'translate',
      include_diagnostics: true,
      search_scope: 'all',
      ranking_mode: 'rrf',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.local/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'red car',
          media_types: ['image', 'video'],
          library_ids: ['library-1'],
          limit: 12,
          offset: 24,
          query_expansion_mode: 'translate',
          include_diagnostics: true,
          search_scope: 'all',
          ranking_mode: 'rrf',
        }),
      }),
    )
  })

  test('requests jobs with pagination query parameters', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 160, limit: 500, offset: 0 }), {
        status: 200,
      }),
    )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.listJobs({ limit: 500, offset: 0 })).resolves.toMatchObject({
      total: 160,
      limit: 500,
      offset: 0,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.local/jobs?limit=500&offset=0',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('requests one library media page', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 40, limit: 25, offset: 0 }), {
        status: 200,
      }),
    )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.listLibraryMedia('lib-1', { limit: 25, offset: 0 })).resolves.toMatchObject(
      {
        total: 40,
        limit: 25,
        offset: 0,
      },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.local/libraries/lib-1/media?limit=25&offset=0',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('builds media content URLs for previews', () => {
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    expect(client.mediaContentUrl('file-1')).toBe('http://api.local/media/file-1/content')
    expect(client.mediaContentUrl('file-1', { startTimeSeconds: 12.5 })).toBe(
      'http://api.local/media/file-1/content#t=12.5',
    )
    expect(client.mediaContentUrl('file-1', { startTimeSeconds: 12.5, endTimeSeconds: 24 })).toBe(
      'http://api.local/media/file-1/content#t=12.5,24',
    )
  })

  test('posts clip export requests with time range', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), { status: 200 }),
    )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(
      client.exportClip({
        file_id: 'file-1',
        start_time_seconds: 30,
        end_time_seconds: 60,
        output_format: 'mp4',
      }),
    ).resolves.toEqual({ job_id: 'job-1', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.local/clips/export',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          file_id: 'file-1',
          start_time_seconds: 30,
          end_time_seconds: 60,
          output_format: 'mp4',
        }),
      }),
    )
  })

  test('creates, restores, cancels, and addresses local candidate evidence with stable routes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'evidence-1', status: 'cancelled' }), { status: 200 }),
      )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })
    const source = { type: 'agent_run_candidate' as const, run_id: 'run-1' }

    await client.createCandidateEvidence({
      source,
      candidate_key: 'video:scene-1',
      strategies: ['contact_sheet_v1', 'all_indexed_frames_v1'],
    })
    await client.listCandidateEvidence({
      source_type: 'agent_run_candidate',
      source_id: 'run-1',
      candidate_key: 'video:scene-1',
    })
    await client.cancelCandidateEvidence('evidence-1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.local/candidate-evidence',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://api.local/candidate-evidence?source_type=agent_run_candidate&source_id=run-1&candidate_key=video%3Ascene-1',
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://api.local/candidate-evidence/evidence-1/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(client.candidateEvidenceArtifactUrl('evidence-1')).toBe(
      'http://api.local/candidate-evidence/evidence-1/artifact',
    )
  })

  test('reads settings and completes Agent export selection and confirmation with stable routes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ provider: 'rightapi', model: 'qwen3.7-plus', editable: {} }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'run-1', status: 'queued' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'run-1',
            status: 'succeeded',
            prompt: '查找片段',
            tool_calls: [
              {
                tool_call_id: 'search-1',
                name: 'search_media',
                status: 'succeeded',
                summary: '完成搜索',
              },
            ],
            events: [],
            results: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ waiting_step_id: 'wait-1', tool_call_id: 'export-1' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), { status: 200 }),
      )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(client.getAgentSettings()).resolves.toMatchObject({ model: 'qwen3.7-plus' })
    await expect(
      client.createAgentRun({
        prompt: '查找片段',
        allow_external_text: true,
        allow_external_visual: false,
      }),
    ).resolves.toEqual({
      run_id: 'run-1',
      status: 'queued',
    })
    await expect(client.getAgentRun('run-1')).resolves.toMatchObject({
      id: 'run-1',
      tool_calls: [{ name: 'search_media' }],
    })
    await expect(
      client.selectAgentExport('run-1', {
        candidate_key: 'video:scene-1',
        start_time_seconds: 10,
        end_time_seconds: 20,
        output_format: 'mp4',
      }),
    ).resolves.toMatchObject({ tool_call_id: 'export-1' })
    await expect(
      client.confirmAgentExport('run-1', {
        waiting_step_id: 'wait-1',
        tool_call_id: 'export-1',
        client_request_id: 'confirm-1',
      }),
    ).resolves.toEqual({
      job_id: 'job-1',
      status: 'queued',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.local/agent/settings',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.local/agent/runs',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://api.local/agent/runs/run-1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://api.local/agent/runs/run-1/export-selection',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://api.local/agent/runs/run-1/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          waiting_step_id: 'wait-1',
          tool_call_id: 'export-1',
          client_request_id: 'confirm-1',
        }),
      }),
    )
  })
})
