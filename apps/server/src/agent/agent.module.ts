import { SceneInspectionTool } from './scene-inspection.tool.js'
import { MatchedEvidenceTool } from './matched-evidence.tool.js'
import { MediaModule } from '../media/media.module.js'
import { RetrievalSelectionService } from './retrieval-selection.service.js'
import { RetrievalAgentHandler } from './retrieval-agent.handler.js'
import { SegmentDetailsTool } from './segment-details.tool.js'
import { RETRIEVAL_DECISION_RUNNER, RightApiRetrievalDecisionRunner } from './retrieval-decision.runner.js'
import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { CandidateEvidenceModule } from '../candidate-evidence/candidate-evidence.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { AgentController } from './agent.controller.js'
import { AgentV1StepHandler } from './agent-v1-step.handler.js'
import { AgentExecutorService } from './agent-executor.service.js'
import { AgentService } from './agent.service.js'
import { AgentRuntimeConfigService } from './agent-runtime-config.service.js'
import { AGENT_STEP_HANDLER } from './agent.types.js'
import {
  AGENT_INTENT_HTTP_CLIENT,
  AGENT_INTENT_RUNNER,
  QwenAgentIntentRunner,
} from './qwen-agent-intent.runner.js'
import { AgentRerankService } from './agent-rerank.service.js'
import { AGENT_RERANK_PROVIDER, createAgentRerankProvider } from './agent-rerank.provider.js'
import { AgentAuditController } from './agent-audit.controller.js'
import { AgentAuditService } from './agent-audit.service.js'

/**
 * AgentModule 保留 Phase B 的固定意图分类和原文搜索，并在 Phase C 注册 allowlist
 * 运行配置、候选确认和安全导出入口。HTTP 客户端和 Runner 都保留注入点，测试因此
 * 可以使用内存桩，绝不会因导入模块而真实调用 RightAPI。
 */
@Module({
  imports: [DatabaseModule, SearchModule, CandidateEvidenceModule, MediaModule],
  controllers: [AgentController, AgentAuditController],
  providers: [
    AgentService,
    AgentRuntimeConfigService,
    AgentExecutorService,
    AgentV1StepHandler,
    RetrievalAgentHandler,
    RetrievalSelectionService,
    SegmentDetailsTool,
    SceneInspectionTool,
    MatchedEvidenceTool,
    RightApiRetrievalDecisionRunner,
    { provide: RETRIEVAL_DECISION_RUNNER, useExisting: RightApiRetrievalDecisionRunner },
    AgentRerankService,
    AgentAuditService,
    QwenAgentIntentRunner,
    {
      provide: AGENT_INTENT_HTTP_CLIENT,
      useValue: fetch,
    },
    {
      provide: AGENT_INTENT_RUNNER,
      useExisting: QwenAgentIntentRunner,
    },
    {
      provide: AGENT_STEP_HANDLER,
      useExisting: RetrievalAgentHandler,
    },
    {
      provide: AGENT_RERANK_PROVIDER,
      inject: [SETTINGS],
      // 产品入口拥有独立配置闸门；默认 Disabled 实现不会建立任何网络连接。
      useFactory: (settings: Settings) => createAgentRerankProvider(settings),
    },
  ],
  exports: [
    AgentService,
    AgentExecutorService,
    AgentRerankService,
    AGENT_STEP_HANDLER,
    AGENT_INTENT_RUNNER,
  ],
})
export class AgentModule {}
