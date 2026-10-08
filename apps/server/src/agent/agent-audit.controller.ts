import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { AgentAuditService } from './agent-audit.service.js'

/** 内部只读审计 API；普通用户结果接口不会复用这些包含 RRF 和 Trace 的响应。 */
@Controller('agent/audit')
export class AgentAuditController {
  constructor(@Inject(AgentAuditService) private readonly auditService: AgentAuditService) {}

  @Get('runs')
  listRuns(@Query('limit') limit?: string) {
    return this.auditService.listRuns(limit)
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.auditService.getRun(id)
  }
}
