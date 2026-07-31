import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
  hasVectorRefConfigMismatch,
  listPendingEmbeddingVectorRefs,
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
    const sceneId = randomUUID();
    await db.insert(schema.videoScenes).values({
      id: sceneId,
      fileId: file.id,
      sceneKey: "scene-000001",
      startTimeSeconds: "0",
      endTimeSeconds: "30",
      detectionStrategy: "content",
      strategyFingerprint: "content-v1",
      indexGeneration: 0,
    });

    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_frame",
      sceneId,
      frameTimeSeconds: "15",
      contentHash: "frame-hash",
    });

    const vectorRef = await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_frame_vectors",
      pointId: randomUUID(),
      modelName: "google/siglip2-base-patch16-224",
      modelVersion: "siglip2-base-patch16-224",
      vectorKind: "frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "frame-hash",
      indexProfile: "balanced",
    });

    const job = await createJob(db, {
      jobType: "index_media",
      inputJson: {
        file_id: file.id,
        index_profile: "balanced",
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
    const sceneId = randomUUID();
    await db.insert(schema.videoScenes).values({
      id: sceneId,
      fileId: file.id,
      sceneKey: "scene-000001",
      startTimeSeconds: "0",
      endTimeSeconds: "30",
      detectionStrategy: "content",
      strategyFingerprint: "content-v1",
      indexGeneration: 0,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_frame",
      sceneId,
      frameTimeSeconds: "15",
      contentHash: "frame-hash",
    });
    const oldPointId = "11111111-1111-4111-8111-111111111111";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_frame_vectors",
      pointId: oldPointId,
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "frame-hash",
      indexProfile: "balanced",
    });

    const updated = await resetVectorRefsForCollection(db, {
      collectionName: "video_frame_vectors",
      modelName: "google/siglip2-base-patch16-224",
      modelVersion: "siglip2-base-patch16-224",
      vectorKind: "frame_embedding",
      vectorDim: 768,
      distance: "Cosine",
    });
    const graph = await getFileWithAssetsAndVectors(db, file.id);

    expect(updated).toBe(1);
    expect(graph?.vectorRefs[0]).toMatchObject({
      modelName: "google/siglip2-base-patch16-224",
      modelVersion: "siglip2-base-patch16-224",
      vectorDim: 768,
      status: "pending",
    });
    expect(graph?.vectorRefs[0].pointId).not.toBe(oldPointId);
  });

  test("向量维度相同但模型版本过期时报告 collection 配置漂移", async () => {
    const library = await createLibrary(db, {
      name: "Main Library",
      rootPath: "/Volumes/Media",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/image.jpg",
      relativePath: "image.jpg",
      mediaType: "image",
      sizeBytes: 1234,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: file.path,
      contentHash: "image-hash",
    });
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId: randomUUID(),
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorKind: "image_embedding",
      vectorDim: 768,
      distance: "Cosine",
      contentHash: "image-hash",
      indexProfile: "balanced",
    });

    await expect(
      hasVectorRefConfigMismatch(db, {
        collectionName: "image_vectors",
        modelName: "google/siglip2-base-patch16-224",
        modelVersion: "siglip2-base-patch16-224",
        vectorKind: "image_embedding",
        vectorDim: 768,
        distance: "Cosine",
      }),
    ).resolves.toBe(true);
  });

  test("pending refs 使用稳定游标，不会因前页并发变为 indexed 而漏掉后页", async () => {
    const library = await createLibrary(db, {
      name: "Cursor",
      rootPath: "/Volumes/Cursor",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Cursor/image.jpg",
      relativePath: "image.jpg",
      mediaType: "image",
      sizeBytes: 1234,
      mtimeMs: 1710000000000,
    });
    for (const [suffix, pointId] of [
      ["a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ] as const) {
      const asset = await createMediaAsset(db, {
        fileId: file.id,
        assetType: "image",
        path: `/Volumes/Cursor/image-${suffix}.jpg`,
        contentHash: `image-${suffix}`,
      });
      await createVectorRef(db, {
        assetId: asset.id,
        fileId: file.id,
        libraryId: library.id,
        collectionName: "image_vectors",
        pointId,
        modelName: "google/siglip2-base-patch16-224",
        modelVersion: "siglip2-base-patch16-224",
        vectorKind: "image_embedding",
        vectorDim: 768,
        distance: "Cosine",
        contentHash: `image-${suffix}`,
        indexProfile: "balanced",
      });
    }
    // PostgreSQL 的 timestamptz 保留微秒，但 JavaScript Date 只能保留毫秒。这里故意使用
    // .000500：如果 Repository 把游标读成 Date，它会退化为 .000000，第二页将重复第一条，
    // 协调器也就可能一直扫描同一页。两个 ref 使用相同时间，同时覆盖 UUID 次排序。
    await client.exec(
      "UPDATE vector_refs SET created_at = '2026-07-30 00:00:00.000500+00'",
    );

    const firstPage = await listPendingEmbeddingVectorRefs(db, 1);
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]!.vectorRefCreatedAtCursor).toContain(".0005");

    const secondPage = await listPendingEmbeddingVectorRefs(db, 1, {
      createdAtCursor: firstPage[0]!.vectorRefCreatedAtCursor,
      id: firstPage[0]!.vectorRefId,
    });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]!.vectorRefId).not.toBe(firstPage[0]!.vectorRefId);
  });
});
