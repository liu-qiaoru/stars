import { Inject, Injectable } from '@nestjs/common'
import { ModelGatewayService } from '../model-gateway/model-gateway.service.js'

@Injectable()
export class SearchQueryVectorService {
  constructor(
    @Inject(ModelGatewayService)
    private readonly modelGateway: ModelGatewayService,
  ) {}

  embedQuery(query: string, vectorDim: number) {
    // 在线 query embedding 必须同步完成，不能走 PostgreSQL job queue；否则搜索请求会被异步索引延迟卡住。
    return this.modelGateway.embedText(query, vectorDim)
  }
}
