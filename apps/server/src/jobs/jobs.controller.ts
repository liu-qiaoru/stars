import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common'
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
