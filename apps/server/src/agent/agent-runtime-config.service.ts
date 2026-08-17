import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'
import {
  AGENT_INTENT_MODEL,
  AGENT_INTENT_PROMPT_VERSION,
  AGENT_INTENT_SCHEMA_VERSION,
} from './agent-protocol.constants.js'

const editableAgentConfigSchema = z
  .object({
    enabled: z.boolean(),
    tool_timeout_ms: z.number().int().min(1_000).max(120_000),
    lease_duration_ms: z.number().int().min(5_000).max(300_000),
    activity_timeout_ms: z.number().int().min(1_000).max(120_000),
    waiting_ttl_seconds: z.number().int().min(60).max(604_800),
    executor_interval_ms: z.number().int().min(500).max(60_000),
    web_poll_interval_ms: z.number().int().min(500).max(60_000),
  })
  .strict()
  .superRefine((value, context) => {
    const minimum = Math.max(value.activity_timeout_ms, value.tool_timeout_ms) + 5_000
    if (value.lease_duration_ms < minimum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lease_duration_ms'],
        message:
          'lease_duration_ms must be at least max(activity_timeout_ms, tool_timeout_ms) + 5000',
      })
    }
  })

export type EditableAgentConfig = z.infer<typeof editableAgentConfigSchema>

/**
 * 只保存 Server allowlist 中的非敏感运行值。API Key 和 Provider URL 从不进入该对象，
 * 因而序列化响应、页面 DOM 和日志都没有泄露凭证的路径。
 */
@Injectable()
export class AgentRuntimeConfigService {
  private current: EditableAgentConfig
  private readonly listeners = new Set<() => void>()

  constructor(@Inject(SETTINGS) private readonly settings: Settings) {
    this.current = {
      enabled: settings.agentExecutorEnabled,
      tool_timeout_ms: settings.agentToolTimeoutMs,
      lease_duration_ms: settings.agentLeaseDurationMs,
      activity_timeout_ms: settings.agentActivityTimeoutMs,
      waiting_ttl_seconds: settings.agentWaitingTtlSeconds,
      executor_interval_ms: settings.agentExecutorIntervalMs,
      web_poll_interval_ms: settings.agentWebPollIntervalMs ?? 2_000,
    }
  }

  values() {
    return { ...this.current }
  }

  update(input: unknown) {
    const parsed = editableAgentConfigSchema.safeParse(input)
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'AGENT_SETTINGS_INVALID',
        message: 'Agent 运行配置不符合 Server allowlist。',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    this.current = parsed.data
    for (const listener of this.listeners) listener()
    return this.response()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  response() {
    const apiKeyConfigured = Boolean(this.settings.rightCodeApiKey)
    const providerConfigured = apiKeyConfigured && Boolean(this.settings.rightCodeBaseUrl)
    const unavailableReasons: string[] = []
    if (!this.settings.allowExternalLlm)
      unavailableReasons.push('external_text_deployment_disabled')
    if (!providerConfigured) unavailableReasons.push('rightapi_not_configured')
    if (!this.current.enabled) unavailableReasons.push('agent_executor_disabled')
    const rerankConfigured =
      this.settings.agentRerankProvider === 'dashscope' &&
      Boolean(this.settings.dashscopeWorkspaceId && this.settings.dashscopeApiKey)
    return {
      provider: 'rightapi',
      model: AGENT_INTENT_MODEL,
      prompt_version: AGENT_INTENT_PROMPT_VERSION,
      schema_version: AGENT_INTENT_SCHEMA_VERSION,
      // 页面只得到布尔状态，不得到 Key 值。Provider 能力仍需同时具备固定 URL 和 Key。
      api_key: { configured: apiKeyConfigured },
      capabilities: {
        external_text_available:
          this.settings.allowExternalLlm && providerConfigured && this.current.enabled,
        external_visual_available: rerankConfigured,
        rerank_available: rerankConfigured,
        vlm_review_available: false,
        unavailable_reasons: unavailableReasons,
      },
      editable: this.values(),
      apply_behavior: {
        enabled: 'immediate',
        tool_timeout_ms: 'immediate',
        lease_duration_ms: 'immediate',
        activity_timeout_ms: 'immediate',
        waiting_ttl_seconds: 'immediate',
        executor_interval_ms: 'immediate',
        web_poll_interval_ms: 'immediate',
      },
      frozen: {
        provider: true,
        model: true,
        prompt_version: true,
        schema_version: true,
        provider_url_editable: false,
      },
      persistence: 'process',
    }
  }
}
