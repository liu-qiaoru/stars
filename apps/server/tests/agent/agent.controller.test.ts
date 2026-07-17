import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentController } from "../../src/agent/agent.controller.js";
import { AgentModule } from "../../src/agent/agent.module.js";
import { AGENT_MODEL_RUNNER, type AgentModelRunner } from "../../src/agent/agent.types.js";
import { SETTINGS } from "../../src/config/settings.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createLibrary, createMediaAsset, createMediaFile, createVectorRef } from "../../src/database/repositories.js";
import { videoScenes } from "../../src/database/schema.js";
import { JobsController } from "../../src/jobs/jobs.controller.js";
import { JobsModule } from "../../src/jobs/jobs.module.js";
import { ModelGatewayService } from "../../src/model-gateway/model-gateway.service.js";
import { QDRANT_CLIENT } from "../../src/qdrant/qdrant.module.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let agentController: AgentController;
let jobsController: JobsController;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const qdrantSearch = vi.fn();
const embedText = vi.fn();
const runnerRun = vi.fn<AgentModelRunner["run"]>();

function testSettings(overrides = {}) {
  return {
    serverHost: "127.0.0.1",
    serverPort: 4000,
    databaseUrl: "postgres://user:pass@localhost:5432/media_agent_test",
    qdrantUrl: "http://localhost:6333",
    modelServiceUrl: "http://127.0.0.1:4020",
    modelServiceTimeoutMs: 10000,
    allowExternalLlm: false,
    anthropicApiKey: undefined,
    agentModel: "disabled",
    agentMaxSteps: 4,
    agentToolTimeoutMs: 10000,
    ...overrides,
  };
}

