import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
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

/**
 * AgentModule 保留 Phase B 的固定意图分类和原文搜索，并在 Phase C 注册 allowlist
 * 运行配置、候选确认和安全导出入口。HTTP 客户端和 Runner 都保留注入点，测试因此
 * 可以使用内存桩，绝不会因导入模块而真实调用 RightAPI。
 */
@Module({
  imports: [DatabaseModule, SearchModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentRuntimeConfigService,
    AgentExecutorService,
    AgentV1StepHandler,
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
      useExisting: AgentV1StepHandler,
    },
  ],
  exports: [AgentService, AgentExecutorService, AGENT_STEP_HANDLER, AGENT_INTENT_RUNNER],
})
export class AgentModule {}
