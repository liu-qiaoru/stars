import type { z } from 'zod'
import type { agentRerankRequestSchema } from '@local-media-agent/shared/schemas'
import type { Settings } from '../config/settings.js'
import { DashScopeShadowRerankProvider } from '../evaluation/dashscope-shadow-rerank.provider.js'
import {
  type ShadowRerankProviderResult,
} from '../evaluation/shadow-rerank.provider.js'

// 产品 Rerank 与 Evaluation shadow 使用相同的供应商 wire 协议，但必须拥有独立
// NestJS 注入 Token 和环境开关，避免开启历史评测时顺带开启真实用户查询外发。
export const AGENT_RERANK_PROVIDER = Symbol('AGENT_RERANK_PROVIDER')

export type AgentRerankRequest = z.infer<typeof agentRerankRequestSchema>

/** 产品 Provider 使用可变的 1～20 条候选；Evaluation 的固定 Top-20 接口保持不变。 */
export interface AgentRerankProvider {
  readonly available: boolean
  rerank(request: AgentRerankRequest, signal: AbortSignal): Promise<ShadowRerankProviderResult>
}

class DisabledAgentRerankProvider implements AgentRerankProvider {
  readonly available = false

  async rerank(): Promise<never> {
    throw new Error('Agent product rerank provider is disabled')
  }
}

// 产品 Rerank 统一外发 JPEG：对照片/视频帧类内容，JPEG 体积约为 PNG 的 1/5~1/10，
// 20 张证据序列化后可稳定低于百炼网关约 18.5MB 的请求体上限（实测 23MB 会被 413 拒收）。
// 评测 shadow 路径不引用此常量，继续保持 PNG，保证与历史评测记录的输入条件一致。
// AgentRerankService 计算请求字节数时使用同一常量，两处不能各自写死，防止漂移。
export const AGENT_RERANK_IMAGE_MIME = 'image/jpeg'

export function createAgentRerankProvider(
  settings: Pick<Settings, 'agentRerankProvider' | 'dashscopeWorkspaceId' | 'dashscopeApiKey'>,
): AgentRerankProvider {
  if (settings.agentRerankProvider !== 'dashscope') return new DisabledAgentRerankProvider()
  if (!settings.dashscopeWorkspaceId || !settings.dashscopeApiKey) {
    throw new Error('DashScope Agent rerank configuration is incomplete')
  }
  return new DashScopeShadowRerankProvider({
    workspaceId: settings.dashscopeWorkspaceId,
    apiKey: settings.dashscopeApiKey,
    imageMime: AGENT_RERANK_IMAGE_MIME,
  })
}
