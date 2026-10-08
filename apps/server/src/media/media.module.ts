import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { MediaController } from './media.controller.js'
import {
  MEDIA_THUMBNAIL_RUNNER,
  MediaThumbnailService,
  runFfmpegThumbnail,
} from './media-thumbnail.service.js'
import { MediaService } from './media.service.js'

@Module({
  imports: [DatabaseModule],
  controllers: [MediaController],
  providers: [
    MediaService,
    MediaThumbnailService,
    { provide: MEDIA_THUMBNAIL_RUNNER, useValue: runFfmpegThumbnail },
  ],
  exports: [MediaService, MediaThumbnailService],
})
export class MediaModule {}
