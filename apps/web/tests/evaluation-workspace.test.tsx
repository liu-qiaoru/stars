import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { EvaluationWorkspace } from '../components/evaluation-workspace'

describe('evaluation workspace', () => {
  test('selects a known-target video scene without entering internal ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'version-1',
          set_id: 'set-1',
          version: 1,
          status: 'draft',
          frozen_at: null,
          queries: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'file-1',
              relative_path: '旅行/海边.mp4',
              media_type: 'video',
              index_status: 'indexed',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file-1',
          library_id: 'library-1',
          path: '/media/旅行/海边.mp4',
          media_type: 'video',
          size_bytes: 10,
          index_status: 'indexed',
          assets_limit: 50,
          assets_offset: 0,
          assets_total: 1,
          assets: [
            {
              id: 'segment-1',
              asset_type: 'video_segment',
              start_time_seconds: 12,
              end_time_seconds: 34,
              cache_path: null,
              text_content: null,
              metadata_json: { scene_id: 'scene-1' },
            },
          ],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <EvaluationWorkspace
        initialSets={[
          {
            id: 'set-1',
            name: '基线',
            description: null,
            latest_version: {
              id: 'version-1',
              set_id: 'set-1',
              version: 1,
              status: 'draft',
              frozen_at: null,
            },
          },
        ]}
        libraries={[{ id: 'library-1', name: '主素材库', root_path: '/media', enabled: true }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /基线/ }))
    await waitFor(() => expect(screen.getByText('查询 v1')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('查询类型'), { target: { value: 'known_target' } })
    fireEvent.change(screen.getByPlaceholderText('按文件名或路径筛选'), {
      target: { value: '海边' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查找媒体' }))
    await waitFor(() => expect(screen.getByText('旅行/海边.mp4')).toBeInTheDocument())
    fireEvent.click(screen.getByText('旅行/海边.mp4'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '00:12–00:34' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: '00:12–00:34' }))

    expect(screen.getByText(/已选择：.*00:12–00:34/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/UUID|scene_id/)).not.toBeInTheDocument()
  })

  test('creates an evaluation set and resets the captured form without reading a released event', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'set-1',
          name: '八份数据',
          description: null,
          version_id: 'version-1',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'version-1',
          set_id: 'set-1',
          version: 1,
          status: 'draft',
          frozen_at: null,
          queries: [],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<EvaluationWorkspace initialSets={[]} libraries={[]} />)
    const input = screen.getByPlaceholderText('新评测集名称')
    fireEvent.change(input, { target: { value: '八份数据' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(screen.getByText('查询 v1')).toBeInTheDocument())
    expect(input).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('keeps source evidence and RRF scores hidden before the primary judgment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'version-1',
          set_id: 'set-1',
          version: 1,
          status: 'frozen',
          frozen_at: '2026-07-12T00:00:00Z',
          queries: [{ id: 'query-1', query_text: '红色汽车' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <EvaluationWorkspace
        initialSets={[
          {
            id: 'set-1',
            name: '基线',
            description: null,
            latest_version: {
              id: 'version-1',
              set_id: 'set-1',
              version: 1,
              status: 'frozen',
              frozen_at: '2026-07-12T00:00:00Z',
            },
          },
        ]}
        libraries={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /基线/ }))

    await waitFor(() => expect(screen.getByText('红色汽车')).toBeInTheDocument())
    expect(screen.queryByText(/RRF score/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/source_evidence/i)).not.toBeInTheDocument()
    expect(screen.getByText(/RRF 分数仅用于排序，不表示相关概率/)).toBeInTheDocument()
  })
})
