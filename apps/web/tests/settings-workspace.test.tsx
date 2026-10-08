import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SettingsWorkspace } from '../components/settings-workspace'

const response = {
  provider: 'rightapi' as const,
  model: 'glm-5.3' as const,
  prompt_version: 'agent-intent-v1',
  schema_version: 'agent-intent-schema-v1',
  api_key: { configured: true },
  capabilities: {
    external_text_available: true,
    external_visual_available: false as const,
    rerank_available: false as const,
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
  apply_behavior: {
    enabled: 'immediate' as const,
    tool_timeout_ms: 'immediate' as const,
    model_timeout_ms: 'immediate' as const,
    lease_duration_ms: 'immediate' as const,
    activity_timeout_ms: 'immediate' as const,
    waiting_ttl_seconds: 'immediate' as const,
    executor_interval_ms: 'immediate' as const,
    web_poll_interval_ms: 'immediate' as const,
  },
  frozen: { provider: true, model: true },
  persistence: 'process' as const,
}

describe('SettingsWorkspace', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('使用默认 API Client 时一次挂载只读取一次 Server 设置', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // Response.json() 每次返回新对象；这是浏览器触发重新渲染的真实边界。
        json: async () => structuredClone(response),
      })
      // 第二次请求保持 pending，既能证明发生了重复调用，也避免失败测试无限刷请求。
      .mockImplementation(() => new Promise(() => undefined))
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsWorkspace />)
    expect(await screen.findByDisplayValue('glm-5.3')).toBeInTheDocument()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('展示只读协议、脱敏 Key 状态和生效方式，保存前校验租约关系', async () => {
    const apiClient = {
      getAgentSettings: vi.fn().mockResolvedValue(response),
      saveAgentSettings: vi.fn().mockResolvedValue(response),
    }
    render(<SettingsWorkspace apiClient={apiClient} />)

    expect(await screen.findByDisplayValue('glm-5.3')).toHaveAttribute('readonly')
    expect(screen.getByText('RIGHT_CODE_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('已配置')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret')
    expect(screen.getByRole('switch', { name: /启用智能任务执行器/i })).toBeChecked()
    expect(screen.getAllByText('立即生效').length).toBeGreaterThan(1)
    expect(screen.getByLabelText('模型等待超时（毫秒）')).toHaveValue(60_000)

    fireEvent.change(screen.getByLabelText('租约时长（毫秒）'), { target: { value: '124999' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('至少需要 125000 毫秒')
    expect(apiClient.saveAgentSettings).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('租约时长（毫秒）'), { target: { value: '125000' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/i }))
    await waitFor(() => expect(apiClient.saveAgentSettings).toHaveBeenCalled())
    expect(apiClient.saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ model_timeout_ms: 60_000, tool_timeout_ms: 10_000 }))
  })
})
