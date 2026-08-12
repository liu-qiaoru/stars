import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CandidateEvidencePanel } from '../components/candidate-evidence-panel'

const source = { type: 'agent_run_candidate' as const, run_id: 'run-1' }

function evidence(status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') {
  return {
    id: 'evidence-1',
    candidate_key: 'video:scene-1',
    file_id: 'file-1',
    file_generation: 3,
    asset_id: 'asset-1',
    scene_id: 'scene-1',
    job_id: 'job-1',
    status,
    strategy: 'contact_sheet_v1' as const,
    protocol_version: 'candidate-evidence-v1',
    frame_count: status === 'succeeded' ? 6 : null,
    artifact_url: status === 'succeeded' ? '/candidate-evidence/evidence-1/artifact' : null,
    error: status === 'failed' ? { code: 'SOURCE_FILE_MISSING', message: '源视频不存在' } : null,
  }
}

function client(initialItems = [] as ReturnType<typeof evidence>[]) {
  return {
    createCandidateEvidence: vi.fn().mockResolvedValue({ items: [evidence('queued')] }),
    listCandidateEvidence: vi.fn().mockResolvedValue({ items: initialItems }),
    cancelCandidateEvidence: vi.fn().mockResolvedValue(evidence('cancelled')),
    candidateEvidenceArtifactUrl: vi.fn((id: string) => `http://local/${id}/artifact`),
  }
}

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

describe('CandidateEvidencePanel', () => {
  test('does not create evidence on render and exposes an accessible explicit action', async () => {
    const api = client()
    render(<CandidateEvidencePanel source={source} candidateKey="video:scene-1" apiClient={api} />)

    await waitFor(() => expect(api.listCandidateEvidence).toHaveBeenCalledTimes(1))
    expect(api.createCandidateEvidence).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: '准备此候选的本地视觉证据' })
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    await waitFor(() =>
      expect(api.createCandidateEvidence).toHaveBeenCalledWith({
        source,
        candidate_key: 'video:scene-1',
        strategies: ['contact_sheet_v1', 'all_indexed_frames_v1'],
      }),
    )
    expect(screen.getByText('等待准备')).toBeInTheDocument()
    expect(screen.getByText(/尚未执行 Rerank/)).toBeInTheDocument()
    expect(screen.getByText(/尚未执行 VLM/)).toBeInTheDocument()
  })

  test.each([
    ['running', '正在构建'],
    ['failed', '证据准备失败'],
    ['cancelled', '证据准备已取消'],
  ] as const)(
    'shows the %s state and structured errors without model conclusions',
    async (status, label) => {
      const api = client([evidence(status)])
      render(
        <CandidateEvidencePanel source={source} candidateKey="video:scene-1" apiClient={api} />,
      )

      expect(await screen.findByText(label)).toBeInTheDocument()
      if (status === 'failed') expect(screen.getByText(/SOURCE_FILE_MISSING/)).toBeInTheDocument()
      expect(screen.queryByText(/模型判断通过|候选符合条件|审核完成/)).not.toBeInTheDocument()
    },
  )

  test('restores a completed contact sheet and stops polling at the terminal state', async () => {
    const api = client([evidence('succeeded')])
    render(
      <CandidateEvidencePanel
        source={source}
        candidateKey="video:scene-1"
        apiClient={api}
        pollIntervalMs={10}
      />,
    )
    expect(await screen.findByText('证据准备完成')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '当前候选的本地时间戳拼图证据' })).toHaveAttribute(
      'src',
      'http://local/evidence-1/artifact',
    )
    expect(api.listCandidateEvidence).toHaveBeenCalledTimes(1)

    fireEvent.error(screen.getByRole('img', { name: '当前候选的本地时间戳拼图证据' }))
    expect(screen.getByRole('alert')).toHaveTextContent('本地证据预览加载失败')
  })

  test('pauses while hidden, refreshes immediately when visible, and aborts on unmount', async () => {
    vi.useFakeTimers()
    const api = client([evidence('running')])
    let visibility = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    const view = render(
      <CandidateEvidencePanel
        source={source}
        candidateKey="video:scene-1"
        apiClient={api}
        pollIntervalMs={10}
      />,
    )
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(api.listCandidateEvidence).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(api.listCandidateEvidence).toHaveBeenCalledTimes(2)

    const lastOptions = api.listCandidateEvidence.mock.calls.at(-1)?.[1]
    view.unmount()
    expect(lastOptions?.signal.aborted).toBe(true)
  })
})
