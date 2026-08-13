import { z } from 'zod'
import type { Settings } from '../config/settings.js'
import type {
  ShadowRerankProvider,
  ShadowRerankProviderResult,
  ShadowRerankRequest,
} from './shadow-rerank.provider.js'
import {
  DisabledShadowRerankProvider,
  ShadowRerankProviderResponseError,
} from './shadow-rerank.provider.js'

const ENDPOINT_PATH = '/api/v1/services/rerank/text-rerank/text-rerank'

// DashScope 的多模态重排响应不同于项目内部协议：结果位于 output.results，
// 用量只提供 total_tokens。这里在网络边界立即校验，避免把 HTML 错误页、缺字段
// 或未来不兼容的响应交给 Evaluation 状态机后才以数据库异常形式暴露。
const dashScopeRankingEnvelopeSchema = z.object({
  output: z.object({
    results: z.array(
      z.object({
        index: z.number().int(),
        relevance_score: z.number().finite(),
      }),
    ),
  }),
  // 用量属于审计事实，不参与候选身份映射。缺失或类型漂移时保存 null，
  // 由全局预算门阻止下一次外发，但不能丢弃已经完整返回的合法 Top-10。
  usage: z.unknown().optional(),
  request_id: z.string().min(1).max(500),
})

const dashScopeUsageSchema = z.object({ total_tokens: z.number().int().nonnegative() })

const dashScopeErrorSchema = z
  .object({
    code: z.string().min(1).max(200),
    message: z.string(),
    request_id: z.string().min(1).max(500).optional(),
  })
  .passthrough()

export interface DashScopeShadowRerankProviderOptions {
  workspaceId: string
  apiKey: string
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type ShadowRerankSettings = Pick<
  Settings,
  'shadowRerankProvider' | 'dashscopeWorkspaceId' | 'dashscopeApiKey'
>

/** NestJS 模块使用同一个工厂装配授权闸门，测试也由这个公开边界证明默认不会联网。 */
export function createShadowRerankProvider(settings: ShadowRerankSettings): ShadowRerankProvider {
  if (settings.shadowRerankProvider !== 'dashscope') return new DisabledShadowRerankProvider()
  if (!settings.dashscopeWorkspaceId || !settings.dashscopeApiKey) {
    // createSettings 已应更早拒绝；这里保留防御校验，避免测试或错误依赖注入绕过配置 Schema。
    throw new Error('DashScope shadow rerank configuration is incomplete')
  }
  return new DashScopeShadowRerankProvider({
    workspaceId: settings.dashscopeWorkspaceId,
    apiKey: settings.dashscopeApiKey,
  })
}

/**
 * 把 Phase E 的冻结 Top-20 协议翻译为阿里云百炼北京地域的专用 HTTP 协议。
 * 该类只负责一次同步网络请求与供应商响应校验；幂等、dispatched 状态、超时和
 * PostgreSQL 审计仍由 ShadowRerankService 负责，避免 Provider 自己重试并重复计费。
 */
export class DashScopeShadowRerankProvider implements ShadowRerankProvider {
  readonly available = true
  private readonly endpoint: string

  constructor(
    private readonly options: DashScopeShadowRerankProviderOptions,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.endpoint = `https://${options.workspaceId}.cn-beijing.maas.aliyuncs.com${ENDPOINT_PATH}`
  }

  /** 与 rerank 共用同一序列化函数，测试可证明授权前预览值与实际 body 不会漂移。 */
  requestBytes(request: ShadowRerankRequest) {
    return dashScopeShadowRerankRequestBytes(request)
  }

  async rerank(
    request: ShadowRerankRequest,
    signal: AbortSignal,
  ): Promise<ShadowRerankProviderResult> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      signal,
      body: serializeDashScopeRequest(request),
    })
    const rawText = await response.text()
    let rawBody: unknown
    try {
      rawBody = JSON.parse(rawText)
    } catch {
      rawBody = { http_status: response.status, body_kind: 'non_json' }
    }
    if (!response.ok) {
      const providerError = dashScopeErrorSchema.safeParse(rawBody)
      throw new ShadowRerankProviderResponseError(
        'SHADOW_PROVIDER_HTTP_ERROR',
        response.status,
        providerError.success ? providerError.data.code : null,
        providerError.success ? (providerError.data.request_id ?? null) : null,
        'cn-beijing',
        rawBody,
      )
    }
    const parsedResult = dashScopeRankingEnvelopeSchema.safeParse(rawBody)
    if (!parsedResult.success) {
      const requestId =
        rawBody && typeof rawBody === 'object' && 'request_id' in rawBody
          ? rawBody.request_id
          : null
      throw new ShadowRerankProviderResponseError(
        'SHADOW_PROVIDER_RESPONSE_INVALID',
        response.status,
        null,
        typeof requestId === 'string' && requestId.length <= 500 ? requestId : null,
        'cn-beijing',
        rawBody,
        parsedResult.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      )
    }
    const parsed = parsedResult.data
    const parsedUsage = dashScopeUsageSchema.safeParse(parsed.usage)
    return {
      response: { results: parsed.output.results },
      providerRequestId: parsed.request_id,
      // 官方 HTTP 响应没有以下事实，必须保存 null，不能把请求参数复制成响应事实。
      responseModel: null,
      modelSnapshot: null,
      region: 'cn-beijing',
      inputTokens: null,
      outputTokens: null,
      totalTokens: parsedUsage.success ? parsedUsage.data.total_tokens : null,
      billedCostCny: null,
    }
  }
}

/**
 * candidate_key 与证据 SHA-256 只用于本地审计。供应商只获得按冻结顺序排列的图片，
 * 从返回 index 即可回映，因而无需泄露任何本地身份、指纹或路径信息。
 */
function serializeDashScopeRequest(request: ShadowRerankRequest) {
  return JSON.stringify({
    model: request.model,
    input: {
      query: { text: request.query },
      documents: request.documents.map((document) => ({
        image: `data:image/png;base64,${document.image_base64}`,
      })),
    },
    parameters: { return_documents: false, top_n: request.top_n },
  })
}

/** 供只读 preflight 使用；只返回数字，不暴露序列化后的查询或图片。 */
export function dashScopeShadowRerankRequestBytes(request: ShadowRerankRequest) {
  return Buffer.byteLength(serializeDashScopeRequest(request), 'utf8')
}
