import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SETTINGS } from "../../src/config/settings.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createJob, createLibrary, createMediaAsset, createMediaFile, createVectorRef } from "../../src/database/repositories.js";
import { JobsController } from "../../src/jobs/jobs.controller.js";
import { JobsModule } from "../../src/jobs/jobs.module.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let service: JobsService;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const testSettings = {
  serverHost: "127.0.0.1",
  serverPort: 4000,
  databaseUrl: "postgres://user:pass@localhost:5432/media_agent_test",
  qdrantUrl: "http://localhost:6333",
  modelServiceUrl: "http://127.0.0.1:4020",
  modelServiceTimeoutMs: 10000,
  allowExternalLlm: false,
  agentModel: "disabled",
  agentMaxSteps: 4,
  agentToolTimeoutMs: 10000,
};

beforeEach(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  closeDb = testDb.close;

  const moduleRef = await Test.createTestingModule({
    imports: [JobsModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile();

  service = moduleRef.get(JobsService);
  closeModule = () => moduleRef.close();
});

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
});

describe("jobs service", () => {
  test("OCR queue-pending controller 透传 limit 和 batch size", () => {
    const jobsService = {
      queuePendingOcrJobs: vi.fn().mockReturnValue({ scanned: 0, created: 0, skipped: 0 }),
    } as unknown as JobsService;
    const controller = new JobsController(jobsService);

    controller.queuePendingOcrJobs({
      library_id: "11111111-1111-4111-8111-111111111111",
      file_id: "22222222-2222-4222-8222-222222222222",
      batch_size: 5,
      limit: 50,
    });

    expect(jobsService.queuePendingOcrJobs).toHaveBeenCalledWith({
      libraryId: "11111111-1111-4111-8111-111111111111",
      fileId: "22222222-2222-4222-8222-222222222222",
      batchSize: 5,
      limit: 50,
    });
  });

  test("按优先级 claim queued job 并写入 worker lock", async () => {
    await createJob(db, {
      jobType: "scan_library",
      priority: 0,
      inputJson: { library_id: "11111111-1111-4111-8111-111111111111", root_path: "/low", scan_mode: "mtime_size" },
    });
    const highPriority = await createJob(db, {
      jobType: "scan_library",
      priority: 10,
      inputJson: { library_id: "22222222-2222-4222-8222-222222222222", root_path: "/high", scan_mode: "mtime_size" },
    });

    const claimed = await service.claimNextJob("worker-1");

    expect(claimed).toMatchObject({
      id: highPriority.id,
      status: "running",
      locked_by: "worker-1",
      attempt: 1,
    });
  });

  test("回收 heartbeat 超时的 running job", async () => {
    const job = await createJob(db, {
      jobType: "scan_library",
      timeoutSeconds: 30,
      inputJson: { library_id: "33333333-3333-4333-8333-333333333333", root_path: "/stale", scan_mode: "mtime_size" },
    });
    await service.claimNextJob("worker-1", new Date("2026-06-01T00:00:00Z"));

    const reclaimed = await service.reclaimStaleJobs(new Date("2026-06-01T00:01:00Z"));
    const requeued = await service.getJob(job.id);

    expect(reclaimed).toBe(1);
    expect(requeued).toMatchObject({
      id: job.id,
      status: "queued",
      locked_by: null,
      heartbeat_at: null,
    });
  });

  test("将 pending image 和 video segment vector_refs 转成 embedding jobs", async () => {
    const library = await createLibrary(db, { name: "Main", rootPath: "/media" });
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/media/cat.jpg",
      relativePath: "cat.jpg",
      mediaType: "image",
      sizeBytes: 10,
      mtimeMs: 1,
    });
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: "image",
      path: "/media/cat.jpg",
      contentHash: "cat-hash",
    });
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/media/clip.mp4",
      relativePath: "clip.mp4",
      mediaType: "video",
      sizeBytes: 20,
      mtimeMs: 2,
    });
    const segmentAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: "video_segment",
      startTimeSeconds: "30",
      endTimeSeconds: "60",
      contentHash: "segment-hash",
    });

    await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId: "11111111-1111-4111-8111-111111111111",
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "image_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "cat-hash",
      indexProfile: "balanced",
    });
    await createVectorRef(db, {
      assetId: segmentAsset.id,
      fileId: videoFile.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId: "22222222-2222-4222-8222-222222222222",
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "representative_frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "segment-hash",
      indexProfile: "balanced",
    });

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 2,
      created: 2,
      skipped: 0,
    });
    const jobs = await service.listJobs();

    expect(jobs.items.map((job) => job.job_type).sort()).toEqual(["embed_image", "embed_video_frame"]);
    expect(jobs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_type: "embed_image",
          input: expect.objectContaining({
            asset_id: imageAsset.id,
            path: "/media/cat.jpg",
            collection: "image_vectors",
            model_name: "google/siglip-base-patch16-224",
            model_version: "siglip-base-patch16-224",
          }),
        }),
        expect.objectContaining({
          job_type: "embed_video_frame",
          input: expect.objectContaining({
            asset_id: segmentAsset.id,
            frame_path: "/media/clip.mp4",
            frame_time_seconds: 45,
            collection: "video_segment_vectors",
            model_name: "google/siglip-base-patch16-224",
            model_version: "siglip-base-patch16-224",
          }),
        }),
      ]),
    );
  });

  test("将未 OCR 的 image 和 video_frame assets 批量转成 run_ocr jobs", async () => {
    const library = await createLibrary(db, { name: "Main", rootPath: "/media" });
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/media/poster.png",
      relativePath: "poster.png",
      mediaType: "image",
      sizeBytes: 10,
      mtimeMs: 1,
    });
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: "image",
      path: "/media/poster.png",
    });
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/media/clip.mp4",
      relativePath: "clip.mp4",
      mediaType: "video",
      sizeBytes: 20,
      mtimeMs: 2,
    });
    const frameAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: "video_frame",
      path: "/media/clip.mp4",
      frameTimeSeconds: "12.5",
    });
    await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: "image",
      path: "/media/already.png",
      textContent: "already indexed",
      metadataJson: { ocr: { engine: "paddleocr" } },
    });
    await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: "video_segment",
      startTimeSeconds: "0",
      endTimeSeconds: "30",
    });

    await expect(service.queuePendingOcrJobs({ libraryId: library.id, batchSize: 20 })).resolves.toEqual({
      scanned: 2,
      created: 1,
      skipped: 0,
    });
    const jobs = await service.listJobs();

    expect(jobs.items).toEqual([
      expect.objectContaining({
        job_type: "run_ocr",
        timeout_seconds: 7200,
        input: {
          asset_ids: [imageAsset.id, frameAsset.id],
          engine: "paddleocr",
          language: "ch",
        },
      }),
    ]);
  });

  test("OCR queue-pending 使用 limit 并从 OCR_BATCH_SIZE 读取默认 batch size", async () => {
    const originalBatchSize = process.env.OCR_BATCH_SIZE;
    process.env.OCR_BATCH_SIZE = "1";
    const library = await createLibrary(db, { name: "Main", rootPath: "/media" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/media/contact-sheet.png",
      relativePath: "contact-sheet.png",
      mediaType: "image",
      sizeBytes: 10,
      mtimeMs: 1,
    });
    const firstAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/media/contact-sheet-1.png",
    });
    const secondAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/media/contact-sheet-2.png",
    });
    await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/media/contact-sheet-3.png",
    });

    try {
      await expect(service.queuePendingOcrJobs({ libraryId: library.id, limit: 2 })).resolves.toEqual({
        scanned: 2,
        created: 2,
        skipped: 0,
      });
      const jobs = await service.listJobs();

      const queuedAssetIds = jobs.items
        .map((job) => (job.input as { asset_ids: string[] }).asset_ids[0])
        .sort();
      expect(queuedAssetIds).toEqual([firstAsset.id, secondAsset.id].sort());
    } finally {
      if (originalBatchSize === undefined) {
        delete process.env.OCR_BATCH_SIZE;
      } else {
        process.env.OCR_BATCH_SIZE = originalBatchSize;
      }
    }
  });
});
