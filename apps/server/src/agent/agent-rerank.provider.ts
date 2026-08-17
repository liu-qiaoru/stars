import type { Settings } from '../config/settings.js'
import { DashScopeShadowRerankProvider } from '../evaluation/dashscope-shadow-rerank.provider.js'
import {
  DisabledShadowRerankProvider,
  type ShadowRerankProvider,
} from '../evaluation/shadow-rerank.provider.js'

// 产品 Rerank 与 Evaluation shadow 使用相同的供应商 wire 协议，但必须拥有独立
// NestJS 注入 Token 和环境开关，避免开启历史评测时顺带开启真实用户查询外发。
export const AGENT_RERANK_PROVIDER = Symbol('AGENT_RERANK_PROVIDER')

export function createAgentRerankProvider(
  settings: Pick<Settings, 'agentRerankProvider' | 'dashscopeWorkspaceId' | 'dashscopeApiKey'>,
): ShadowRerankProvider {
  if (settings.agentRerankProvider !== 'dashscope') return new DisabledShadowRerankProvider()
  if (!settings.dashscopeWorkspaceId || !settings.dashscopeApiKey) {
    throw new Error('DashScope Agent rerank configuration is incomplete')
  }
  return new DashScopeShadowRerankProvider({
    workspaceId: settings.dashscopeWorkspaceId,
    apiKey: settings.dashscopeApiKey,
  })
}
