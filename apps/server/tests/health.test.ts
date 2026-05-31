import { Test } from "@nestjs/testing";
import { describe, expect, test } from "vitest";
import { AppModule } from "../src/app.module.js";
import { SETTINGS } from "../src/config/settings.js";
import { DEPENDENCY_CHECKS, type DependencyChecks } from "../src/health/dependency-checks.js";
import { HealthController } from "../src/health/health.controller.js";

async function createTestController(dependencyChecks: DependencyChecks) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(SETTINGS)
    .useValue({
      serverHost: "127.0.0.1",
      serverPort: 4000,
      databaseUrl: "postgres://user:pass@localhost:5432/media_agent_test",
      qdrantUrl: "http://localhost:6333",
    })
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue(dependencyChecks)
    .compile();

  return {
    controller: moduleRef.get(HealthController),
    close: () => moduleRef.close(),
  };
}

function createResponseRecorder() {
  return {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
    },
  };
}

describe("GET /health", () => {
  test("返回服务和依赖均正常的健康状态", async () => {
    const { controller, close } = await createTestController({
      database: async () => "ok",
      qdrant: async () => "ok",
    });
    const response = createResponseRecorder();

    const body = await controller.getHealth(response);

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      status: "ok",
      dependencies: {
        database: "ok",
        qdrant: "ok",
      },
    });

    await close();
  });

  test("任一依赖失败时返回 503 和 error 状态", async () => {
    const { controller, close } = await createTestController({
      database: async () => "ok",
      qdrant: async () => "error",
    });
    const response = createResponseRecorder();

    const body = await controller.getHealth(response);

    expect(response.statusCode).toBe(503);
    expect(body).toEqual({
      status: "error",
      dependencies: {
        database: "ok",
        qdrant: "error",
      },
    });

    await close();
  });
});
