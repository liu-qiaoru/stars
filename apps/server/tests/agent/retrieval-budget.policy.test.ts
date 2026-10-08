import { expect, test } from 'vitest'
import { createSettings } from '../../src/config/settings.js'
import { retrievalBudget, remainingRetrievalBudget, retrievalBudgetStop, verificationCostFits } from '../../src/agent/retrieval-budget.policy.js'

const settings = (overrides: Record<string, string> = {}) => createSettings({
  DATABASE_URL: 'postgres://test:test@localhost/test', QDRANT_URL: 'http://localhost:6333', ...overrides,
})

test('真实验收累计计入历史预留和下一次最坏费用，新增20元授权不清零旧用量', () => {
  const attempts = [{ estimated_cost_cny: 2.2241008, reserve_cny: 3 }]
  expect(verificationCostFits(5, 1.370096, attempts, 2)).toBe(false)
  expect(verificationCostFits(20, 1.370096, attempts, 2)).toBe(true)
  expect(verificationCostFits(20, 1.370096, attempts, 17)).toBe(false)
  expect(verificationCostFits(20, 1, [{ estimated_cost_cny: null, reserve_cny: 18.9 }], 0.2)).toBe(false)
  expect(verificationCostFits(20, 1, [{ estimated_cost_cny: null, reserve_cny: 18.9 }], 0.1)).toBe(true)
  expect(verificationCostFits(20, 1, [{ estimated_cost_cny: null, reserve_cny: Number.NaN }], 0.1)).toBe(false)
})

test('分类预算可保留补搜后的详情空间，决策次数不随工具上限增长', () => {
  const budget = retrievalBudget(settings({ AGENT_MAX_STEPS: '4', AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9',
    AGENT_RETRIEVAL_MAX_SEARCH_CALLS: '3', AGENT_RETRIEVAL_MAX_DETAIL_CALLS: '6', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '8' }))
  expect(budget).toEqual({ maximum_tools: 9, maximum_searches: 3, maximum_details: 6, maximum_models: 8 })
  expect(remainingRetrievalBudget(budget, { tools: 4, searches: 2, details: 2, models: 4 }))
    .toEqual({ tools: 5, searches: 1, details: 4, models: 4 })
  expect(retrievalBudgetStop(budget, { tools: 4, searches: 2, details: 2, models: 4 })).toBeNull()
})

test('一种工具额度用完仍可使用其他工具，所有额度及绝对上限仍有限', () => {
  const budget = retrievalBudget(settings({ AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_DETAIL_CALLS: '2' }))
  expect(retrievalBudgetStop(budget, { tools: 3, searches: 1, details: 2, models: 2 })).toBeNull()
  expect(retrievalBudgetStop(budget, { tools: 5, searches: 3, details: 2, models: 2 })).toBe('tool_limit')
  expect(retrievalBudgetStop(budget, { tools: 9, searches: 2, details: 6, models: 2 })).toBe('tool_limit')
  expect(retrievalBudgetStop(budget, { tools: 3, searches: 1, details: 2, models: 8 })).toBe('model_limit')
})

test('已有环境未显式配置分类总额度时，保留原四次上限，不静默扩大费用', () => {
  expect(retrievalBudget(settings()).maximum_tools).toBe(4)
  expect(() => settings({ AGENT_RETRIEVAL_MAX_TOOL_CALLS: '1000' })).toThrow()
})
