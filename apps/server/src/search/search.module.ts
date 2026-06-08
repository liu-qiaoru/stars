import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { ModelGatewayModule } from '../model-gateway/model-gateway.module.js'
import { QdrantModule } from '../qdrant/qdrant.module.js'
import { SearchController } from './search.controller.js'
import { SearchQueryVectorService } from './search-query-vector.service.js'
import { SearchService } from './search.service.js'

@Module({
  imports: [DatabaseModule, QdrantModule, ModelGatewayModule],
  controllers: [SearchController],
  providers: [SearchService, SearchQueryVectorService],
  exports: [SearchService],
})
export class SearchModule {}
