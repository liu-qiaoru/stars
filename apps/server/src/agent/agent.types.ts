import type { z } from 'zod'
import { agentNextStepSchema, agentRunStatusSchema } from '@local-media-agent/shared/schemas'

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

export interface PreparedAgentStep {
  /**
   * prepare 阶段不得执行网络请求。Executor 会先持久化 dispatched，
   * 再在数据库事务外调用 execute，从而避免长事务和不明结果自动重放。
   */
  external: boolean
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
