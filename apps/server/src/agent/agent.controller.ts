import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common'
import type { z } from 'zod'
import {
  cancelAgentRunInputSchema,
  createAgentRunInputSchema,
  resumeAgentRunInputSchema,
  retryUnknownAgentRunInputSchema,
} from '@local-media-agent/shared/schemas'
import { AgentService } from './agent.service.js'

/** Agent V1 HTTP API：Controller 只转发请求；Phase B 的模型与搜索工作由后台执行器完成。 */
@Controller('agent')
export class AgentController {
  constructor(@Inject(AgentService) private readonly agentService: AgentService) {}

  @Get('capabilities')
  getCapabilities() {
    return this.agentService.getCapabilities()
  }

  @Post('runs')
  createRun(@Body() body: z.input<typeof createAgentRunInputSchema>) {
    return this.agentService.createRun(body)
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.agentService.getRun(id)
  }

  @Post('runs/:id/resume')
  resumeRun(@Param('id') id: string, @Body() body: z.input<typeof resumeAgentRunInputSchema>) {
    return this.agentService.resumeRun(id, body)
  }

  @Post('runs/:id/cancel')
  cancelRun(@Param('id') id: string, @Body() body: z.input<typeof cancelAgentRunInputSchema>) {
    return this.agentService.cancelRun(id, body)
  }

  @Post('runs/:id/retry-unknown')
  retryUnknown(
    @Param('id') id: string,
    @Body() body: z.input<typeof retryUnknownAgentRunInputSchema>,
  ) {
    return this.agentService.retryUnknown(id, body)
  }
}
