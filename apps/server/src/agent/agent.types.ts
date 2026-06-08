export const AGENT_MODEL_RUNNER = Symbol('AGENT_MODEL_RUNNER')

export interface AgentToolDefinition {
  execute(input: unknown, options?: { toolCallId?: string }): Promise<unknown>
}

export interface AgentModelRunner {
  run(input: {
    prompt: string
    model: string
    maxSteps: number
    toolTimeoutMs: number
    tools: Record<string, AgentToolDefinition>
  }): Promise<{
    summary: string
    toolCalls: Array<{
      toolCallId: string
      toolName: string
      input: unknown
      output: unknown
    }>
  }>
}
