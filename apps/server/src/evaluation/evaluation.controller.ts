import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { EvaluationService } from './evaluation.service.js'

@Controller('evaluation')
export class EvaluationController {
  constructor(@Inject(EvaluationService) private readonly service: EvaluationService) {}

  @Get('sets') listSets() {
    return this.service.listSets()
  }
  @Post('sets') createSet(@Body() body: { name: string; description?: string }) {
    return this.service.createSet(body)
  }
  @Post('sets/:id/versions') createVersion(@Param('id') id: string) {
    return this.service.createVersion(id)
  }
  @Get('versions/:id') getVersion(@Param('id') id: string) {
    return this.service.getVersion(id)
  }
  @Post('versions/:id/queries') addQuery(@Param('id') id: string, @Body() body: unknown) {
    return this.service.addQuery(id, body)
  }
  @Post('versions/:versionId/queries/:queryId') updateQuery(
    @Param('versionId') versionId: string,
    @Param('queryId') queryId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateQuery(versionId, queryId, body)
  }
  @Post('versions/:id/freeze') freeze(@Param('id') id: string) {
    return this.service.freezeVersion(id)
  }
  @Post('versions/:id/runs') startRun(
    @Param('id') id: string,
    @Body() body: { library_ids?: string[] },
  ) {
    return this.service.startRun(id, body)
  }
  @Get('runs') listRuns(@Query('version_id') versionId?: string) {
    return this.service.listRuns(versionId)
  }
  @Get('runs/:id') getRun(@Param('id') id: string, @Query('reveal_evidence') reveal?: string) {
    return this.service.getRun(id, reveal === 'true')
  }
  @Get('runs/:id/export') exportRun(@Param('id') id: string) {
    return this.service.getRun(id, true)
  }
  @Post('runs/:runId/candidates/:candidateId/judgment') saveJudgment(
    @Param('runId') runId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: {
      relevance?: number | null
      unjudgeable?: boolean
      diagnosis?: string
      notes?: string
    },
  ) {
    return this.service.saveJudgment(runId, candidateId, body)
  }
  @Post('runs/:id/finalize') finalize(@Param('id') id: string) {
    return this.service.finalizeRun(id)
  }
}
