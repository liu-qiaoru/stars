import { createHash } from 'node:crypto'
import { vlmCandidateReviewRequestSchema } from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import type { Settings } from '../config/settings.js'
import type { VlmReviewProvider } from './vlm-review.provider.js'

export const VLM_REVIEW_MODEL = 'qwen3.7-plus'
export const VLM_REAL_REVIEW_PROVIDER = Symbol('VLM_REAL_REVIEW_PROVIDER')
export const VLM_REVIEW_PROTOCOL_VERSION = 'vlm-review-v1'
export const VLM_REVIEW_PROMPT_VERSION = 'vlm-review-capability-2026-08-17-v1'
export const VLM_REVIEW_TOOL_NAME = 'submit_candidate_review'
const MAX_RESPONSE_BYTES = 262_144

type Request = z.infer<typeof vlmCandidateReviewRequestSchema>

const anthropicResponseSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
    stop_reason: z.literal('tool_use'),
    content: z.array(z.unknown()),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).nullable().optional(),
        output_tokens: z.number().int().min(0).nullable().optional(),
      })
      .optional(),
  })
  .passthrough()

const toolUseSchema = z
  .object({
    type: z.literal('tool_use'),
    name: z.literal(VLM_REVIEW_TOOL_NAME),
    input: z.unknown(),
  })
  .passthrough()

/**
 * Provider 错误只携带稳定安全码。`outcomeUnknown=true` 表示网络中断发生在 dispatch 后，
 * 编排层必须停止整个 run，不能自动重放可能已经计费的视觉请求。
 */
export class QwenVlmReviewProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
    readonly responseReceived = false,
    readonly responseFingerprint: string | null = null,
  ) {
    super(message)
    this.name = 'QwenVlmReviewProviderError'
  }
}

/**
 * 生成真实 preflight 和 Provider 共用的精确请求体。输入只含完整原查询、候选 key、
 * Server 冻结的条件和 1～12 张 Base64 索引帧；没有 Caption、转录或路径字段。
 */
