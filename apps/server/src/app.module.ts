import { Module } from '@nestjs/common'
import { AgentModule } from './agent/agent.module.js'
import { ClipsModule } from './clips/clips.module.js'
import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { HealthModule } from './health/health.module.js'
import { EvaluationModule } from './evaluation/evaluation.module.js'
import { JobsModule } from './jobs/jobs.module.js'
import { LibrariesModule } from './libraries/libraries.module.js'
import { MediaModule } from './media/media.module.js'
import { QdrantModule } from './qdrant/qdrant.module.js'
import { SearchModule } from './search/search.module.js'

// AppModule 是 NestJS 的组合根：这里只声明模块依赖，不放业务逻辑。
// 新人排查请求链路时，一般从对应 module/controller/service 进入；跨模块共享能力通过 provider 注入。
// 评测运行层基于正式 video_scenes.id 与最终 Search API，不维护第二套召回。
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    EvaluationModule,
    JobsModule,
    LibrariesModule,
    MediaModule,
    ClipsModule,
    AgentModule,
    QdrantModule,
    SearchModule,
  ],
})
export class AppModule {}
