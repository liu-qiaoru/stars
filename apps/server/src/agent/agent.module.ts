import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { MediaModule } from '../media/media.module.js'
import { AgentController } from './agent.controller.js'
import { AnthropicAgentModelRunner } from './agent-model.runner.js'
import { AgentService } from './agent.service.js'
import { AGENT_MODEL_RUNNER } from './agent.types.js'

@Module({
  imports: [DatabaseModule, SearchModule, MediaModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    {
      provide: AGENT_MODEL_RUNNER,
      useClass: AnthropicAgentModelRunner,
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
