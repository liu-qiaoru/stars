import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { LibrariesModule } from "./libraries/libraries.module.js";
import { QdrantModule } from "./qdrant/qdrant.module.js";

@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule, JobsModule, LibrariesModule, QdrantModule],
})
export class AppModule {}
