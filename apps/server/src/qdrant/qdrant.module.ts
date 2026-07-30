import { Module } from '@nestjs/common'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ConfigModule } from '../config/config.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE, DatabaseModule } from '../database/database.module.js'
import {
  hasVectorRefConfigMismatch,
  resetVectorRefsForCollection,
  type Database,
} from '../database/repositories.js'
import { QdrantCollectionsService } from './qdrant-collections.service.js'
import type {
  VectorCollectionConfig,
  VectorCollectionName,
} from './vector-collections.js'

export const QDRANT_CLIENT = Symbol('QDRANT_CLIENT')

function toVectorRefConfig(
  collectionName: VectorCollectionName,
  config: VectorCollectionConfig,
) {
  // Qdrant registry 与 PostgreSQL Vector Ref 使用不同命名风格；集中映射可避免模型升级时
  // reset 与 mismatch 检查漏改某个字段。
  return {
    collectionName,
    modelName: config.modelName,
    modelVersion: config.modelVersion,
    vectorKind: config.vectorKind,
    vectorDim: config.vectorDim,
    distance: config.distance,
  }
}

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    {
      provide: QdrantCollectionsService,
      inject: [SETTINGS, DATABASE],
      useFactory: (settings: Settings, db: Database) =>
        new QdrantCollectionsService(
          settings,
          fetch,
          undefined,
          async (collectionName, config) => {
            await resetVectorRefsForCollection(db, toVectorRefConfig(collectionName, config))
          },
          async (collectionName, config) =>
            hasVectorRefConfigMismatch(db, toVectorRefConfig(collectionName, config)),
        ),
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
