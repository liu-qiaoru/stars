import { describe, expect, test } from "vitest";
import { createSettings } from "../src/config/settings.js";

describe("createSettings", () => {
  test("从环境变量读取服务地址和外部依赖地址", () => {
    const settings = createSettings({
      SERVER_HOST: "0.0.0.0",
      SERVER_PORT: "5001",
      DATABASE_URL: "postgres://user:pass@localhost:5432/media_agent_test",
      QDRANT_URL: "http://localhost:6333",
    });

    expect(settings).toEqual({
      serverHost: "0.0.0.0",
      serverPort: 5001,
      databaseUrl: "postgres://user:pass@localhost:5432/media_agent_test",
      qdrantUrl: "http://localhost:6333",
    });
  });

  test("端口不是数字时抛出明确错误", () => {
    expect(() =>
      createSettings({
        SERVER_PORT: "not-a-number",
        DATABASE_URL: "postgres://user:pass@localhost:5432/media_agent_test",
        QDRANT_URL: "http://localhost:6333",
      }),
    ).toThrow("SERVER_PORT must be a valid port");
  });
});