async function compileAgentModule(settings = testSettings()) {
  const testDb = await createTestDatabase();
  db = testDb.db;
  closeDb = testDb.close;
  qdrantSearch.mockReset();
  embedText.mockReset();
  embedText.mockResolvedValue(Array.from({ length: 768 }, (_, index) => index / 768));
  runnerRun.mockReset();

  const moduleRef = await Test.createTestingModule({
    imports: [AgentModule, JobsModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(settings)
    .overrideProvider(QDRANT_CLIENT)
    .useValue({ search: qdrantSearch, searchPointGroups: qdrantSearch })
    .overrideProvider(ModelGatewayService)
    .useValue({ embedText })
    .overrideProvider(AGENT_MODEL_RUNNER)
    .useValue({ run: runnerRun })
    .compile();

  agentController = moduleRef.get(AgentController);
  jobsController = moduleRef.get(JobsController);
  closeModule = () => moduleRef.close();
}

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
});

describe("agent API", () => {
  beforeEach(async () => {
    await compileAgentModule();
  });

  test("外部 LLM 默认关闭时仍持久化 run 和事件", async () => {
    const created = await agentController.createRun({
      prompt: "查找发布会片段",
      allow_external_vlm: false,
    });

    expect(created).toMatchObject({
      run_id: expect.any(String),
      status: "succeeded",
      message: expect.stringContaining("外部大模型未启用"),
    });
    expect(runnerRun).not.toHaveBeenCalled();

    await expect(agentController.getRun(created.run_id)).resolves.toMatchObject({
      id: created.run_id,
      status: "succeeded",
      prompt: "查找发布会片段",
      events: [
        expect.objectContaining({ type: "run_started" }),
        expect.objectContaining({ type: "run_succeeded" }),
      ],
    });
  });

  test("开启外部 LLM 时 fake runner 可以调用 search_media tool 并持久化 tool summary", async () => {
    await closeModule?.();
    await closeDb?.();
    await compileAgentModule(testSettings({ allowExternalLlm: true, anthropicApiKey: "test-key", agentModel: "test-model" }));

    const library = await createLibrary(db, { name: "Main Media", rootPath: "/Volumes/Media" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/launch.mp4",
      relativePath: "launch.mp4",
      mediaType: "video",
      sizeBytes: 20,
      mtimeMs: 1710000000001,
    });
    const [scene] = await db
      .insert(videoScenes)
      .values({
        id: randomUUID(),
        fileId: file.id,
        sceneKey: "scene-0001",
        startTimeSeconds: "30",
        endTimeSeconds: "60",
        detectionStrategy: "scene_detection",
        strategyFingerprint: "test-fingerprint",
        indexGeneration: 0,
      })
      .returning();
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_frame",
      sceneId: scene.id,
      frameTimeSeconds: "45",
      contentHash: "frame-hash",
    });
    const pointId = "22222222-2222-4222-8222-222222222222";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_frame_vectors",
      pointId,
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "frame-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    // 视频帧向量走分组检索：返回该场景一个组，代表帧即命中的 point。
    qdrantSearch.mockResolvedValue({
      groups: [{ id: scene.id, hits: [{ id: pointId, score: 0.82 }] }],
    });
    runnerRun.mockImplementation(async ({ tools }) => {
      const input = { query: "发布会", media_types: ["video"], library_ids: [], limit: 5, offset: 0 };
      const output = (await tools.search_media.execute(input)) as {
        results: Array<Record<string, unknown>>;
      };
      expect(output.results[0]).toMatchObject({
        file_id: file.id,
        asset_id: asset.id,
        score_kind: "hybrid_score",
        primary_reason: "vector_match",
      });
      expect(output.results[0]).not.toHaveProperty("path");
      return {
        summary: "找到候选视频片段",
        toolCalls: [{ toolCallId: "search-1", toolName: "search_media", input, output }],
      };
    });

    const created = await agentController.createRun({
      prompt: "查找发布会片段",
      allow_external_vlm: false,
    });
    const run = await agentController.getRun(created.run_id);

    expect(run).toMatchObject({
      status: "succeeded",
      summary: "找到候选视频片段",
      tool_calls: [
        {
          tool_call_id: "search-1",
          name: "search_media",
          status: "succeeded",
          summary: "search_media completed",
        },
      ],
      results: [
        expect.objectContaining({
          file_id: file.id,
          asset_id: asset.id,
          start_time_seconds: 30,
          end_time_seconds: 60,
          score: 0.82,
        }),
      ],
    });
  });

  test("export_clip tool 先写确认事件，确认后才创建 export job", async () => {
    await closeModule?.();
    await closeDb?.();
    await compileAgentModule(testSettings({ allowExternalLlm: true, anthropicApiKey: "test-key", agentModel: "test-model" }));

    const library = await createLibrary(db, { name: "Main Media", rootPath: "/Volumes/Media" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/launch.mp4",
      relativePath: "launch.mp4",
      mediaType: "video",
      sizeBytes: 20,
      mtimeMs: 1710000000001,
      durationSeconds: "120",
    });
    runnerRun.mockImplementation(async ({ tools }) => {
      const input = {
        file_id: file.id,
        start_time_seconds: 30,
        end_time_seconds: 60,
        output_format: "mp4" as const,
      };
      const output = await tools.export_clip.execute(input, { toolCallId: "export-1" });
      return {
        summary: "需要确认导出",
        toolCalls: [{ toolCallId: "export-1", toolName: "export_clip", input, output }],
      };
    });

    const created = await agentController.createRun({
      prompt: "导出这个片段",
      allow_external_vlm: false,
    });
    const pending = await agentController.getRun(created.run_id);

    expect(pending).toMatchObject({
      status: "waiting_for_confirmation",
      tool_calls: [
        {
          tool_call_id: "export-1",
          name: "export_clip",
          status: "waiting_for_confirmation",
          requires_confirmation: true,
        },
      ],
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "user_confirmation_required",
          tool_call_id: "export-1",
        }),
      ]),
    });
    await expect(jobsController.listJobs()).resolves.toMatchObject({ items: [], total: 0 });

    const confirmed = await agentController.confirmToolCall(created.run_id, { tool_call_id: "export-1" });

    expect(confirmed).toMatchObject({ job_id: expect.any(String), status: "queued" });
    await expect(jobsController.getJob(confirmed.job_id)).resolves.toMatchObject({
      job_type: "export_clip",
      input: {
        file_id: file.id,
        start_time_seconds: 30,
        end_time_seconds: 60,
        output_format: "mp4",
      },
    });
  });
});
