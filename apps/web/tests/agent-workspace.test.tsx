import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AgentWorkspace } from '../components/agent-workspace'

describe('AgentWorkspace', () => {
  test('提交任务后展示 run 状态和 tool-call summary', async () => {
    const apiClient = {
      createAgentRun: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'succeeded' }),
      getAgentRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        status: 'succeeded',
        prompt: '查找片段',
        summary: '找到候选视频片段',
        tool_calls: [
          {
            tool_call_id: 'search-1',
            name: 'search_media',
            status: 'succeeded',
            summary: '完成搜索',
            requires_confirmation: false,
          },
        ],
        events: [],
        results: [],
      }),
      confirmAgentToolCall: vi.fn(),
    }

    render(<AgentWorkspace apiClient={apiClient} />)

    fireEvent.change(screen.getByPlaceholderText(/查找包含清晰产品镜头/i), {
      target: { value: '查找片段' },
    })
    fireEvent.click(screen.getByRole('button', { name: /启动任务/i }))

    await waitFor(() => {
      expect(apiClient.createAgentRun).toHaveBeenCalledWith({
        prompt: '查找片段',
        allow_external_vlm: false,
      })
    })
    expect(await screen.findByText(/找到候选视频片段/i)).toBeInTheDocument()
    expect(screen.getByText(/search_media/)).toBeInTheDocument()
    expect(screen.getByText(/完成搜索/)).toBeInTheDocument()
  })
})
