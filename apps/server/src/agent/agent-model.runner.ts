import { Inject, Injectable } from '@nestjs/common'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { SETTINGS, type Settings } from '../config/settings.js'
import type { AgentModelRunner } from './agent.types.js'

@Injectable()
export class AnthropicAgentModelRunner implements AgentModelRunner {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  async run(input: Parameters<AgentModelRunner['run']>[0]) {
    if (!this.settings.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required when ALLOW_EXTERNAL_LLM=true')
    }

    const anthropic = createAnthropic({ apiKey: this.settings.anthropicApiKey })
    const result = await generateText({
      model: anthropic(input.model),
      system:
        '你是本地媒体库的轻量编排助手。只能调用提供的工具；导出剪辑和创建索引任务必须等待用户确认。',
      prompt: input.prompt,
      tools: input.tools,
      stopWhen: stepCountIs(input.maxSteps),
      timeout: input.toolTimeoutMs,
    } as Parameters<typeof generateText>[0])

    const raw = result as {
      text?: string
      toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
      toolResults?: Array<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>
    }
    const resultsById = new Map((raw.toolResults ?? []).map((item) => [item.toolCallId, item]))
    return {
      summary: raw.text?.trim() || 'Agent run finished.',
      toolCalls: (raw.toolCalls ?? []).map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        output: resultsById.get(call.toolCallId)?.output ?? null,
      })),
    }
  }
}
