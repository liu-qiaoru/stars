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
  responseModel: string
  modelSnapshot: string | null
  region: string | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  billedCostCny: number
}

/**
 * Provider 是唯一允许接收 Base64 证据的系统边界。测试注入本地 fake；默认实现明确不可用，
 * 因而在用户重新授权真实图片与预算前，生产代码的真实外部请求数保证为 0。
 */
export interface ShadowRerankProvider {
  readonly available: boolean
  rerank(request: ShadowRerankRequest, signal: AbortSignal): Promise<ShadowRerankProviderResult>
}

export class DisabledShadowRerankProvider implements ShadowRerankProvider {
  readonly available = false

  async rerank(): Promise<never> {
    throw new Error('Phase E real provider is disabled pending explicit visual-data authorization')
  }
}
