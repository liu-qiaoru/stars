import {
  parseVlmCandidateReviewOutput,
  vlmCandidateReviewRequestSchema,
  type vlmReviewConditionKindSchema,
  type vlmReviewVerdictSchema,
} from '@local-media-agent/shared/schemas'
import type { z } from 'zod'

export const VLM_REVIEW_PROVIDER = Symbol('VLM_REVIEW_PROVIDER')

type VlmReviewRequest = z.infer<typeof vlmCandidateReviewRequestSchema>
type VlmConditionKind = z.infer<typeof vlmReviewConditionKindSchema>
type VlmVerdict = z.infer<typeof vlmReviewVerdictSchema>

export interface VlmReviewProvider {
  /** Provider 是否会发生真实外部调用；preflight 与编排用它显示安全闸门。 */
  readonly provider: 'fake' | 'rightapi'
  readonly available: boolean
  readonly external: boolean

  /**
   * Provider 只返回尚未信任的结构；调用方必须再用共享 Schema 对照本次请求。
   * audit 只含请求 ID、模型和用量等安全元数据，不含原始响应或媒体内容。
   */
  review(
    request: VlmReviewRequest,
    signal?: AbortSignal,
  ): Promise<{
    output: unknown
    audit: {
      provider_request_id: string | null
      response_model: string | null
      input_tokens: number | null
      output_tokens: number | null
      total_tokens: number | null
      billed_cost_cny: number | null
      response_fingerprint: string
    }
  }>
}

/**
 * 可编程的本地 fake Provider。它保留已收到的请求，供测试断言原查询、条件和
 * 帧身份没有在 Server 组装时被改写。`externalCallCount` 恒为 0，防止测试将 fake
 * 误报为真实外部调用。
 */
export class FakeVlmReviewProvider implements VlmReviewProvider {
  readonly provider = 'fake' as const
  readonly available = true
  readonly external = false
  readonly requests: VlmReviewRequest[] = []
  readonly externalCallCount = 0

  constructor(private readonly resolver: (request: VlmReviewRequest) => unknown) {}

  async review(request: VlmReviewRequest) {
    this.requests.push(request)
    const output = this.resolver(request)
    return {
      output,
      audit: {
        provider_request_id: null,
        response_model: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        billed_cost_cny: null,
        response_fingerprint: 'fake',
      },
    }
  }
}

/**
 * 生产依赖图中唯一注册的 Phase F Provider。它只根据条件类型返回一份可预测的协议样例，
 * 不读取人工标签，也不访问网络：must_have→yes、exclusion→no、optional→uncertain。
 * 因而指标可能高也可能低，只用于验证请求、校验、持久化和报告链路，不能冒充模型质量。
 */
export function createProtocolExerciseFakeVlmReviewProvider() {
  return new FakeVlmReviewProvider((request) => ({
    candidate_key: request.candidate_key,
    conditions: request.conditions.map((condition) => ({
      condition_id: condition.condition_id,
      verdict:
        condition.kind === 'must_have'
          ? ('yes' as const)
          : condition.kind === 'exclusion'
            ? ('no' as const)
            : ('uncertain' as const),
      evidence_frame_ids: request.evidence_frames.map((frame) => frame.frame_id),
    })),
  }))
}

export type VlmDerivedReviewStatus =
  | 'passed'
  | 'rejected'
  | 'insufficient_evidence'
  | 'review_not_applicable'
  | 'review_failed'

/**
 * 最终状态由 Server 的固定规则派生，而不接受模型自报的 passed/rejected。
 * 这样可以分别评测“模型对原子条件的判断”与“产品决策规则”。
 */
export function deriveVlmReviewStatus(
  conditions: Array<{ kind: VlmConditionKind; verdict: VlmVerdict }>,
): VlmDerivedReviewStatus {
  const decisive = conditions.filter((condition) => condition.kind !== 'optional')
  if (decisive.length === 0) return 'review_not_applicable'
  if (
    decisive.some(
      (condition) =>
        (condition.kind === 'must_have' && condition.verdict === 'no') ||
        (condition.kind === 'exclusion' && condition.verdict === 'yes'),
    )
  ) {
    return 'rejected'
  }
  if (decisive.some((condition) => condition.verdict === 'uncertain')) {
    return 'insufficient_evidence'
  }
  return 'passed'
}

/**
 * 运行一次候选复核的最小协议边界。当前只供 fake 测试；后续真实 Provider
 * 必须另行授权，且不能绕过这里的严格 ID 对照。
 */
export async function runVlmCandidateReview(provider: VlmReviewProvider, requestInput: unknown) {
  const request = vlmCandidateReviewRequestSchema.parse(requestInput)
  // 可选条件只供展示，不影响最终状态。没有 must_have/exclusion 时没有
  // 可供复核的决定性问题，因此必须在 Provider 调用前短路，避免无意义的图片外发。
  if (request.conditions.every((condition) => condition.kind === 'optional')) {
    return { output: null, status: 'review_not_applicable' as const, error: null }
  }
  let output: ReturnType<typeof parseVlmCandidateReviewOutput>
  let audit: Awaited<ReturnType<VlmReviewProvider['review']>>['audit'] | null = null
  try {
    const providerResult = await provider.review(request)
    audit = providerResult.audit
    output = parseVlmCandidateReviewOutput(request, providerResult.output)
  } catch {
    // Provider 返回是不可信输入。不把 Zod 路径或 Provider 原始消息直接穿透给
    // 用户，只返回稳定错误码；正式 runner 将据此写入结构化审计事实。
    return {
      output: null,
      status: 'review_failed' as const,
      error: { code: 'VLM_REVIEW_OUTPUT_INVALID' as const },
      audit,
    }
  }
  const conditionKindById = new Map(
    request.conditions.map((condition) => [condition.condition_id, condition.kind]),
  )
  return {
    output,
    status: deriveVlmReviewStatus(
      output.conditions.map((condition) => ({
        kind: conditionKindById.get(condition.condition_id)!,
        verdict: condition.verdict,
      })),
    ),
    error: null,
    audit,
  }
}
