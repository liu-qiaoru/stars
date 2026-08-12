import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvaluationWorkspace } from '../components/evaluation-workspace'
import { createApiClient } from '../lib/api-client'

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

  test('remounts evidence state when labeling advances to the next video candidate', async () => {
    const firstCandidate = {
      id: 'candidate-1',
      query_id: 'query-1',
      query_text: '视频查询',
      candidate_key: 'video:scene-1',
      file_id: 'file-1',
      scene_id: 'scene-1',
      media_type: 'video' as const,
      start_time_seconds: 1,
      end_time_seconds: 2,
      requires_judgment: true,
      judgment: null,
    }
    const secondCandidate = {
      ...firstCandidate,
      id: 'candidate-2',
      candidate_key: 'video:scene-2',
      file_id: 'file-2',
      scene_id: 'scene-2',
      start_time_seconds: 3,
      end_time_seconds: 4,
    }
    const initialRun = {
      id: 'run-1',
      version_id: 'version-1',
      status: 'ready_for_labeling' as const,
      error_code: null,
      error_message: null,
      report: null,
      candidates: [firstCandidate, secondCandidate],
    }
    const nextRun = {
      ...initialRun,
      candidates: [
        { ...firstCandidate, judgment: { relevance: 2, unjudgeable: false } },
        secondCandidate,
      ],
    }
    const listCandidateEvidence = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            id: 'evidence-1',
            candidate_key: firstCandidate.candidate_key,
            file_id: firstCandidate.file_id,
            file_generation: 3,
            asset_id: 'asset-1',
            scene_id: firstCandidate.scene_id,
            job_id: 'job-1',
            status: 'running',
            strategy: 'contact_sheet_v1',
            protocol_version: 'candidate-evidence-v1',
            frame_count: null,
            artifact_url: null,
            error: null,
          },
        ],
      })
      .mockResolvedValue({ items: [] })
    const apiClient = {
      getEvaluationRun: vi.fn().mockResolvedValue(initialRun),
      saveEvaluationJudgment: vi.fn().mockResolvedValue(nextRun),
      listCandidateEvidence,
      createCandidateEvidence: vi.fn(),
      cancelCandidateEvidence: vi.fn(),
      candidateEvidenceArtifactUrl: vi.fn(),
      mediaContentUrl: vi.fn((id: string) => `http://local/${id}`),
    } as unknown as ReturnType<typeof createApiClient>
    render(<EvaluationWorkspace initialSets={[]} libraries={[]} apiClient={apiClient} />)

    fireEvent.change(screen.getByLabelText('评测运行 ID'), { target: { value: 'run-1' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复盲标' }))
    expect(await screen.findByRole('button', { name: '取消此候选的证据构建' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '高度相关' }))
    await waitFor(() =>
      expect(listCandidateEvidence).toHaveBeenLastCalledWith(
        expect.objectContaining({ source_id: 'candidate-2', candidate_key: 'video:scene-2' }),
        expect.anything(),
      ),
    )
    expect(screen.queryByRole('button', { name: '取消此候选的证据构建' })).not.toBeInTheDocument()
  })
})
