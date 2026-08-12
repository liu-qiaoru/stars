import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { agentIntentSchema } from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'
import { AgentStepExecutionError } from './agent.types.js'

export const AGENT_INTENT_HTTP_CLIENT = Symbol('AGENT_INTENT_HTTP_CLIENT')
export const AGENT_INTENT_RUNNER = Symbol('AGENT_INTENT_RUNNER')
export const AGENT_INTENT_TOOL_NAME = 'extract_agent_intent'
export const AGENT_INTENT_MODEL = 'qwen3.7-plus'
export const AGENT_INTENT_PROMPT_VERSION = 'agent-intent-v1'
export const AGENT_INTENT_SCHEMA_VERSION = 'agent-intent-schema-v1'
export const AGENT_INTENT_MAX_RESPONSE_BYTES = 262_144

type AgentIntent = z.infer<typeof agentIntentSchema>
type AgentMediaType = AgentIntent['media_types'][number]

export interface AgentIntentRequest {
  userPrompt: string
  capabilityBoundary: {
    allowedMediaTypes: AgentMediaType[]
    hasEnforcedLibraryScope: boolean
  }
}

export interface ValidatedAgentIntent {
  intent: AgentIntent
  conditions: Array<
    AgentIntent['conditions'][number] & {
      normalized_source_text: string
    }
  >
  provider: {
    model: string
    prompt_version: string
    schema_version: string
    request_id: string
    input_tokens: number
    output_tokens: number
  }
}

/**
 * Runner 只承载一次 RightAPI AgentIntent 调用。它不读取 PostgreSQL、候选或本地媒体，
 * 也不拥有搜索权限；Server 的步骤处理器会在返回后再次约束业务范围。
 */
export interface AgentIntentRunner {
  isReady(): boolean
  fingerprint(input: AgentIntentRequest): string
  extract(input: AgentIntentRequest): Promise<ValidatedAgentIntent>
}

/**
 * 只向执行器暴露脱敏错误码。Provider 原始响应、请求头和 API Key 不进入错误或日志。
 * outcomeUnknown=true 表示请求已派发但无法确认结果，调用方不得自动重放。
 */
export class AgentIntentRunnerError extends AgentStepExecutionError {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(code, message, outcomeUnknown)
    this.name = 'AgentIntentRunnerError'
  }
}

const anthropicResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  stop_reason: z.string(),
  content: z.array(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0).max(2000),
  }),
})

const toolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .passthrough()

// RightAPI 接收 JSON Schema，而项目的 Zod 版本没有稳定的 JSON Schema 导出 API。
// 因此这里显式维护传输 Schema，返回后仍由共享 agentIntentSchema 严格二次校验。
export const AGENT_INTENT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'goal',
    'search_scope',
    'media_types',
    'library_references',
    'conditions',
    'needs_clarification',
    'clarification_reason',
    'requested_effect',
  ],
  properties: {
    goal: { type: 'string', enum: ['search', 'inspect', 'export_clip'] },
    search_scope: { type: 'string', enum: ['visual', 'spoken', 'all'] },
    media_types: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
    },
    library_references: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    conditions: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_text', 'kind', 'evidence_type'],
        properties: {
          source_text: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['must_have', 'optional', 'exclusion'] },
          evidence_type: {
            type: 'string',
            enum: ['visual', 'spoken', 'metadata', 'unknown'],
          },
        },
      },
    },
    needs_clarification: { type: 'boolean' },
    clarification_reason: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }],
    },
    requested_effect: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'export_clip' } },
        },
        { type: 'null' },
      ],
    },
  },
} as const

