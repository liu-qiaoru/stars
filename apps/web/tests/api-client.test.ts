import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApiClient } from '../lib/api-client'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
})

describe('typed API client', () => {
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

  test('creates, fetches, and confirms agent runs', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'run-1', status: 'succeeded' }), { status: 200 }),
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
        new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), { status: 200 }),
      )
    const client = createApiClient({ baseUrl: 'http://api.local', fetcher: fetchMock })

    await expect(
      client.createAgentRun({ prompt: '查找片段', allow_external_vlm: false }),
    ).resolves.toEqual({
      run_id: 'run-1',
      status: 'succeeded',
    })
    await expect(client.getAgentRun('run-1')).resolves.toMatchObject({
      id: 'run-1',
      tool_calls: [{ name: 'search_media' }],
    })
    await expect(client.confirmAgentToolCall('run-1', 'export-1')).resolves.toEqual({
      job_id: 'job-1',
      status: 'queued',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.local/agent/runs',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.local/agent/runs/run-1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://api.local/agent/runs/run-1/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tool_call_id: 'export-1' }),
      }),
    )
  })
})
