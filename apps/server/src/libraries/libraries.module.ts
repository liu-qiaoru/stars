import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { LibrariesController } from "./libraries.controller.js";
import { LibrariesService } from "./libraries.service.js";

@Module({
  imports: [DatabaseModule, JobsModule],
  controllers: [LibrariesController],
  providers: [LibrariesService],
})
export class LibrariesModule {}
