import { Module } from '@nestjs/common'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DatabaseModule } from '../database/database.module.js'
import { SearchModule } from '../search/search.module.js'
import { createShadowRerankProvider } from './dashscope-shadow-rerank.provider.js'
import { EvaluationController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'
import { SHADOW_RERANK_PROVIDER } from './shadow-rerank.provider.js'
import { ShadowRerankService } from './shadow-rerank.service.js'

// Evaluation 只编排正式 SearchService 并保存快照；它不直接访问 Qdrant，也不实现第二套召回。
@Module({
  imports: [DatabaseModule, SearchModule],
  controllers: [EvaluationController],
  providers: [
    EvaluationService,
    ShadowRerankService,
    {
      provide: SHADOW_RERANK_PROVIDER,
      inject: [SETTINGS],
      // 真实适配器随 Server 运行，但默认配置仍返回禁用实现。只有用户授权后显式设置
      // SHADOW_RERANK_PROVIDER=dashscope 且配置完整，Evaluation 才可能发起图片外传。
      useFactory: (settings: Settings) => createShadowRerankProvider(settings),
    },
  ],
})
export class EvaluationModule {}
