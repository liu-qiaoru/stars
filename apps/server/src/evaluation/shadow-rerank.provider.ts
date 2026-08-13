import type { z } from 'zod'
import type {
  shadowRerankRequestSchema,
  shadowRerankResponseSchema,
} from '@local-media-agent/shared/schemas'

export const SHADOW_RERANK_PROVIDER = Symbol('SHADOW_RERANK_PROVIDER')

export type ShadowRerankRequest = z.infer<typeof shadowRerankRequestSchema>
export type ShadowRerankResponse = z.infer<typeof shadowRerankResponseSchema>

export interface ShadowRerankProviderResult {
  response: unknown
  providerRequestId: string | null
  responseModel: string | null
  modelSnapshot: string | null
  region: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  billedCostCny: number | null
}

/**
 * Provider 是唯一允许接收 Base64 证据的系统边界。测试注入本地 fake；默认实现明确不可用，
 * 因而在用户重新授权真实图片与预算前，生产代码的真实外部请求数保证为 0。
 */
export interface ShadowRerankProvider {
  readonly available: boolean
  rerank(request: ShadowRerankRequest, signal: AbortSignal): Promise<ShadowRerankProviderResult>
}

/**
 * 只描述响应的结构错误位置与类型。它不包含实际值、查询、图片、分数或 Provider 正文，
 * 因而可以安全进入 PostgreSQL 审计和 Web 错误详情。
 */
export interface ShadowRerankSchemaIssue {
  path: string
  code: string
}

/**
 * 供应商已返回 HTTP 响应时使用此错误。它与连接断开/超时不同：调用结果已经明确，
 * Evaluation 必须记为 completed/failed 而不是 outcome_unknown。responseForFingerprint
 * 只允许用于内存中计算 SHA-256，禁止进入 API、数据库 JSON 或日志。
 */
export class ShadowRerankProviderResponseError extends Error {
  constructor(
    readonly code: 'SHADOW_PROVIDER_HTTP_ERROR' | 'SHADOW_PROVIDER_RESPONSE_INVALID',
    readonly httpStatus: number,
    readonly providerCode: string | null,
    readonly providerRequestId: string | null,
    readonly region: string | null,
    readonly responseForFingerprint: unknown,
    readonly schemaIssues: ShadowRerankSchemaIssue[] = [],
  ) {
    super('Shadow rerank Provider returned a definite invalid response')
  }
}

export class DisabledShadowRerankProvider implements ShadowRerankProvider {
  readonly available = false

  async rerank(): Promise<never> {
    throw new Error('Phase E real provider is disabled pending explicit visual-data authorization')
  }
}
