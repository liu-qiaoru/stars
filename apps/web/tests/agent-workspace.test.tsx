import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentWorkspace } from '../components/agent-workspace'

const settings = {
  provider: 'rightapi' as const,
  model: 'qwen3.7-plus' as const,
  prompt_version: 'agent-intent-v1',
  schema_version: 'agent-intent-schema-v1',
  api_key: { configured: true },
  capabilities: {
    external_text_available: true,
    external_visual_available: false as const,
    rerank_available: false as const,
    vlm_review_available: false as const,
    unavailable_reasons: [],
  },
  editable: {
    enabled: true,
    tool_timeout_ms: 10_000,
    lease_duration_ms: 130_000,
    activity_timeout_ms: 120_000,
    waiting_ttl_seconds: 604_800,
    executor_interval_ms: 2_000,
    web_poll_interval_ms: 2_000,
  },
  apply_behavior: {},
  frozen: {},
  persistence: 'process' as const,
}

function terminalRun() {
  return {
    id: 'run-1',
    status: 'succeeded',
    prompt: '查找片段',
    summary: '找到候选视频片段',
    tool_calls: [],
    events: [],
    candidates: [],
  }
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    getAgentSettings: vi.fn().mockResolvedValue(settings),
    createAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'queued' }),
    getAgentRun: vi.fn().mockResolvedValue(terminalRun()),
    startAgentRerank: vi.fn(),
    getAgentRerank: vi.fn().mockResolvedValue(null),
    saveAgentRerankFeedback: vi.fn(),
    selectAgentExport: vi.fn(),
    confirmAgentExport: vi.fn(),
    getJob: vi.fn(),
    retryUnknownAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    createCandidateEvidence: vi.fn().mockResolvedValue({ items: [] }),
    listCandidateEvidence: vi.fn().mockResolvedValue({ items: [] }),
    cancelCandidateEvidence: vi.fn(),
    candidateEvidenceArtifactUrl: vi.fn((id: string) => `http://media.test/evidence/${id}`),
    mediaContentUrl: vi.fn(
      (
        id: string,
        range: { startTimeSeconds?: number | null; endTimeSeconds?: number | null } = {},
      ) =>
        `http://media.test/media/${id}/content#t=${range.startTimeSeconds},${range.endTimeSeconds}`,
    ),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('AgentWorkspace', () => {
  test('创建 run 时明确授权本次文本外发，并展示独立 run 状态', async () => {
    const apiClient = client()
    render(<AgentWorkspace apiClient={apiClient} />)

    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找片段' } })
    fireEvent.click(screen.getByRole('button', { name: /启动任务/i }))

    await waitFor(() => {
      expect(apiClient.createAgentRun).toHaveBeenCalledWith({
        prompt: '查找片段',
        allow_external_text: true,
        allow_external_visual: false,
        media_types: ['image', 'video', 'audio'],
      })
    })
    expect(await screen.findByText('succeeded')).toBeInTheDocument()
    expect(screen.getByText(/RRF 始终先返回/i)).toBeInTheDocument()
  })

  test('用户开启 Rerank 后展示两套名次并保存三选一反馈', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      candidate_key: `image:asset-${index + 1}`,
      file_id: `file-${index + 1}`,
      file_generation: 0,
      asset_id: `asset-${index + 1}`,
      scene_id: null,
      scene_start_seconds: null,
      scene_end_seconds: null,
      rank: index + 1,
      retrieval: { score: 1 / (60 + index + 1) },
      review_status: 'not_run' as const,
    }))
    const completedRun = {
      ...terminalRun(),
      status: 'waiting_for_export_selection',
      candidates,
    }
    const rerankResult = {
      id: 'rerank-1',
      agent_run_id: 'run-1',
      status: 'succeeded' as const,
      external_call_status: 'completed' as const,
      provider: 'dashscope',
      requested_model: 'qwen3-vl-rerank',
      provider_request_id: 'fake-request',
      request_bytes: 100,
      total_tokens: 100,
      estimated_cost_cny: 0.00018,
      latency_ms: 20,
      error: null,
      rankings: candidates.map((candidate, index) => ({
        candidate_key: candidate.candidate_key,
        rrf_rank: candidate.rank,
        rerank_rank: index < 10 ? 10 - index : null,
        relevance_score: index < 10 ? 1 - index / 10 : null,
      })),
      feedback: null,
    }
    const apiClient = client({
      getAgentSettings: vi.fn().mockResolvedValue({
        ...settings,
        capabilities: {
          ...settings.capabilities,
          external_visual_available: true,
          rerank_available: true,
        },
      }),
      getAgentRun: vi.fn().mockResolvedValue(completedRun),
      startAgentRerank: vi.fn().mockResolvedValue(rerankResult),
      saveAgentRerankFeedback: vi
        .fn()
        .mockImplementation((_id, { verdict }) =>
          Promise.resolve({ ...rerankResult, feedback: verdict }),
        ),
    })
    render(<AgentWorkspace apiClient={apiClient} />)

    await waitFor(() => expect(screen.getByLabelText(/开启实验性 Rerank/i)).toBeEnabled())
    fireEvent.click(screen.getByLabelText(/开启实验性 Rerank/i))
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找图片' } })
    fireEvent.click(screen.getByRole('button', { name: /启动任务/i }))

    await waitFor(() => {
      expect(apiClient.createAgentRun).toHaveBeenCalledWith({
        prompt: '查找图片',
        allow_external_text: true,
        allow_external_visual: true,
        media_types: ['image', 'video'],
      })
      expect(apiClient.startAgentRerank).toHaveBeenCalledWith('run-1', {
        confirmed: true,
        max_cost_cny: 0.216,
      })
    })
    expect(await screen.findByText('RRF 1')).toBeInTheDocument()
    expect(await screen.findByText('Rerank 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rerank 更好' }))
    await waitFor(() =>
      expect(apiClient.saveAgentRerankFeedback).toHaveBeenCalledWith('rerank-1', {
        verdict: 'rerank_better',
      }),
    )
  })

  test('页面重新挂载只用持久化 run_id 读取 Server 状态，不重新创建 run', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-persisted')
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), id: 'run-persisted' }),
    })

    render(<AgentWorkspace apiClient={apiClient} />)

    expect(await screen.findByText('run_id: run-persisted')).toBeInTheDocument()
    expect(apiClient.getAgentRun).toHaveBeenCalledWith(
      'run-persisted',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(apiClient.createAgentRun).not.toHaveBeenCalled()
  })

  test('结果未知时提供重新执行入口', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-unknown')
    const unknownRun = {
      ...terminalRun(),
      id: 'run-unknown',
      status: 'outcome_unknown',
      error: { code: 'AGENT_INTENT_OUTCOME_UNKNOWN', message: '请求结果未知' },
      steps: [
        { step_attempt_id: 'step-unknown', step: 'extracting_intent', status: 'outcome_unknown' },
      ],
    }
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValue(unknownRun),
      retryUnknownAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-unknown', status: 'queued' }),
    })
    render(<AgentWorkspace apiClient={apiClient} />)

    fireEvent.click(await screen.findByRole('button', { name: '重新执行' }))

    await waitFor(() =>
      expect(apiClient.retryUnknownAgentRun).toHaveBeenCalledWith('run-unknown', {
        step_attempt_id: 'step-unknown',
        client_request_id: expect.any(String),
      }),
    )
  })

  test('结果未知时可以放弃并读取 cancelled 终态', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-unknown')
    const unknownRun = {
      ...terminalRun(),
      id: 'run-unknown',
      status: 'outcome_unknown',
      error: { code: 'AGENT_INTENT_OUTCOME_UNKNOWN', message: '请求结果未知' },
      steps: [
        { step_attempt_id: 'step-unknown', step: 'extracting_intent', status: 'outcome_unknown' },
      ],
    }
    const cancelledRun = { ...unknownRun, status: 'cancelled' }
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValueOnce(unknownRun).mockResolvedValue(cancelledRun),
      cancelAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-unknown', status: 'cancelled' }),
    })
    render(<AgentWorkspace apiClient={apiClient} />)

    fireEvent.click(await screen.findByRole('button', { name: '放弃本次任务' }))

    await waitFor(() =>
      expect(apiClient.cancelAgentRun).toHaveBeenCalledWith('run-unknown', {
        client_request_id: expect.any(String),
        reason: '用户放弃结果未知的任务',
      }),
    )
    expect(await screen.findByText('cancelled')).toBeInTheDocument()
  })

  test('刷新后从持久化 tool call 恢复 Server 冻结预览和确认入口', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-confirming')
    const apiClient = client({
      confirmAgentExport: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
      getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'queued', progress: 0 }),
      getAgentRun: vi.fn().mockResolvedValue({
        ...terminalRun(),
        id: 'run-confirming',
        status: 'waiting_for_confirmation',
        waiting_step_id: 'wait-1',
        candidates: [
          {
            candidate_key: 'video:scene-1',
            file_id: 'file-1',
            file_generation: 3,
            asset_id: 'asset-1',
            scene_id: 'scene-1',
            scene_start_seconds: 10,
            scene_end_seconds: 30,
            rank: 1,
            retrieval: {},
            review_status: 'not_run',
          },
        ],
        tool_calls: [
          {
            tool_call_id: 'export-1',
            name: 'export_clip',
            status: 'waiting_for_confirmation',
            summary: 'preview',
            requires_confirmation: true,
            preview: {
              candidate_key: 'video:scene-1',
              file_id: 'file-1',
              file_generation: 3,
              scene_id: 'scene-1',
              scene_start_seconds: 10,
              scene_end_seconds: 30,
              start_time_seconds: 12,
              end_time_seconds: 18,
              output_format: 'mp4',
              requires_confirmation: true,
            },
          },
        ],
      }),
    })

    render(<AgentWorkspace apiClient={apiClient} />)

    expect(await screen.findByText(/Server 冻结预览：12–18 秒/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /确认并创建导出 Job/i }))
    await waitFor(() =>
      expect(apiClient.confirmAgentExport).toHaveBeenCalledWith('run-confirming', {
        waiting_step_id: 'wait-1',
        tool_call_id: 'export-1',
        client_request_id: expect.any(String),
      }),
    )
  })

  test('视频候选可预览场景片段，并可用带标签控件选择时间范围', async () => {
    const waitingRun = {
      ...terminalRun(),
      status: 'waiting_for_export_selection',
      intent: {
        goal: 'export_clip',
        search_scope: 'visual',
        media_types: ['video'],
        conditions: [],
      },
      resolved_scope: { search_scope: 'visual', media_types: ['video'], library_ids: ['lib-1'] },
      conditions: [
        {
          condition_id: 'condition-1',
          source_text: '红色汽车',
          kind: 'must_have',
          evidence_type: 'visual',
        },
      ],
      candidates: [
        {
          candidate_key: 'video:scene-1',
          file_id: 'file-1',
          file_generation: 3,
          asset_id: 'asset-1',
          scene_id: 'scene-1',
          scene_start_seconds: 10,
          scene_end_seconds: 30,
          rank: 1,
          retrieval: { score: 0.031, score_kind: 'rrf_score', reasons: ['vector_match'] },
          review_status: 'not_run' as const,
        },
      ],
    }
    const confirmationRun = { ...waitingRun, status: 'waiting_for_confirmation' }
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValueOnce(waitingRun).mockResolvedValue(confirmationRun),
      selectAgentExport: vi.fn().mockResolvedValue({
        waiting_step_id: 'wait-1',
        tool_call_id: 'export-1',
        status: 'waiting_for_confirmation',
        preview: {
          candidate_key: 'video:scene-1',
          file_id: 'file-1',
          file_generation: 3,
          scene_id: 'scene-1',
          scene_start_seconds: 10,
          scene_end_seconds: 30,
          start_time_seconds: 12,
          end_time_seconds: 18,
          output_format: 'mp4',
          requires_confirmation: true,
        },
      }),
    })
    render(<AgentWorkspace apiClient={apiClient} />)
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '导出红车片段' } })
    fireEvent.click(screen.getByRole('button', { name: /启动任务/i }))

    const candidateButton = await screen.findByRole('button', { name: /选择候选 1/i })
    // 回归截图中的 Phase C 缺口：候选已有 file_id 和场景边界时，页面必须提供真实
    // 视频控件，而不能只显示文字证据。固定字面 URL 同时验证时间片段没有丢失。
    const video = screen.getByLabelText('播放候选 1，场景 10–30 秒')
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('src', 'http://media.test/media/file-1/content#t=10,30')
    expect(apiClient.mediaContentUrl).toHaveBeenCalledWith('file-1', {
      startTimeSeconds: 10,
      endTimeSeconds: 30,
    })
    candidateButton.focus()
    expect(candidateButton).toHaveFocus()
    expect(screen.getByText('尚未审核')).toBeInTheDocument()
    expect(screen.getByText('未验证条件')).toBeInTheDocument()
    expect(screen.getByText(/RRF.*只表示排序，不是相关概率/)).toBeInTheDocument()
    fireEvent.click(candidateButton)
    expect(screen.getByLabelText('开始时间（秒）')).toHaveValue(10)
    expect(screen.getByLabelText('结束时间（秒）')).toHaveValue(30)
    fireEvent.change(screen.getByLabelText('开始时间（秒）'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('结束时间（秒）'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: /生成确认预览/i }))

    await waitFor(() =>
      expect(apiClient.selectAgentExport).toHaveBeenCalledWith('run-1', {
        candidate_key: 'video:scene-1',
        start_time_seconds: 12,
        end_time_seconds: 18,
        output_format: 'mp4',
      }),
    )
    expect(await screen.findByText(/Server 冻结预览：12–18 秒/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /确认并创建导出 Job/i })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('结束时间（秒）'), { target: { value: '19' } })
    expect(screen.queryByRole('button', { name: /确认并创建导出 Job/i })).not.toBeInTheDocument()
  })

  test('约 2 秒轮询；页面隐藏时暂停，恢复可见立即刷新，终态停止', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    const queued = { ...terminalRun(), status: 'queued' }
    const searching = { ...terminalRun(), status: 'searching' }
    const apiClient = client({
      getAgentRun: vi
        .fn()
        .mockResolvedValueOnce(queued)
        .mockResolvedValueOnce(searching)
        .mockResolvedValue(terminalRun()),
    })
    render(<AgentWorkspace apiClient={apiClient} />)
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '找视频' } })
    fireEvent.click(screen.getByRole('button', { name: /启动任务/i }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {
      vi.advanceTimersByTime(4_000)
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(3)
    await act(async () => {
      vi.advanceTimersByTime(6_000)
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(3)
  })
})
