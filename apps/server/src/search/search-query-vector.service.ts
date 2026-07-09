import { Inject, Injectable } from '@nestjs/common'
import { ModelGatewayService } from '../model-gateway/model-gateway.service.js'
import type { VectorCollectionConfig } from '../qdrant/vector-collections.js'

@Injectable()
export class SearchQueryVectorService {
  constructor(
    @Inject(ModelGatewayService)
    private readonly modelGateway: ModelGatewayService,
  ) {}

  embedQuery(query: string, config: VectorCollectionConfig) {
    // 在线 query embedding 必须同步完成，不能走 PostgreSQL job queue；否则搜索请求会被异步索引延迟卡住。
    return this.modelGateway.embedText(query, {
      modelName: config.modelName,
      modelVersion: config.modelVersion,
      vectorDim: config.vectorDim,
    })
  }
}
