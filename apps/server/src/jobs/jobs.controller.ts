import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { JobsService } from './jobs.service.js'

@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(JobsService)
    private readonly jobsService: JobsService,
  ) {}

  @Get()
  listJobs(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.jobsService.listJobs({
      limit: this.optionalInteger(limit, 'limit'),
      offset: this.optionalInteger(offset, 'offset'),
    })
  }

  @Get(':id')
  getJob(@Param('id') id: string) {
    return this.jobsService.getJob(id)
  }

  @Post('embedding/queue-pending')
  queuePendingEmbeddingJobs(@Body() body: { limit?: number }) {
    // 手动补队列入口：扫描 pending vector_refs 并创建 embedding jobs，适合重建 collection 后使用。
    return this.jobsService.queuePendingEmbeddingJobs(body?.limit)
  }

  @Post('ocr/queue-pending')
  queuePendingOcrJobs(
    @Body() body: { library_id?: string; file_id?: string; batch_size?: number; limit?: number },
  ) {
    // OCR 可以在索引完成后自动创建，也可以通过这个入口按 library/file 补漏。
    return this.jobsService.queuePendingOcrJobs({
      libraryId: body?.library_id,
      fileId: body?.file_id,
      batchSize: body?.batch_size,
      limit: body?.limit,
    })
  }

  private optionalInteger(value: string | undefined, name: string) {
    if (value === undefined) {
      return undefined
    }
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
      throw new BadRequestException(`${name} must be a non-negative integer`)
    }
    return parsed
  }
}
