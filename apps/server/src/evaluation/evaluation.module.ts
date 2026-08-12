import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { EvaluationController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'
import { DisabledShadowRerankProvider, SHADOW_RERANK_PROVIDER } from './shadow-rerank.provider.js'
import { ShadowRerankService } from './shadow-rerank.service.js'

// Evaluation 只编排正式 SearchService 并保存快照；它不直接访问 Qdrant，也不实现第二套召回。
@Module({
  imports: [DatabaseModule, SearchModule],
  controllers: [EvaluationController],
  providers: [
    EvaluationService,
    ShadowRerankService,
    { provide: SHADOW_RERANK_PROVIDER, useClass: DisabledShadowRerankProvider },
  ],
})
export class EvaluationModule {}
