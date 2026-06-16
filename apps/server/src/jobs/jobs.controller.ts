import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common'
import { JobsService } from './jobs.service.js'

@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(JobsService)
    private readonly jobsService: JobsService,
  ) {}

  @Get()
  listJobs() {
    return this.jobsService.listJobs()
  }

  @Get(':id')
  getJob(@Param('id') id: string) {
    return this.jobsService.getJob(id)
  }

  @Post('embedding/queue-pending')
  queuePendingEmbeddingJobs(@Body() body: { limit?: number }) {
    return this.jobsService.queuePendingEmbeddingJobs(body?.limit)
  }

  @Post('ocr/queue-pending')
  queuePendingOcrJobs(@Body() body: { library_id?: string; file_id?: string; batch_size?: number; limit?: number }) {
    return this.jobsService.queuePendingOcrJobs({
      libraryId: body?.library_id,
      fileId: body?.file_id,
      batchSize: body?.batch_size,
      limit: body?.limit,
    })
  }
}
