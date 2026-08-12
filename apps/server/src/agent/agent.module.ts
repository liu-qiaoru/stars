import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { AgentController } from './agent.controller.js'
import { AgentExecutorService, PhaseAPendingAgentStepHandler } from './agent-executor.service.js'
import { AgentService } from './agent.service.js'
import { AGENT_STEP_HANDLER } from './agent.types.js'

/**
 * Phase A 只注册持久化状态机和 Server 执行器。旧 Vercel AI SDK/Anthropic tool loop
 * 不再注入运行路径，因此本阶段不可能意外调用外部模型或 SearchService。
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentExecutorService,
    PhaseAPendingAgentStepHandler,
    {
      provide: AGENT_STEP_HANDLER,
      useExisting: PhaseAPendingAgentStepHandler,
    },
  ],
  exports: [AgentService, AgentExecutorService, AGENT_STEP_HANDLER],
})
export class AgentModule {}
