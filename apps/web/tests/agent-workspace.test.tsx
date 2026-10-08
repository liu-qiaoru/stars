import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentWorkspace } from '../components/agent-workspace'

const settings = {
  provider: 'rightapi' as const,
  model: 'glm-5.3' as const,
  prompt_version: 'agent-intent-v1',
  schema_version: 'agent-intent-schema-v1',
  api_key: { configured: true },
  capabilities: {
    external_text_available: true,
    external_visual_available: true as const,
    rerank_available: true as const,
    unavailable_reasons: [],
  },
  editable: {
    enabled: true,
    tool_timeout_ms: 10_000,
    model_timeout_ms: 60_000,
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
    selectAgentExport: vi.fn(),
    confirmAgentExport: vi.fn(),
    getJob: vi.fn(),
    retryUnknownAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    resumeAgentRun: vi.fn(),
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

    await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找片段' } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))

    await waitFor(() => {
      expect(apiClient.createAgentRun).toHaveBeenCalledWith({
        prompt: '查找片段',
        allow_external_text: true,
        allow_external_visual: false,
        allow_external_media_text: false,
        workflow: 'retrieval_agent',
        media_types: ['image', 'video', 'audio'],
      })
    })
    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(screen.getByText(/每次结果都会保留在当前对话中/i)).toBeInTheDocument()
  })

  test('原有重排流程只展示最终名次且不显示 RRF 对照结果', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      candidate_key: `image:asset-${index + 1}`,
      file_id: `file-${index + 1}`,
      file_generation: 0,
      asset_id: `asset-${index + 1}`,
      scene_id: null,
      scene_start_seconds: null,
      scene_end_seconds: null,
      rank: index + 1,
    }))
    const completedRun = {
      ...terminalRun(),
      status: 'waiting_for_export_selection',
      candidates,
    }
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValue(completedRun),
    })
    render(<AgentWorkspace apiClient={apiClient} />)

    await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('radio', { name: '检索与导出', hidden: true }))
    fireEvent.click(screen.getByLabelText('允许智能重排'))
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找图片' } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))

    await waitFor(() => {
      expect(apiClient.createAgentRun).toHaveBeenCalledWith({
        prompt: '查找图片',
        allow_external_text: true,
        allow_external_visual: true,
        allow_external_media_text: false,
        workflow: 'legacy',
        media_types: ['image', 'video'],
      })
    })
    expect(await screen.findByText('结果 1')).toBeInTheDocument()
    expect(screen.queryByText(/原 RRF/i)).not.toBeInTheDocument()
  })

  test('普通检索已结束时不提供会被 Server 拒绝的导出候选入口', async () => {
    const completedSearch = {
      ...terminalRun(),
      status: 'succeeded',
      candidates: [{
        candidate_key: 'video:scene-1',
        file_id: 'file-1',
        file_generation: 1,
        asset_id: 'asset-1',
        scene_id: 'scene-1',
        scene_start_seconds: 10,
        scene_end_seconds: 30,
        rank: 1,
      }],
    }
    const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue(completedSearch) })
    render(<AgentWorkspace apiClient={apiClient} />)

    await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找红色汽车' } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))

    expect(await screen.findByText('结果 1')).toBeInTheDocument()
    // Server 仅允许 waiting_for_export_selection 状态选择导出。普通搜索的 succeeded
    // Run 如果仍展示此按钮，用户点击后就会收到 AGENT_EXPORT_SELECTION_REJECTED。
    expect(screen.queryByRole('button', { name: /选择候选 1/i })).not.toBeInTheDocument()
  })

  test('得到候选后可在底部继续检索，并保留当前页面中的上一轮对话', async () => {
    const firstRun = {
      ...terminalRun(),
      id: 'run-1',
      status: 'waiting_for_export_selection',
      prompt: '第一轮：找海边日落',
      summary: '第一轮找到 3 条候选',
    }
    const secondRun = {
      ...terminalRun(),
      id: 'run-2',
      prompt: '第二轮：找红色汽车',
      summary: '第二轮找到 2 条候选',
    }
    const apiClient = client({
      createAgentRun: vi.fn()
        .mockResolvedValueOnce({ run_id: 'run-1', status: 'queued' })
        .mockResolvedValueOnce({ run_id: 'run-2', status: 'queued' }),
      getAgentRun: vi.fn().mockResolvedValueOnce(firstRun).mockResolvedValueOnce(secondRun),
    })
    render(<AgentWorkspace apiClient={apiClient} />)

    await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
    const composer = screen.getByLabelText('完整用户请求')
    fireEvent.change(composer, { target: { value: firstRun.prompt } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))
    expect(await screen.findByText(firstRun.summary)).toBeInTheDocument()

    // waiting_for_export_selection 已经得到检索结果，不应锁住下一轮输入，也不需要继续轮询。
    expect(screen.getByRole('button', { name: /发送检索请求/i })).toBeDisabled()
    fireEvent.change(composer, { target: { value: secondRun.prompt } })
    expect(screen.getByRole('button', { name: /发送检索请求/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))

    expect(await screen.findByText(secondRun.summary)).toBeInTheDocument()
    expect(screen.getByText(firstRun.summary)).toBeInTheDocument()
    expect(screen.getByLabelText(`历史检索：${firstRun.prompt}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`检索：${secondRun.prompt}`)).toBeInTheDocument()
    expect(screen.queryByText('你')).not.toBeInTheDocument()
    expect(apiClient.createAgentRun).toHaveBeenCalledTimes(2)
  })

  test('页面重新挂载只用持久化 run_id 读取 Server 状态，不重新创建 run', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-persisted')
    const apiClient = client({
      getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), id: 'run-persisted' }),
    })

    render(<AgentWorkspace apiClient={apiClient} />)

    expect(await screen.findByText('任务编号：run-persisted')).toBeInTheDocument()
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
    expect(await screen.findByText('已取消')).toBeInTheDocument()
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

    expect(await screen.findByText(/服务端已确认 12 至 18 秒/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /确认并创建导出任务/i }))
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
    await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '导出红车片段' } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))

    const candidateButton = await screen.findByRole('button', { name: /选择候选 1/i })
    // 回归截图中的 Phase C 缺口：候选已有 file_id 和场景边界时，页面必须提供真实
    // 视频控件，而不能只显示文字证据。固定字面 URL 同时验证时间片段没有丢失。
    const video = screen.getByLabelText('播放候选 1，场景 10 至 30 秒')
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('src', 'http://media.test/media/file-1/content#t=10,30')
    expect(apiClient.mediaContentUrl).toHaveBeenCalledWith('file-1', {
      startTimeSeconds: 10,
      endTimeSeconds: 30,
    })
    candidateButton.focus()
    expect(candidateButton).toHaveFocus()
    expect(screen.getByText('智能重排')).toBeInTheDocument()
    expect(screen.getByText('必须满足')).toBeInTheDocument()
    expect(screen.getByText(/只展示最终重排后的顺序/i)).toBeInTheDocument()
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
    expect(await screen.findByText(/服务端已确认 12 至 18 秒/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /确认并创建导出任务/i })).toBeEnabled()
    expect(screen.getByLabelText('开始时间（秒）')).toBeDisabled()
    expect(screen.getByLabelText('结束时间（秒）')).toBeDisabled()
    expect(screen.getByLabelText('结束时间（秒）')).toHaveValue(18)
    expect(screen.queryByRole('button', { name: /生成确认预览/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /确认并创建导出任务/i })).toBeEnabled()
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
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '找视频' } })
    fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(apiClient.getAgentRun).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('检索进行中')).toHaveTextContent('请求已进入队列')

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


describe('检索 Agent 多轮交互', () => {
  test('明确显示原条件缺口、下一步原因和未验收基线；未知外发不冒充重排成功', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'outcome_unknown',
      conditions: [{ condition_id: 'c', source_text: '趴在猫爬架上', kind: 'must_have', evidence_type: 'visual' }],
      retrieval: { pending: null, tool_calls: 2, model_calls: 1, queries: [], details: {},
        result_mode: 'baseline', fallback_reason: 'external_outcome_unknown', final_rerank_status: 'not_completed',
        gaps: [{ step_id: 'step', action: 'get_segment_details', gap: { condition_ids: ['c'], kind: 'details_unread',
          checked: [], missing_evidence: '已有描述没有说明趴在上面', next_step_reason: '读取其他候选的位置关系', preserves_original_goal: true } }] } }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    expect(await screen.findByText(/当前采用原文基线/)).toBeInTheDocument()
    // 默认不铺开长日志，但结果保底和失败说明仍直接可见。
    expect(screen.getByText(/缺口条件：趴在猫爬架上/)).not.toBeVisible()
    expect(screen.getByText(/当前采用原文基线/)).toBeVisible()
    expect(screen.getByText(/最终图片重排未完成/)).toBeVisible()
    const log = screen.getByText('检索过程').closest('details')!
    expect(log.open).toBe(false)
    log.open = true
    fireEvent(log, new Event('toggle'))
    expect(screen.getByText(/缺口条件：趴在猫爬架上/)).toBeVisible()
    expect(screen.getByText(/读取其他候选的位置关系/)).toBeInTheDocument()
    expect(screen.getByText(/最终图片重排未完成/)).toBeInTheDocument()
    expect(screen.queryByText('只展示最终重排后的顺序；排序不代表已经满足全部条件。')).not.toBeInTheDocument()
  })
  test.each(['partial', 'visual_evidence_unverified'])('文字命中不展示为视觉已找到，最终重排后仍明确描述核实边界：%s', async stopReason => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(),
      conditions: [{ condition_id: 'c', source_text: '厨房灶台前操作', kind: 'must_have', evidence_type: 'visual' }],
      retrieval: { pending: null, tool_calls: 2, model_calls: 2, queries: [], details: {},
        result_mode: 'baseline', fallback_reason: 'quality_not_accepted', final_rerank_status: 'succeeded',
        stop_reason: stopReason,
        visual_verification: { status: 'unverified', reason: 'text_only_tools', model_stop_reason: 'found' },
        assessments: [{ candidate_key: 'candidate', conditions: [{ condition_id: 'c', status: 'satisfied', evidence_ids: ['caption'] }] }] } }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    expect(await screen.findByText('画面核实状态：未核实，仅有文字线索。')).toBeInTheDocument()
    expect(screen.getByText(/文字线索支持（模型判断）/)).toBeInTheDocument()
    expect(screen.getByText(/描述可能误认对象、位置或动作/)).toBeInTheDocument()
    expect(screen.queryByText(/增强停止原因：已找到/)).not.toBeInTheDocument()
  })
  test('多轮入口可同时明确授权文字和最终图片重排', async () => {
    const apiClient = client()
    render(<AgentWorkspace apiClient={apiClient} />)
    await waitFor(() => expect(screen.getByLabelText('允许智能重排')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('允许发送素材文字用于多轮判断'))
    fireEvent.click(screen.getByLabelText('允许智能重排'))
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '小猫趴在猫爬架上' } })
    fireEvent.click(screen.getByRole('button', { name: '发送检索请求' }))
    await waitFor(() => expect(apiClient.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'retrieval_agent', allow_external_media_text: true, allow_external_visual: true,
    })))
  })
  test('最终授权等待只提交图片授权，不要求重新补充检索目标', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ resumeAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'queued' }),
      getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'waiting_for_user_input', waiting_step_id: 'waiting-1',
        clarification_question: '请授权最终图片重排', retrieval: { pending: null, tool_calls: 4, model_calls: 3,
          awaiting_rerank_authorization: true, queries: [], details: {} } }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    const button = await screen.findByRole('button', { name: '授权并开始最终重排' })
    expect(button).toBeDisabled()
    expect(screen.queryByLabelText('补充要求')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('允许最终图片重排'))
    fireEvent.click(button)
    await waitFor(() => expect(apiClient.resumeAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
      response: '开始最终重排', allow_external_visual: true,
    })))
  })
  test('不要求图片授权，素材文字默认未授权', async () => {
    const apiClient = client({ getAgentSettings: vi.fn().mockResolvedValue({ ...settings, capabilities: { ...settings.capabilities, rerank_available: false } }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '找红色汽车' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送检索请求' })).toBeEnabled())
    expect(screen.getByLabelText('允许发送素材文字用于多轮判断')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '发送检索请求' }))
    await waitFor(() => expect(apiClient.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'retrieval_agent', allow_external_visual: false, allow_external_media_text: false })))
  })
  test('展示澄清问题、提交真实回答和单独授权，再恢复当前任务', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ resumeAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'queued' }),
      getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'waiting_for_user_input', waiting_step_id: 'waiting-1', clarification_question: '只找白天吗？' }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    expect(await screen.findByText('只找白天吗？')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('补充要求'), { target: { value: '是，只找白天' } })
    fireEvent.click(screen.getByLabelText(/允许向 RightAPI glm-5.3/))
    fireEvent.click(screen.getByRole('button', { name: '补充并继续' }))
    await waitFor(() => expect(apiClient.resumeAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ waiting_step_id: 'waiting-1', response: '是，只找白天', allow_external_media_text: true })))
  })
  test('运行时取消使用当前 run 身份', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'searching' }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    fireEvent.click(await screen.findByRole('button', { name: '取消任务' }))
    await waitFor(() => expect(apiClient.cancelAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ client_request_id: expect.any(String) })))
  })
  test('显示不确定判断、来源文字和截断标志，不展示模型内部思考', async () => {
    window.localStorage.setItem('agent:last-run-id', 'run-1')
    const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), conditions: [{ condition_id: 'c', source_text: '连续超车', kind: 'must_have', evidence_type: 'visual' }],
      retrieval: { pending: null, tool_calls: 2, model_calls: 3, stop_reason: 'insufficient_evidence', queries: [],
        assessments: [{ candidate_key: 'video:s', conditions: [{ condition_id: 'c', status: 'unknown', evidence_ids: ['e'] }] }],
        details: { 'video:s': { status: 'available', truncated: true, evidence: [{ evidence_id: 'e', source: 'pre_generated_caption', text: '汽车在道路上', start_seconds: 5, end_seconds: 10, crosses_scene_boundary: false, truncated: true }] } } } }) })
    render(<AgentWorkspace apiClient={apiClient} />)
    expect(await screen.findByText(/证据不足，仍不确定/)).toBeInTheDocument()
    expect(screen.getByText(/预生成画面描述：汽车在道路上/)).toHaveTextContent('内容已截断')
    expect(screen.getByText(/未检查连续视频动作/)).toBeInTheDocument()
  })
})


test('取消等待期间继续轮询到终态，不把取消中误报为无结果', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const apiClient = client({getAgentRun: vi.fn().mockResolvedValueOnce({...terminalRun(), status:'cancel_requested', workflow:'retrieval_agent'}).mockResolvedValue({...terminalRun(),status:'cancelled'})})
  render(<AgentWorkspace apiClient={apiClient} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByText('正在取消')).toBeInTheDocument()
  expect(screen.queryByText('本次没有找到符合条件的内容。')).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  expect(screen.getByText('已取消')).toBeInTheDocument()
  expect(apiClient.getAgentRun).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(apiClient.getAgentRun).toHaveBeenCalledTimes(2)
})

test('等待结果时展示真实步骤，轮询追加排名融合并保留展开状态', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const created = { id: 'created', label: '创建任务', status: 'succeeded', started_at: '2026-10-02T00:00:00Z', finished_at: '2026-10-02T00:00:00Z', parent_id: null }
  const searching = { ...created, id: 'search', label: '执行检索', status: 'running', finished_at: null }
  const rrf = { ...created, id: 'rrf', label: 'RRF 排名融合', parent_id: 'search' }
  const retrieval = { pending: 'get_segment_details', tool_calls: 1, model_calls: 1, queries: [], details: {} }
  const getAgentRun = vi.fn().mockResolvedValueOnce({ ...terminalRun(), status: 'searching', retrieval, progress: [created, searching] })
    .mockResolvedValue({ ...terminalRun(), retrieval: { ...retrieval, pending: null, tool_calls: 2 }, progress: [created, { ...searching, status: 'succeeded' }, rrf] })
  render(<AgentWorkspace apiClient={client({ getAgentRun })} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByText('创建任务')).toBeInTheDocument()
  expect(screen.getAllByText('执行检索').some(element => element.closest('summary'))).toBe(true)
  const details = screen.getByText('运行详情').closest('details')!
  expect(details.open).toBe(false)
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(screen.getByRole('list', { name: 'Agent 执行步骤' })).toBeVisible()
  expect(screen.queryByText('Rerank 候选重排')).not.toBeInTheDocument()
  // 两个面板分别保持选择：运行时间线收起，检索长日志展开。
  const retrievalLog = screen.getByText('检索过程').closest('details')!
  expect(retrievalLog.open).toBe(false)
  expect(screen.getByText('准备读取详情')).toBeVisible()
  retrievalLog.open = true
  fireEvent(retrievalLog, new Event('toggle'))
  // 模拟用户收起；后续轮询不应把它重新打开。
  details.open = false
  fireEvent(details, new Event('toggle'))
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  expect(screen.getByText('RRF 排名融合')).toBeInTheDocument()
  expect(details.open).toBe(false)
  expect(retrievalLog.open).toBe(true)
  expect(screen.getByText('2 次工具操作')).toBeVisible()
  expect(screen.getByText('已停止执行')).toBeVisible()
  expect(screen.queryByText('进行中')).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(getAgentRun).toHaveBeenCalledTimes(2)
})

test('检索设置默认收起，切换方式仅显示对应授权且不会携带隐藏授权', async () => {
  const apiClient = client()
  render(<AgentWorkspace apiClient={apiClient} />)
  await waitFor(() => expect(apiClient.getAgentSettings).toHaveBeenCalled())
  const disclosure = screen.getByText('检索设置').closest('details')!
  expect(disclosure.open).toBe(false)
  expect(screen.getByRole('radio', { name: '多轮检索', hidden: true })).toBeChecked()
  expect(screen.getByRole('radio', { name: '检索与导出', hidden: true })).not.toBeChecked()
  disclosure.open = true
  fireEvent(disclosure, new Event('toggle'))
  expect(screen.getByLabelText('允许智能重排')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('允许发送素材文字用于多轮判断'))
  fireEvent.click(screen.getByRole('radio', { name: '检索与导出', hidden: true }))
  expect(screen.queryByLabelText('允许发送素材文字用于多轮判断')).not.toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('允许智能重排'))
  fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '查找片段' } })
  fireEvent.click(screen.getByRole('button', { name: '发送检索请求' }))
  await waitFor(() => expect(apiClient.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'legacy', allow_external_visual: true, allow_external_media_text: false })))
})

test('预算停止与最终重排状态分开，页面显示各类实际次数且不宣称条件已验证', async () => {
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), workflow: 'retrieval_agent',
    retrieval: { pending: null, queries: [], details: {}, assessments: [], stop_reason: 'tool_limit',
      result_mode: 'baseline', fallback_reason: 'tool_limit', final_rerank_status: 'succeeded', tool_calls: 4, model_calls: 3,
      budget: { limits: { maximum_tools: 4, maximum_searches: 3, maximum_details: 6, maximum_models: 8 }, searches: 1, details: 3 } } }) })
  render(<AgentWorkspace apiClient={apiClient as never} />)
  expect(await screen.findByText('增强停止原因：增强检查预算已用完')).toBeTruthy()
  expect(screen.getByText('搜索 1/3；详情 3/6；决策 3/8；工具总计 4/4。')).toBeTruthy()
  expect(screen.getByText(/预算停止不代表原始条件已确认/)).toBeTruthy()
})

test('费用预留不足明确说明保留基线，不能呈现为增强验证成功', async () => {
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), workflow: 'retrieval_agent',
    retrieval: { pending: null, queries: [], details: {}, assessments: [], stop_reason: 'cost_limit',
      result_mode: 'baseline', fallback_reason: 'quality_not_accepted', final_rerank_status: 'succeeded', tool_calls: 1, model_calls: 0 } }) })
  render(<AgentWorkspace apiClient={apiClient as never} />)
  expect(await screen.findByText('增强停止原因：费用预留不足，已停止增强并保留基线')).toBeTruthy()
  expect(screen.getByText(/当前采用原文基线。原因/)).toBeTruthy()
})

test('部分匹配结束展示涉及原条件及不再补搜/读详情的理由，仍标模型意见', async () => {
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const conditionId = '11111111-1111-4111-8111-111111111111'
  const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), workflow: 'retrieval_agent',
    conditions: [{ condition_id: conditionId, source_text: '手里拿着手机' }],
    retrieval: { pending: null, queries: [], details: {}, assessments: [], stop_reason: 'partial', tool_calls: 1, model_calls: 1,
      result_mode: 'baseline', fallback_reason: 'quality_not_accepted', stop_basis: { kind: 'no_useful_next_action', condition_ids: [conditionId], checked: [],
        search: { status: 'not_useful', reason: '重复相同条件没有新的检索线索' }, detail: { status: 'not_useful', reason: '文字无法补充手机的画面证据' } } } }) })
  render(<AgentWorkspace apiClient={apiClient as never} />)
  expect(await screen.findByText('停止涉及条件：手里拿着手机')).toBeTruthy()
  expect(screen.getByText('不再补搜：重复相同条件没有新的检索线索')).toBeTruthy()
  expect(screen.getByText('不再读取详情：文字无法补充手机的画面证据')).toBeTruthy()
  expect(screen.getByText(/停止依据是模型的行动意见/)).toBeTruthy()
})

test('页面区分候选概要与完整详情，批量按候选计数并保留最终基线说明', async () => {
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'searching', workflow: 'retrieval_agent',
    retrieval: { pending: 'get_segment_details_batch', queries: [], details: {}, tool_calls: 3, model_calls: 1,
      result_mode: 'baseline', fallback_reason: 'quality_not_accepted',
      overview_budget: { inspected: 20, maximum_candidates: 60, maximum_characters_per_candidate: 240 },
      gaps: [{ step_id: 'batch', action: 'get_segment_details_batch', gap: { condition_ids: [], kind: 'details_unread',
        checked: [{ candidate_key: 'candidate', evidence_ids: ['caption'], evidence_level: 'overview' }],
        missing_evidence: '缺少趴在上面的关系证据', next_step_reason: '比较两个候选的完整详情', preserves_original_goal: true } }] } }) })
  render(<AgentWorkspace apiClient={apiClient as never} />)
  expect(await screen.findByText(/准备批量读取必要详情/)).toBeTruthy()
  expect(screen.getByText(/已准备 20\/60 个候选概要/)).toBeTruthy()
  expect(screen.getByText(/尚不等于读取完整详情/)).toBeTruthy()
  expect(screen.getByText(/批量详情按候选逐个计数/)).toBeTruthy()
  expect(screen.getByText(/当前采用原文基线/)).toBeTruthy()
})

test('新模型场景图片授权独立于文字与最终重排，等待恢复不重跑检索', async () => {
  window.localStorage.setItem('agent:last-run-id', 'run-1')
  const apiClient = client({ getAgentSettings: vi.fn().mockResolvedValue({ ...settings, model: 'deepseek-v4-flash', capabilities: { ...settings.capabilities, scene_inspection_available: true } }),
    getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'waiting_for_user_input', workflow: 'retrieval_agent', waiting_step_id: 'wait-1',
      clarification_question: '需要单独授权采样画面', authorization: { allow_external_text: true, allow_external_media_text: true, allow_external_visual: true, allow_external_scene_visual: false },
      retrieval: { pending: 'inspect_segment_frames', tools: 1, tool_calls: 1, model_calls: 1, queries: [], details: {}, awaiting_scene_authorization: true } }),
    resumeAgentRun: vi.fn().mockResolvedValue({}) })
  render(<AgentWorkspace apiClient={apiClient} />)
  const button = await screen.findByRole('button', { name: '授权并检查场景画面' })
  expect(button).toBeDisabled()
  fireEvent.click(screen.getByLabelText('允许本任务场景看图'))
  fireEvent.click(button)
  await waitFor(() => expect(apiClient.resumeAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ allow_external_scene_visual: true, response: '检查场景画面' })))
  expect(apiClient.createAgentRun).not.toHaveBeenCalled()
})

// 范围由用户明确选择，原文仍原样提交；默认省略范围保持历史兼容。
test('用户选择只检索转录时提交固定范围且不改写原文', async () => {
  const api = client()
  render(<AgentWorkspace apiClient={api} />)
  await screen.findByLabelText('检索内容范围')
  fireEvent.change(screen.getByLabelText('检索内容范围'), { target: { value: 'spoken' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'qxacceptanceempty20261005' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '发送检索请求' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '发送检索请求' }))
  await waitFor(() => expect(api.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'qxacceptanceempty20261005', search_scope: 'spoken', media_types: ['video', 'audio'] })))
})

test('命中图文等待使用独立20候选授权，恢复不需要填写补充要求', async () => {
  const apiClient = client({
    getAgentSettings: vi.fn().mockResolvedValue({ ...settings, model: 'deepseek-v4-flash', capabilities: { ...settings.capabilities, matched_evidence_available: true } }),
    getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), status: 'waiting_for_user_input', workflow: 'retrieval_agent', waiting_step_id: 'wait-1',
      clarification_question: '请授权20个候选命中图', retrieval: { tool_calls: 1, model_calls: 0, awaiting_retrieval_visual_authorization: true, queries: [] } }),
    resumeAgentRun: vi.fn().mockResolvedValue({ status: 'queued' }),
  })
  render(<AgentWorkspace apiClient={apiClient} />)
  fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '小猫趴在猫爬架上' } })
  await waitFor(() => expect(screen.getByRole('button', { name: /发送检索请求/i })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))
  const checkbox = await screen.findByRole('checkbox', { name: '允许本任务命中图文判断' })
  expect(screen.queryByLabelText('补充要求')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '授权并判断命中图文' })).toBeDisabled()
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: '授权并判断命中图文' }))
  await waitFor(() => expect(apiClient.resumeAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
    waiting_step_id: 'wait-1', allow_external_retrieval_visual: true, response: '判断命中图文',
  })))
})

test('命中图文费用停止只说明已准备，不能伪装已看图或继续只标文字判断', async () => {
  const apiClient = client({ getAgentRun: vi.fn().mockResolvedValue({ ...terminalRun(), workflow: 'retrieval_agent',
    retrieval: { tool_calls: 1, model_calls: 0, queries: [], result_mode: 'baseline', stop_reason: 'cost_limit', fallback_reason: 'quality_not_qualified',
      matched_evidence: { candidate_keys: ['video:scene-1'], fingerprint: 'prepared', records: {} } } }) })
  render(<AgentWorkspace apiClient={apiClient} />)
  fireEvent.change(screen.getByLabelText('完整用户请求'), { target: { value: '小猫趴在猫爬架上' } })
  await waitFor(() => expect(screen.getByRole('button', { name: /发送检索请求/i })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: /发送检索请求/i }))
  expect(await screen.findByText(/准备完成不代表已经外发或检查/)).toBeInTheDocument()
  expect(screen.getByText(/判断依据为本次实际命中的文字/)).toBeInTheDocument()
  expect(screen.queryByText(/判断依据仅为已有描述与转录/)).not.toBeInTheDocument()
})
