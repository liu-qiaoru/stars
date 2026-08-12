import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { EvaluationService } from './evaluation.service.js'
import { ShadowRerankService } from './shadow-rerank.service.js'

@Controller('evaluation')
export class EvaluationController {
  constructor(
    // tsx 开发运行时不会可靠保留 TypeScript 构造器类型元数据，因此与其他 Controller 一样
    // 显式声明注入 Token，避免真实 /evaluation/* 路由拿到 undefined service。
    @Inject(EvaluationService)
    private readonly service: EvaluationService,
    @Inject(ShadowRerankService)
    private readonly shadowRerank: ShadowRerankService,
  ) {}

  @Get('sets') listSets() {
    return this.service.listSets()
  }
  @Get('runs') listRuns(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('version_id') versionId?: string,
  ) {
    return this.service.listRuns({
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
      versionId,
    })
  }
  @Post('sets') createSet(@Body() body: { name: string; description?: string }) {
    return this.service.createSet(body)
  }
  @Get('targets/random') randomTargets(
    @Query('library_id') libraryId?: string,
    @Query('limit') limit?: string,
    @Query('seed') seed?: string,
  ) {
    return this.service.randomTargets({
      libraryId,
      limit: Number(limit ?? 10),
      seed: seed ?? 'default',
    })
  }
  @Get('versions/:id') getVersion(@Param('id') id: string) {
    return this.service.getVersion(id)
  }
  @Post('versions/:id/queries') addQuery(@Param('id') id: string, @Body() body: unknown) {
    return this.service.addQuery(id, body)
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
  @Get('runs/:id') getRun(@Param('id') id: string, @Query('reveal_evidence') reveal?: string) {
    return this.service.getRun(id, reveal === 'true')
  }
  @Post('runs/:runId/candidates/:candidateId/judgment') judgment(
    @Param('runId') runId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: {
      relevance?: number
      unjudgeable?: boolean
      diagnosis?: unknown
      notes?: string
    },
  ) {
    return this.service.saveJudgment(runId, candidateId, body)
  }
  @Post('runs/:id/finalize') finalize(@Param('id') id: string) {
    return this.service.finalizeRun(id)
  }

  @Post('runs/:id/shadow-rerank') startShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.startAndSchedule(id)
  }

  @Get('runs/:id/shadow-rerank') getShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.findByEvaluationRun(id)
  }
}
