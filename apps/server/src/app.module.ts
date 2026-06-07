import { Module } from '@nestjs/common'
import { ClipsModule } from './clips/clips.module.js'
import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { HealthModule } from './health/health.module.js'
import { JobsModule } from './jobs/jobs.module.js'
import { LibrariesModule } from './libraries/libraries.module.js'
import { MediaModule } from './media/media.module.js'
import { QdrantModule } from './qdrant/qdrant.module.js'
import { SearchModule } from './search/search.module.js'

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    JobsModule,
    LibrariesModule,
    MediaModule,
    ClipsModule,
    QdrantModule,
    SearchModule,
  ],
})
export class AppModule {}
