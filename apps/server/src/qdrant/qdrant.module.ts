import { Module } from '@nestjs/common'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ConfigModule } from '../config/config.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE, DatabaseModule } from '../database/database.module.js'
import {
  resetVectorRefsForCollection,
  type Database,
} from '../database/repositories.js'
import { QdrantCollectionsService } from './qdrant-collections.service.js'

export const QDRANT_CLIENT = Symbol('QDRANT_CLIENT')

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    {
      provide: QdrantCollectionsService,
      inject: [SETTINGS, DATABASE],
      useFactory: (settings: Settings, db: Database) =>
        new QdrantCollectionsService(settings, fetch, undefined, async (collectionName, config) => {
          await resetVectorRefsForCollection(db, {
            collectionName,
            modelName: config.modelName,
            modelVersion: config.modelVersion,
            vectorKind: config.vectorKind,
            vectorDim: config.vectorDim,
            distance: config.distance,
          })
        }),
    },
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
