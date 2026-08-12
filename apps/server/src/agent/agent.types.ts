import type { z } from 'zod'
import { agentNextStepSchema, agentRunStatusSchema } from '@local-media-agent/shared/schemas'

export const AGENT_STEP_HANDLER = Symbol('AGENT_STEP_HANDLER')

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>
export type AgentNextStep = z.infer<typeof agentNextStepSchema>

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
  }>
}

export interface AgentStepHandler {
  /** Phase A 默认处理器返回 false；Phase B 注册 AgentIntent 实现后才允许创建 run。 */
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
