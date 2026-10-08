/** 显式模型选择，不因失败自动切换。DeepSeek别名响应版本来自已授权最小实测；名称不是权重证明。 */
import type { Settings } from '../config/settings.js'
export function retrievalModel(settings: Settings) { return settings.agentRetrievalModel ?? 'glm-5.3' }
export function retrievalResponseModelMatches(expected: string, actual: unknown) {
  return actual === expected || (expected === 'deepseek-v4-flash' && typeof actual === 'string' && /^deepseek-v4-1-flash-\d{6}$/.test(actual))
}
