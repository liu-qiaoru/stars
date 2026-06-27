import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { exportClipInputSchema } from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import { createJob, getMediaFile, type Database } from '../database/repositories.js'

export type ExportClipRequest = z.input<typeof exportClipInputSchema>

@Injectable()
export class ClipsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async exportClip(input: ExportClipRequest) {
    // 后端只校验请求和媒体类型，然后创建 export_clip job；真正的 FFmpeg 调用在 Python worker。
    const parsed = exportClipInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message)
    }

    const file = await getMediaFile(this.db, parsed.data.file_id)
    if (!file) {
      throw new NotFoundException('Media file not found')
    }
    if (file.mediaType !== 'video') {
      throw new BadRequestException('Clip export currently supports video files only')
    }

    // NestJS 只负责创建跨语言 job；源文件读取、FFmpeg 参数和输出目录都留给 Python worker 执行。
    const job = await createJob(this.db, {
      jobType: 'export_clip',
      inputJson: parsed.data,
    })
    return {
      job_id: job.id,
      status: job.status,
    }
  }
}