export function buildQwenVlmReviewRequestBody(input: Request) {
  return {
    model: VLM_REVIEW_MODEL,
    max_tokens: 4000,
    temperature: 0,
    thinking: { type: 'disabled' },
    system:
      `Protocol ${VLM_REVIEW_PROMPT_VERSION}. Judge only the supplied frozen frames and conditions. ` +
      'Return every condition exactly once. Never add, remove, rename, merge, or rewrite a condition. ' +
      'Use only supplied frame_id values as evidence. Use uncertain when the frames do not prove yes or no. ' +
      'Do not decide an overall passed or rejected status; the Server derives it.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              protocol_version: input.protocol_version,
              model: input.model,
              original_query: input.original_query,
              candidate_key: input.candidate_key,
              conditions: input.conditions,
            }),
          },
          ...input.evidence_frames.flatMap((frame) => [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: frame.image_base64 },
            },
            { type: 'text', text: JSON.stringify({ frame_id: frame.frame_id }) },
          ]),
        ],
      },
    ],
    tools: [
      {
        name: VLM_REVIEW_TOOL_NAME,
        description: 'Return one strict condition-level review for the frozen candidate.',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['candidate_key', 'conditions'],
          properties: {
            candidate_key: { type: 'string', minLength: 1, maxLength: 300 },
            conditions: {
              type: 'array',
              minItems: 1,
              maxItems: 30,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['condition_id', 'verdict', 'evidence_frame_ids'],
                properties: {
                  condition_id: { type: 'string', minLength: 1, maxLength: 100 },
                  verdict: { type: 'string', enum: ['yes', 'no', 'uncertain'] },
                  evidence_frame_ids: {
                    type: 'array',
                    maxItems: 12,
                    items: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
        },
      },
    ],
    tool_choice: { type: 'tool', name: VLM_REVIEW_TOOL_NAME },
  }
}

/** RightAPI Anthropic Messages 适配器；它不读取数据库，也不拥有视觉授权。 */
export class QwenVlmReviewProvider implements VlmReviewProvider {
  readonly provider = 'rightapi' as const
  readonly available = true
  readonly external = true

  constructor(
    private readonly settings: Settings,
    private readonly request: typeof fetch = fetch,
  ) {}

  async review(input: Request, signal?: AbortSignal) {
    const requestBody = buildQwenVlmReviewRequestBody(input)
    let response: Response
    try {
      response = await this.request(messagesUrl(this.settings.rightCodeBaseUrl!), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.settings.rightCodeApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
        signal,
      })
    } catch {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_OUTCOME_UNKNOWN',
        '视觉请求已派发，但 Server 未收到可确认响应。',
        true,
      )
    }
    let responseText: string
    try {
      responseText = await readBoundedResponse(response)
    } catch (error) {
      if (error instanceof QwenVlmReviewProviderError) throw error
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_OUTCOME_UNKNOWN',
        'Provider 已返回响应头，但响应正文未能完整读取。',
        true,
      )
    }
    const responseFingerprint = createHash('sha256').update(responseText).digest('hex')
    if (!response.ok) {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_HTTP_ERROR',
        `视觉 Provider 返回 HTTP ${response.status}。`,
        false,
        true,
        responseFingerprint,
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(responseText)
    } catch {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_RESPONSE_INVALID',
        '视觉 Provider 响应不是合法 JSON。',
        false,
        true,
        responseFingerprint,
      )
    }
    const parsed = anthropicResponseSchema.safeParse(raw)
    if (!parsed.success || parsed.data.content.length !== 1) {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_TOOL_CALL_INVALID',
        '视觉 Provider 必须返回且只返回一次指定 Tool Call。',
        false,
        true,
        responseFingerprint,
      )
    }
    const toolUse = toolUseSchema.safeParse(parsed.data.content[0])
    if (!toolUse.success) {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_TOOL_CALL_INVALID',
        '视觉 Provider 的 Tool Call 名称或结构不符合冻结协议。',
        false,
        true,
        responseFingerprint,
      )
    }
    if (
      parsed.data.model !== undefined &&
      parsed.data.model !== null &&
      parsed.data.model !== VLM_REVIEW_MODEL
    ) {
      throw new QwenVlmReviewProviderError(
        'VLM_REVIEW_RESPONSE_MODEL_MISMATCH',
        '视觉 Provider 响应模型不是冻结的 qwen3.7-plus。',
        false,
        true,
        responseFingerprint,
      )
    }
    const inputTokens = parsed.data.usage?.input_tokens ?? null
    const outputTokens = parsed.data.usage?.output_tokens ?? null
    return {
      output: toolUse.data.input,
      audit: {
        provider_request_id: parsed.data.id,
        response_model: parsed.data.model ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens:
          inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
        billed_cost_cny: null,
        response_fingerprint: responseFingerprint,
      },
    }
  }
}

class DisabledVlmReviewProvider implements VlmReviewProvider {
  readonly provider = 'rightapi' as const
  readonly available = false
  readonly external = true

  async review(): Promise<never> {
    throw new QwenVlmReviewProviderError(
      'VLM_REVIEW_PROVIDER_DISABLED',
      '真实 qwen3.7-plus 视觉 Provider 未启用或未配置。',
    )
  }
}

export function createQwenVlmReviewProvider(settings: Settings, request: typeof fetch = fetch) {
  if (
    settings.vlmReviewProvider !== 'rightapi' ||
    !settings.allowExternalLlm ||
    !settings.rightCodeBaseUrl ||
    !settings.rightCodeApiKey
  ) {
    return new DisabledVlmReviewProvider()
  }
  return new QwenVlmReviewProvider(settings, request)
}

function messagesUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/messages')) return base
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

async function readBoundedResponse(response: Response) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new QwenVlmReviewProviderError(
      'VLM_REVIEW_RESPONSE_TOO_LARGE',
      '视觉 Provider 响应超过 256 KiB 上限。',
      false,
      true,
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new QwenVlmReviewProviderError(
      'VLM_REVIEW_RESPONSE_TOO_LARGE',
      '视觉 Provider 响应超过 256 KiB 上限。',
      false,
      true,
    )
  }
  return new TextDecoder().decode(bytes)
}
