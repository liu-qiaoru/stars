import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { ClipsController } from './clips.controller.js'
import { ClipsService } from './clips.service.js'

@Module({
  imports: [DatabaseModule],
  controllers: [ClipsController],
  providers: [ClipsService],
})
export class ClipsModule {}
