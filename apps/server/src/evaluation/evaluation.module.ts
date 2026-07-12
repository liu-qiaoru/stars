import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { EvaluationController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'

@Module({
  imports: [DatabaseModule, SearchModule],
  controllers: [EvaluationController],
  providers: [EvaluationService],
})
export class EvaluationModule {}
