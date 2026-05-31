import { Client } from "pg";
import type { Settings } from "../config/settings.js";

export type DependencyStatus = "ok" | "error";

export interface DependencyChecks {
  database: () => Promise<DependencyStatus>;
  qdrant: () => Promise<DependencyStatus>;
}

export const DEPENDENCY_CHECKS = Symbol("DEPENDENCY_CHECKS");

export function createDependencyChecks(settings: Settings): DependencyChecks {
  return {
    database: () => checkSafely(() => checkPostgres(settings.databaseUrl)),
    qdrant: () => checkSafely(() => checkQdrant(settings.qdrantUrl)),
  };
}

async function checkSafely(check: () => Promise<void>): Promise<DependencyStatus> {
  try {
    await check();
    return "ok";
  } catch {
    return "error";
  }
}

async function checkPostgres(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    // 健康检查只验证数据库可连接和可执行最小查询；schema/migration 校验留给 Phase 3。
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkQdrant(qdrantUrl: string): Promise<void> {
  // Qdrant 1.18 对 HEAD 和 /readyz 的行为不适合作为健康检查；/collections 是轻量且稳定的读 API。
  const healthUrl = new URL("/collections", qdrantUrl);
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    throw new Error(`Qdrant health check failed with ${response.status}`);
  }
}
