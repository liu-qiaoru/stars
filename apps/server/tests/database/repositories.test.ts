import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as schema from "../../src/database/schema.js";
import {
  createJob,
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
  getFileWithAssetsAndVectors,
  resetVectorRefsForCollection,
} from "../../src/database/repositories.js";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  const migrationDir = resolve("drizzle");
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await client.exec(await readFile(resolve(migrationDir, file), "utf8"));
  }
});

afterEach(async () => {
  await client.close();
});

describe("database repositories", () => {
  test("migration 后可以创建并查询 library、file、asset、vector ref 和 job", async () => {
    const library = await createLibrary(db, {
      name: "Main Library",
      rootPath: "/Volumes/Media",
    });

    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/video.mp4",
      relativePath: "video.mp4",
      mediaType: "video",
      sizeBytes: 123456,
      mtimeMs: 1710000000000,
    });

    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "0",
      endTimeSeconds: "30",
      contentHash: "segment-hash",
    });

    const vectorRef = await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId: randomUUID(),
      modelName: "mock",
      modelVersion: "v1",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "segment-hash",
      indexProfile: "balanced",
    });

    const job = await createJob(db, {
      jobType: "index_media",
      inputJson: {
        file_id: file.id,
        index_profile: "balanced",
        segment_strategy: "fixed_30s",
      },
    });

    const graph = await getFileWithAssetsAndVectors(db, file.id);

    expect(graph).toMatchObject({
      file: { id: file.id, libraryId: library.id },
      assets: [{ id: asset.id, fileId: file.id }],
      vectorRefs: [{ id: vectorRef.id, assetId: asset.id, fileId: file.id }],
    });
    expect(job).toMatchObject({
      jobType: "index_media",
      status: "queued",
      attempt: 0,
      inputJson: {
        file_id: file.id,
        index_profile: "balanced",
        segment_strategy: "fixed_30s",
      },
    });
  });

  test("collection 重建后将旧 vector_refs 升级到当前模型并重置为 pending", async () => {
    const library = await createLibrary(db, {
      name: "Main Library",
      rootPath: "/Volumes/Media",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/video.mp4",
      relativePath: "video.mp4",
      mediaType: "video",
      sizeBytes: 123456,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "0",
      endTimeSeconds: "30",
      contentHash: "segment-hash",
    });
    const oldPointId = "11111111-1111-4111-8111-111111111111";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId: oldPointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "segment-hash",
      indexProfile: "balanced",
    });

    const updated = await resetVectorRefsForCollection(db, {
      collectionName: "video_segment_vectors",
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "representative_frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
    });
    const graph = await getFileWithAssetsAndVectors(db, file.id);

    expect(updated).toBe(1);
    expect(graph?.vectorRefs[0]).toMatchObject({
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorDim: 768,
      status: "pending",
    });
    expect(graph?.vectorRefs[0].pointId).not.toBe(oldPointId);
  });
});
