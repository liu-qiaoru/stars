import { Module } from "@nestjs/common";
import { SETTINGS, type Settings } from "../config/settings.js";
import { createDependencyChecks, DEPENDENCY_CHECKS } from "./dependency-checks.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: DEPENDENCY_CHECKS,
      inject: [SETTINGS],
      useFactory: (settings: Settings) => createDependencyChecks(settings),
    },
  ],
})
export class HealthModule {}
