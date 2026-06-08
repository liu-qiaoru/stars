import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { MediaController } from './media.controller.js'
import { MediaService } from './media.service.js'

@Module({
  imports: [DatabaseModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
