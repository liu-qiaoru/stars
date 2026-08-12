import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common'
import type { z } from 'zod'
import {
  agentExportSelectionInputSchema,
  cancelAgentRunInputSchema,
  confirmAgentExportInputSchema,
  createAgentRunInputSchema,
  resumeAgentRunInputSchema,
  retryUnknownAgentRunInputSchema,
} from '@local-media-agent/shared/schemas'
import { AgentService } from './agent.service.js'
import {
  AgentRuntimeConfigService,
  type EditableAgentConfig,
} from './agent-runtime-config.service.js'

/** Agent V1 HTTP API：Controller 只转发请求；执行、确认守卫与配置校验均由领域服务完成。 */
@Controller('agent')
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(AgentRuntimeConfigService) private readonly runtimeConfig: AgentRuntimeConfigService,
  ) {}

  @Get('capabilities')
  getCapabilities() {
    return this.agentService.getCapabilities()
  }

  @Get('settings')
  getSettings() {
    return this.runtimeConfig.response()
  }

  @Put('settings')
  saveSettings(@Body() body: EditableAgentConfig) {
    return this.runtimeConfig.update(body)
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

  @Post('runs/:id/export-selection')
  exportSelection(
    @Param('id') id: string,
    @Body() body: z.input<typeof agentExportSelectionInputSchema>,
  ) {
    return this.agentService.exportSelection(id, body)
  }

  @Post('runs/:id/confirm')
  confirmExport(
    @Param('id') id: string,
    @Body() body: z.input<typeof confirmAgentExportInputSchema>,
  ) {
    return this.agentService.confirmExport(id, body)
  }
}
