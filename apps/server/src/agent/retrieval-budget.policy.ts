import type { Settings } from '../config/settings.js'

/** 仅计算单任务分类额度，不外发或改数据库。Handler 将额度与工具结果原子保存，恢复不扩额。 */
export interface RetrievalBudget {
  maximum_tools: number
  maximum_searches: number
  maximum_details: number
  maximum_models: number
}
export interface RetrievalBudgetUsage { tools: number; searches: number; details: number; models: number }

/**
 * 真实验收脚本的累计费用门：历史预留不清零，已知估算替换该次预留，未知费用保留全额。
 * 这里校验的是本地保守预算，不代表外部平台的实际账单；非有限值直接拒绝。
 */
export function verificationCostFits(maximum: number, historicalReserve: number,
  attempts: Array<{ estimated_cost_cny: number | null; reserve_cny: number }>, nextReserve: number): boolean {
  const costs = [maximum, historicalReserve, nextReserve,
    ...attempts.map(row => row.estimated_cost_cny ?? row.reserve_cny)]
  if (costs.some(value => !Number.isFinite(value) || value < 0)) return false
  const held = historicalReserve + attempts.reduce((sum, row) => sum + (row.estimated_cost_cny ?? row.reserve_cny), 0)
  return held + nextReserve <= maximum
}

/** 搜索包括程序首轮；详情按候选计数，失败也消耗；模型按 dispatched 步骤计数。 */
export function retrievalBudget(settings: Settings): RetrievalBudget {
  return { maximum_tools: settings.agentRetrievalMaxToolCalls ?? settings.agentMaxSteps,
    maximum_searches: settings.agentRetrievalMaxSearchCalls ?? 3,
    maximum_details: settings.agentRetrievalMaxDetailCalls ?? 6,
    maximum_models: settings.agentRetrievalMaxModelCalls ?? 8 }
}

/** 总额不能被分类额度或将来批量工具绕过；用于模型上下文和审计展示。 */
export function remainingRetrievalBudget(limits: RetrievalBudget, usage: RetrievalBudgetUsage) {
  const tools = Math.max(0, limits.maximum_tools - usage.tools)
  return { tools, searches: Math.max(0, Math.min(tools, limits.maximum_searches - usage.searches)),
    details: Math.max(0, Math.min(tools, limits.maximum_details - usage.details)),
    models: Math.max(0, limits.maximum_models - usage.models) }
}

/** 一类工具用完不终止其他工具；所有可用工具耗尽才结束检索，模型另有独立上限。 */
export function retrievalBudgetStop(limits: RetrievalBudget, usage: RetrievalBudgetUsage) {
  const remaining = remainingRetrievalBudget(limits, usage)
  if (!remaining.tools || (!remaining.searches && !remaining.details)) return 'tool_limit'
  if (!remaining.models) return 'model_limit'
  return null
}
