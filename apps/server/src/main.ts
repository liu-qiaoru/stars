import "reflect-metadata";
import { loadEnvFile } from "node:process";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { SETTINGS, type Settings } from "./config/settings.js";
import { findFirstExistingPath } from "./env-file.js";

const envFilePath = findFirstExistingPath([".env", "../../.env"]);

if (envFilePath) {
  // pnpm --filter 会在 apps/server 下启动进程，所以这里显式兼容 monorepo 根目录的 .env。
  loadEnvFile(envFilePath);
}

const app = await NestFactory.create(AppModule);
const settings = app.get<Settings>(SETTINGS);

await app.listen(settings.serverPort, settings.serverHost);
