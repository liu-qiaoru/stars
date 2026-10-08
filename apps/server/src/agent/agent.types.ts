import type { z } from 'zod'
import { agentNextStepSchema, agentRunStatusSchema } from '@local-media-agent/shared/schemas'
import type { RetrievalDecisionDiagnostics } from './retrieval-decision.diagnostics.js'

export const AGENT_STEP_HANDLER = Symbol('AGENT_STEP_HANDLER')

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>
export type AgentNextStep = z.infer<typeof agentNextStepSchema>

/**
 * 步骤边界只允许持久化已脱敏的错误码和说明。outcomeUnknown=true 表示外部调用
 * 可能已经产生费用，必须保留 step_attempt_id 并等待 /retry-unknown。
 */
export class AgentStepExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
    /** 已脱敏的失败上下文；随步骤保存，不能传入原始响应或异常对象。 */
    readonly diagnostics?: RetrievalDecisionDiagnostics,
  ) {
    super(message)
    this.name = 'AgentStepExecutionError'
  }
}

export interface FrozenAgentCandidate {
  candidateKey: string
  fileId: string
  fileGeneration: number
  assetId: string
  sceneId: string | null
  sceneStartSeconds: number | null
  sceneEndSeconds: number | null
  rank: number
  retrievalJson: Record<string, unknown>
}

export type AgentRerankCompletionStatus = 'waiting_for_export_selection' | 'succeeded'

/**
 * 搜索提交时一并冻结的 Rerank 尝试计划。
 *
 * attemptNo 是同一 Agent run 内从 1 开始的尝试编号；completionStatus 表示精排成功后
 * 父 run 应进入的状态。把它和候选保存在同一事务里，Server 重启后也不需要靠页面状态
 * 猜测接下来做什么。
 */
export interface FrozenAgentRerankAttempt {
  attemptNo: number
  completionStatus: AgentRerankCompletionStatus
  protocolVersion: string
  maxCostCny: number
}

export interface PreparedAgentStep {
  /**
   * prepare 阶段不得执行网络请求。Executor 会先持久化 dispatched，
   * 再在数据库事务外调用 execute，从而避免长事务和不明结果自动重放。
   */
  external: boolean
  /** 本地硬超时保存此前已提交工作状态，迟到 Promise 不获得任何写权。 */
  timeoutOutputJson?: unknown
  inputFingerprint?: string
  execute(): Promise<{
    transition: {
      status: AgentRunStatus
      nextStep?: AgentNextStep
      waitingStepId?: string
      waitingExpiresAt?: Date
    }
    outputJson: unknown
    /** searching 提交时与状态迁移放在同一短事务中冻结，避免 run 成功但候选只写了一半。 */
    candidates?: FrozenAgentCandidate[]
    /** 非空搜索结果进入 ranking 时必须同时创建一次可恢复的产品 Rerank 尝试。 */
    rerankAttempt?: FrozenAgentRerankAttempt
  }>
}

export interface AgentStepHandler {
  /** Provider、文本授权开关和固定步骤实现均就绪时才允许创建 run。 */
  isReady(): boolean
  prepare(input: {
    runId: string
    prompt: string
    step: AgentNextStep
    stepAttemptId: string
    leaseOwner: string
    leaseVersion: number
    enforcedScope: unknown
  }): Promise<PreparedAgentStep>
}
