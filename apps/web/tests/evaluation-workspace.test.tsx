import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvaluationWorkspace } from '../components/evaluation-workspace'

afterEach(() => vi.unstubAllGlobals())

describe('evaluation workspace', () => {
  test('loads formal scene targets without exposing ranking evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            file_id: '11111111-1111-4111-8111-111111111111',
            scene_id: '22222222-2222-4222-8222-222222222222',
            media_type: 'video',
            relative_path: 'clip.mp4',
            start_time_seconds: 3,
            end_time_seconds: 9,
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<EvaluationWorkspace initialSets={[]} libraries={[]} />)

    // 创建按钮需要版本才能出现；这里直接先创建本地集合，再验证目标接口返回正式 scene UUID。
    fireEvent.change(screen.getByLabelText('评测集名称'), { target: { value: 'Phase 6' } })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'set-1',
        name: 'Phase 6',
        description: null,
        version_id: 'version-1',
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: '创建评测集' }))
    await screen.findByText(/版本 1/)
    fireEvent.click(screen.getByRole('button', { name: '从正式场景选择目标' }))

    const option = await screen.findByRole('option', { name: /场景 22222222/ })
    expect(option).toHaveValue(
      '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    )
    expect(screen.queryByText(/source_evidence|rrf_contributions/i)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/evaluation/targets/random?limit=20&seed=phase6-ui'),
        expect.anything(),
      ),
    )
  })
})
