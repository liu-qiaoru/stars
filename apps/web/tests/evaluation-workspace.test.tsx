import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvaluationWorkspace } from '../components/evaluation-workspace'

afterEach(() => vi.unstubAllGlobals())

describe('evaluation workspace', () => {
  test('restores an existing blind-labeling run by id after a page refresh', async () => {
    const runId = 'df91d354-46e6-44e7-82bb-f0b16a92aea1'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: runId,
        version_id: 'version-1',
        status: 'ready_for_labeling',
        error_code: null,
        error_message: null,
        report: null,
        candidates: [
          {
            id: 'candidate-known',
            query_id: 'query-known',
            query_text: '指定目标查询',
            candidate_key: 'asset-known',
            file_id: '22222222-2222-4222-8222-222222222222',
            scene_id: null,
            media_type: 'image',
            start_time_seconds: null,
            end_time_seconds: null,
            requires_judgment: false,
            judgment: null,
          },
          {
            id: 'candidate-1',
            query_id: 'query-1',
            query_text: '有人举着风筝',
            candidate_key: 'asset-1',
            file_id: '11111111-1111-4111-8111-111111111111',
            scene_id: null,
            media_type: 'image',
            start_time_seconds: null,
            end_time_seconds: null,
            requires_judgment: true,
            judgment: null,
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<EvaluationWorkspace initialSets={[]} libraries={[]} />)

    fireEvent.change(screen.getByLabelText('评测运行 ID'), { target: { value: runId } })
    fireEvent.click(screen.getByRole('button', { name: '恢复盲标' }))

    expect(await screen.findByText('运行状态：ready_for_labeling')).toBeInTheDocument()
    expect(screen.getByText('查询：有人举着风筝')).toBeInTheDocument()
    expect(screen.getByText('已标注 0 / 1')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/evaluation/runs/${runId}`),
      expect.objectContaining({ method: 'GET' }),
    )
  })

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
