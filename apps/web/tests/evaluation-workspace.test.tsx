import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { EvaluationWorkspace } from '../components/evaluation-workspace'

describe('evaluation workspace', () => {
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
