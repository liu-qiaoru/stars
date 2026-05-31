import { Global, Module } from "@nestjs/common";
import { createSettings, SETTINGS } from "./settings.js";

@Global()
@Module({
  providers: [
    {
      provide: SETTINGS,
      useFactory: () => createSettings(),
    },
  ],
  exports: [SETTINGS],
})
export class ConfigModule {}
