import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class SearchQueryVectorService {
  embedQuery(query: string, vectorDim: number) {
    // Phase 6 只验证 Qdrant retrieval/read path；真实 query embedding 会在 Phase 10 通过本地模型服务替换这里。
    // 这里生成稳定 mock vector，让同一个文本查询在测试和本地开发中可重复，同时不把模型依赖提前塞进 API 层。
    return Array.from({ length: vectorDim }, (_, index) => {
      const digest = createHash("sha256").update(`${query}:${index}`).digest();
      const unsigned = digest.readUInt32BE(0);
      return unsigned / 0xffffffff;
    });
  }
}
