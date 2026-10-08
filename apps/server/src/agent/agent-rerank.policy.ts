/**
 * Agent 产品检索共用的 Rerank 固定策略。
 *
 * 这些常量由搜索事务和 Rerank 执行器共同读取，避免一端冻结 20 条候选、另一端却按
 * 不同数量或预算执行。它们描述产品协议，不是可由普通页面临时修改的实验参数。
 */
export const AGENT_RERANK_POLICY = {
  protocolVersion: 'qwen3-vl-rerank-product-v1',
  maximumCandidateCount: 20,
  maximumResultCount: 10,
  maximumCostCny: 0.216,
} as const
