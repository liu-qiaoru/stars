import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { QdrantCollectionsService } from "./qdrant-collections.service.js";

@Module({
  imports: [ConfigModule],
  providers: [QdrantCollectionsService],
  exports: [QdrantCollectionsService],
})
export class QdrantModule {}
