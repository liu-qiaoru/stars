import { Module } from '@nestjs/common'
import { AgentModule } from './agent/agent.module.js'
import { ClipsModule } from './clips/clips.module.js'
import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { HealthModule } from './health/health.module.js'
import { JobsModule } from './jobs/jobs.module.js'
import { LibrariesModule } from './libraries/libraries.module.js'
import { MediaModule } from './media/media.module.js'
import { QdrantModule } from './qdrant/qdrant.module.js'
import { SearchModule } from './search/search.module.js'

// AppModule 是 NestJS 的组合根：这里只声明模块依赖，不放业务逻辑。
// 新人排查请求链路时，一般从对应 module/controller/service 进入；跨模块共享能力通过 provider 注入。
// 旧评测运行层已在阶段 2.1 删除（强依赖 video_segment/scene_id metadata）；阶段 6 会基于正式
// video_scenes.id 与最终 Search API 重建评测能力。公共 RRF/指标纯函数保留在 ranking 模块。
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
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
