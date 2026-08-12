import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SettingsWorkspace } from '../components/settings-workspace'

const response = {
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
  apply_behavior: {
    enabled: 'immediate' as const,
    tool_timeout_ms: 'immediate' as const,
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
  test('展示只读协议、脱敏 Key 状态和生效方式，保存前校验租约关系', async () => {
    const apiClient = {
      getAgentSettings: vi.fn().mockResolvedValue(response),
      saveAgentSettings: vi.fn().mockResolvedValue(response),
    }
    render(<SettingsWorkspace apiClient={apiClient} />)

    expect(await screen.findByDisplayValue('qwen3.7-plus')).toHaveAttribute('readonly')
    expect(screen.getByText('RIGHT_CODE_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('已配置')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret')
    expect(screen.getByRole('switch', { name: /启用 Agent 执行器/i })).toBeChecked()
    expect(screen.getAllByText('立即生效').length).toBeGreaterThan(1)

    fireEvent.change(screen.getByLabelText('租约时长（毫秒）'), { target: { value: '124999' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('至少需要 125000 毫秒')
    expect(apiClient.saveAgentSettings).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('租约时长（毫秒）'), { target: { value: '125000' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/i }))
    await waitFor(() => expect(apiClient.saveAgentSettings).toHaveBeenCalled())
  })
})
