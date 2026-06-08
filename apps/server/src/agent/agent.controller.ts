import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common'
import { AgentService } from './agent.service.js'

@Controller('agent/runs')
export class AgentController {
  constructor(
    @Inject(AgentService)
    private readonly agentService: AgentService,
  ) {}

  @Post()
  createRun(@Body() body: { prompt: string; allow_external_vlm?: boolean }) {
    return this.agentService.createRun(body)
  }

  @Get(':id')
  getRun(@Param('id') id: string) {
    return this.agentService.getRun(id)
  }

  @Post(':id/confirm')
  confirmToolCall(@Param('id') id: string, @Body() body: { tool_call_id: string }) {
    return this.agentService.confirmToolCall(id, body)
  }
}
