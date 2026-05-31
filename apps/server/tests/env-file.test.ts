import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findFirstExistingPath } from "../src/env-file.js";

describe("findFirstExistingPath", () => {
  test("当前目录没有 .env 时使用后续存在的 .env 路径", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "media-agent-env-"));
    const rootEnv = join(tempDir, ".env");
    writeFileSync(rootEnv, "SERVER_PORT=4010\n");

    expect(findFirstExistingPath([join(tempDir, "apps/server/.env"), rootEnv])).toBe(rootEnv);
  });
});