@Injectable()
export class QwenAgentIntentRunner implements AgentIntentRunner {
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AGENT_INTENT_HTTP_CLIENT)
    private readonly request: typeof fetch,
  ) {}

  isReady() {
    return Boolean(
      this.settings.allowExternalLlm &&
      this.settings.rightCodeBaseUrl &&
      this.settings.rightCodeApiKey,
    )
  }

  fingerprint(input: AgentIntentRequest) {
    return `sha256:${createHash('sha256')
      .update(JSON.stringify(this.requestBody(input)))
      .digest('hex')}`
  }

  async extract(input: AgentIntentRequest): Promise<ValidatedAgentIntent> {
    if ([...input.userPrompt].length > 4000 || input.userPrompt.length === 0) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_PROMPT_INVALID',
        'AgentIntent prompt 必须包含 1 至 4000 个 Unicode 字符。',
      )
    }
    if (!this.isReady()) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_PROVIDER_UNAVAILABLE',
        'RightAPI AgentIntent Provider 未开启或未配置。',
      )
    }

    let response: Response
    try {
      response = await this.request(this.messagesUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.settings.rightCodeApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(this.requestBody(input)),
        signal: AbortSignal.timeout(this.settings.agentToolTimeoutMs),
      })
    } catch {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_OUTCOME_UNKNOWN',
        'RightAPI 请求已派发，但 Server 未收到可确认的响应。',
        true,
      )
    }
    if (!response.ok) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_HTTP_ERROR',
        `RightAPI AgentIntent 请求返回 HTTP ${response.status}。`,
      )
    }

    let responseText: string
    try {
      responseText = await readResponseText(response, AGENT_INTENT_MAX_RESPONSE_BYTES)
    } catch (error) {
      if (error instanceof AgentIntentRunnerError) throw error
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_OUTCOME_UNKNOWN',
        'RightAPI 已返回响应头，但响应正文未能完整读取。',
        true,
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(responseText)
    } catch {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_RESPONSE_INVALID',
        'RightAPI AgentIntent 响应不是合法 JSON。',
      )
    }
    const parsedResponse = anthropicResponseSchema.safeParse(raw)
    if (
      !parsedResponse.success ||
      parsedResponse.data.stop_reason !== 'tool_use' ||
      parsedResponse.data.model !== AGENT_INTENT_MODEL
    ) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_RESPONSE_INVALID',
        'RightAPI AgentIntent 响应结构、模型或 stop_reason 不符合协议。',
      )
    }
    if (parsedResponse.data.content.length !== 1) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_TOOL_CALL_INVALID',
        'AgentIntent 响应必须且只能包含一次 Tool Call。',
      )
    }
    const toolUse = toolUseBlockSchema.safeParse(parsedResponse.data.content[0])
    if (!toolUse.success || toolUse.data.name !== AGENT_INTENT_TOOL_NAME) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_TOOL_CALL_INVALID',
        'AgentIntent 响应工具名或工具结构不符合协议。',
      )
    }
    const parsedIntent = agentIntentSchema.safeParse(toolUse.data.input)
    if (!parsedIntent.success) {
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_SCHEMA_INVALID',
        'AgentIntent Tool Call 输入不符合严格 Schema。',
      )
    }

    const normalizedPrompt = normalizeForSourceValidation(input.userPrompt)
    const conditions = parsedIntent.data.conditions.map((condition) => {
      const normalizedSourceText = normalizeForSourceValidation(condition.source_text.trim())
      if (normalizedSourceText.length === 0 || !normalizedPrompt.includes(normalizedSourceText)) {
        throw new AgentIntentRunnerError(
          'AGENT_INTENT_SOURCE_TEXT_INVALID',
          'AgentIntent condition.source_text 不是用户原文的连续子串。',
        )
      }
      return { ...condition, normalized_source_text: normalizedSourceText }
    })

    return {
      intent: parsedIntent.data,
      conditions,
      provider: {
        model: parsedResponse.data.model,
        prompt_version: AGENT_INTENT_PROMPT_VERSION,
        schema_version: AGENT_INTENT_SCHEMA_VERSION,
        request_id: parsedResponse.data.id,
        input_tokens: parsedResponse.data.usage.input_tokens,
        output_tokens: parsedResponse.data.usage.output_tokens,
      },
    }
  }

  private messagesUrl() {
    const base = this.settings.rightCodeBaseUrl!.replace(/\/+$/, '')
    if (base.endsWith('/messages')) return base
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  }

  private requestBody(input: AgentIntentRequest) {
    return {
      model: AGENT_INTENT_MODEL,
      max_tokens: 2000,
      temperature: 0,
      thinking: { type: 'disabled' },
      system:
        `Protocol ${AGENT_INTENT_PROMPT_VERSION}. Classify the request exactly once; never create or rewrite a search query. ` +
        'visual means appearance in images or video frames; spoken means words heard in audio or video; all means either evidence type. ' +
        'Use the broadest safe scope when the request is not explicit, but never exceed allowed_media_types. ' +
        'Set needs_clarification=true only when missing information would change the goal, selected library, external-data authorization, or an export side effect. ' +
        'Copy library_references only from explicit library names in the prompt. goal=export_clip and requested_effect require an explicit export request; otherwise requested_effect is null. ' +
        'Copy every condition source_text exactly from a non-empty continuous span of the user prompt.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.userPrompt },
            {
              type: 'text',
              text: JSON.stringify({
                allowed_media_types: input.capabilityBoundary.allowedMediaTypes,
                has_enforced_library_scope: input.capabilityBoundary.hasEnforcedLibraryScope,
              }),
            },
          ],
        },
      ],
      tools: [
        {
          name: AGENT_INTENT_TOOL_NAME,
          description: 'Classify one Agent V1 request without creating a search query.',
          input_schema: AGENT_INTENT_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: AGENT_INTENT_TOOL_NAME },
    }
  }
}

/**
 * 仅供原文证据校验：Unicode NFC、CRLF→LF。调用方只会额外 trim 模型 source_text 两端；
 * 用户 prompt 本身不 trim、不折叠空白、不替换标点，搜索仍使用完全未经改写的原文。
 */
export function normalizeForSourceValidation(value: string) {
  return value.normalize('NFC').replaceAll('\r\n', '\n')
}

/**
 * 在解析 JSON 前按原始 UTF-8 字节限制 Provider 正文，不能信任响应自报 token 数。
 * 读取中断表示调用结果不明；完整正文超过 256 KiB 则是明确协议违规，可安全失败。
 */
async function readResponseText(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AgentIntentRunnerError(
      'AGENT_INTENT_RESPONSE_TOO_LARGE',
      `RightAPI AgentIntent 响应超过 ${maxBytes} 字节上限。`,
    )
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytesRead += value.byteLength
    if (bytesRead > maxBytes) {
      await reader.cancel()
      throw new AgentIntentRunnerError(
        'AGENT_INTENT_RESPONSE_TOO_LARGE',
        `RightAPI AgentIntent 响应超过 ${maxBytes} 字节上限。`,
      )
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
