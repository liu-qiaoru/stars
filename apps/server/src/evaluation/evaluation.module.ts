import { Module } from '@nestjs/common'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DatabaseModule } from '../database/database.module.js'
import { CandidateEvidenceModule } from '../candidate-evidence/candidate-evidence.module.js'
import { SearchModule } from '../search/search.module.js'
import { createShadowRerankProvider } from './dashscope-shadow-rerank.provider.js'
import { EvaluationController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'
import { VlmBlindCapabilityService } from './vlm-blind-capability.service.js'
import { SHADOW_RERANK_PROVIDER } from './shadow-rerank.provider.js'
import { ShadowRerankService } from './shadow-rerank.service.js'
import { VlmBlindDatasetService } from './vlm-blind-dataset.service.js'
import { VlmBlindLabelingService } from './vlm-blind-labeling.service.js'
import {
  createProtocolExerciseFakeVlmReviewProvider,
  VLM_REVIEW_PROVIDER,
} from './vlm-review.provider.js'
import {
  createQwenVlmReviewProvider,
  VLM_REAL_REVIEW_PROVIDER,
} from './qwen-vlm-review.provider.js'

// Evaluation 只编排正式 SearchService 并保存快照；它不直接访问 Qdrant，也不实现第二套召回。
@Module({
  imports: [DatabaseModule, SearchModule, CandidateEvidenceModule],
  controllers: [EvaluationController],
  providers: [
    EvaluationService,
    ShadowRerankService,
    VlmBlindDatasetService,
    VlmBlindLabelingService,
    VlmBlindCapabilityService,
    {
      provide: VLM_REVIEW_PROVIDER,
      // Phase F 本提交有意只注册本地 fake。这里没有 settings、URL 或 API key，
      // 因而任何 HTTP 路由都不可能退化为真实图片外发。
      useFactory: createProtocolExerciseFakeVlmReviewProvider,
    },
    {
      provide: VLM_REAL_REVIEW_PROVIDER,
      inject: [SETTINGS],
      // 真实适配器使用独立 Token。默认 disabled，且即使 Provider 可用，执行前仍需
      // PostgreSQL 中与三份冻结指纹绑定的视觉授权。
      useFactory: (settings: Settings) => createQwenVlmReviewProvider(settings),
    },
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
