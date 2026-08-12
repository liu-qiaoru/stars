import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { AgentController } from './agent.controller.js'
import { AgentV1StepHandler } from './agent-v1-step.handler.js'
import { AgentExecutorService } from './agent-executor.service.js'
import { AgentService } from './agent.service.js'
import { AGENT_STEP_HANDLER } from './agent.types.js'
import {
  AGENT_INTENT_HTTP_CLIENT,
  AGENT_INTENT_RUNNER,
  QwenAgentIntentRunner,
} from './qwen-agent-intent.runner.js'

/**
 * Phase B 注册固定的两步运行路径：qwen3.7-plus 只做一次意图分类，随后 Server
 * 用完整原文调用一次 SearchService。HTTP 客户端和 Runner 都保留注入点，测试因此
 * 可以使用内存桩，绝不会因导入模块而真实调用 RightAPI。
 */
@Module({
  imports: [DatabaseModule, SearchModule],
  controllers: [AgentController],
  providers: [
    AgentService,
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
