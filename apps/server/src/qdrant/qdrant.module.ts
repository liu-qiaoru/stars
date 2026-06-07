import { Module } from '@nestjs/common'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ConfigModule } from '../config/config.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { QdrantCollectionsService } from './qdrant-collections.service.js'

export const QDRANT_CLIENT = Symbol('QDRANT_CLIENT')

@Module({
  imports: [ConfigModule],
  providers: [
    QdrantCollectionsService,
    {
      provide: QDRANT_CLIENT,
      inject: [SETTINGS],
      useFactory: (settings: Settings) =>
        new QdrantClient({
          url: settings.qdrantUrl,
          checkCompatibility: false,
        }),
    },
  ],
  exports: [QdrantCollectionsService, QDRANT_CLIENT],
})
export class QdrantModule {}
