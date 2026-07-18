import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { SETTINGS, type Settings } from '../config/settings.js'
import { JobsService } from './jobs.service.js'

@Injectable()
export class JobsCoordinatorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsCoordinatorService.name)
  private timer: ReturnType<typeof setInterval> | undefined
  private isRunning = false

  constructor(
    @Inject(JobsService) private readonly jobsService: JobsService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  onApplicationBootstrap() {
    if (!this.settings.jobCoordinatorEnabled) {
      return
    }

    void this.runOnce()
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.settings.jobCoordinatorIntervalMs)
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async runOnce() {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    try {
      // 协调器定时把 pending vector_refs 转成 embedding jobs。OCR 能力已在阶段 2 删除，
      // 不再有 OCR 补队列；场景检测与抽帧由 index_media 任务自身驱动。
      await this.jobsService.queuePendingEmbeddingJobs(
        this.settings.jobCoordinatorEmbeddingLimit,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Job coordination failed: ${message}`)
    } finally {
      this.isRunning = false
    }
  }
}
