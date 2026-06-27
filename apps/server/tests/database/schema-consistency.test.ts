import { describe, expect, test } from "vitest";
import { getMissingSchemaFields, pythonWorkerSchemaContract } from "../../src/database/schema-consistency.js";

describe("schema consistency", () => {
  test("Python worker 访问的关键字段存在于 Drizzle schema", () => {
    expect(getMissingSchemaFields(pythonWorkerSchemaContract)).toEqual([]);
  });
});
