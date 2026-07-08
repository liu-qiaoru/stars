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
      await this.jobsService.queuePendingEmbeddingJobs(
        this.settings.jobCoordinatorEmbeddingLimit,
      )
      await this.jobsService.queuePendingOcrJobs({
        limit: this.settings.jobCoordinatorOcrLimit,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Job coordination failed: ${message}`)
    } finally {
      this.isRunning = false
    }
  }
}
