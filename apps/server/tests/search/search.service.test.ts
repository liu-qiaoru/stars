import { BadRequestException, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SETTINGS, type Settings } from "../../src/config/settings.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createLibrary, createMediaAsset, createMediaFile, createVectorRef } from "../../src/database/repositories.js";
import { ModelGatewayService } from "../../src/model-gateway/model-gateway.service.js";
import { QDRANT_CLIENT } from "../../src/qdrant/qdrant.module.js";
import { SearchModule } from "../../src/search/search.module.js";
import { SearchService } from "../../src/search/search.service.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let service: SearchService;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const search = vi.fn();
const embedText = vi.fn();
const testSettings: Settings = {
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
  jobCoordinatorEnabled: true,
  jobCoordinatorIntervalMs: 5000,
  jobCoordinatorEmbeddingLimit: 100,
  jobCoordinatorOcrLimit: 500,
  queryExpansionProvider: "none",
  queryExpansionTimeoutMs: 10000,
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekApiKey: undefined,
  deepseekModel: "deepseek-v4-flash",
};
let currentSettings: Settings = testSettings;

beforeEach(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  closeDb = testDb.close;
  search.mockReset();
  embedText.mockReset();
  embedText.mockResolvedValue(Array.from({ length: 768 }, (_, index) => index / 768));
  currentSettings = testSettings;

  const moduleRef = await Test.createTestingModule({
    imports: [SearchModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(currentSettings)
    .overrideProvider(QDRANT_CLIENT)
    .useValue({ search })
    .overrideProvider(ModelGatewayService)
    .useValue({ embedText })
    .compile();

  service = moduleRef.get(SearchService);
  closeModule = () => moduleRef.close();
});

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
  vi.restoreAllMocks();
});

describe("search service", () => {
  test("按 collection 搜索 image 和 video segment，并回 PostgreSQL 补齐结果", async () => {
    const library = await createLibrary(db, { name: "Main Media", rootPath: "/Volumes/Media" });
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/cat.jpg",
      relativePath: "cat.jpg",
      mediaType: "image",
      sizeBytes: 10,
      mtimeMs: 1710000000000,
    });
    const imageAsset = await createMediaAsset(db, { fileId: imageFile.id, assetType: "image" });
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/clip.mp4",
      relativePath: "clip.mp4",
      mediaType: "video",
      sizeBytes: 20,
      mtimeMs: 1710000000001,
    });
    const videoAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: "video_segment",
      startTimeSeconds: "30",
      endTimeSeconds: "60",
    });
    const imagePointId = "11111111-1111-4111-8111-111111111111";
    const videoPointId = "22222222-2222-4222-8222-222222222222";
    await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId: imagePointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "image_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "image-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    await createVectorRef(db, {
      assetId: videoAsset.id,
      fileId: videoFile.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId: videoPointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "video-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    search.mockImplementation(async (collectionName: string) => {
      if (collectionName === "image_vectors") {
        return [{ id: imagePointId, score: 0.91 }];
      }
      return [{ id: videoPointId, score: 0.82 }];
    });

    const result = await service.search({
      query: "cat by window",
      media_types: ["image", "video"],
      library_ids: [library.id],
      limit: 5,
      offset: 0,
    });

    expect(result).toMatchObject({
      limit: 5,
      offset: 0,
      results: [
        {
          asset_id: imageAsset.id,
          merged_asset_ids: [imageAsset.id],
          file_id: imageFile.id,
          media_type: "image",
          path: "/Volumes/Media/cat.jpg",
          start_time_seconds: null,
          end_time_seconds: null,
          scene_id: null,
          score: 0.91 * 0.55,
          score_kind: "hybrid_score",
          primary_reason: "vector_match",
          reasons: ["vector_match"],
          source_scores: { image_vectors: 0.91 },
        },
        {
          asset_id: videoAsset.id,
          merged_asset_ids: [videoAsset.id],
          file_id: videoFile.id,
          media_type: "video",
          path: "/Volumes/Media/clip.mp4",
          start_time_seconds: 30,
          end_time_seconds: 60,
          scene_id: null,
          score: 0.82 * 0.55,
          score_kind: "hybrid_score",
          primary_reason: "vector_match",
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.82 },
        },
      ],
      groups: [
        {
          collection: "image_vectors",
          score_kind: "cosine_similarity",
          results: [
            {
              asset_id: imageAsset.id,
              file_id: imageFile.id,
              media_type: "image",
              path: "/Volumes/Media/cat.jpg",
              start_time_seconds: null,
              end_time_seconds: null,
              scene_id: null,
              score: 0.91,
              reason: "vector_match",
            },
          ],
        },
        {
          collection: "video_segment_vectors",
          score_kind: "cosine_similarity",
          results: [
            {
              asset_id: videoAsset.id,
              file_id: videoFile.id,
              media_type: "video",
              path: "/Volumes/Media/clip.mp4",
              start_time_seconds: 30,
              end_time_seconds: 60,
              scene_id: null,
              score: 0.82,
              reason: "vector_match",
            },
          ],
        },
        {
          collection: "video_frame_vectors",
          score_kind: "cosine_similarity",
          results: [],
        },
        {
          collection: "text_search",
          score_kind: "ts_rank_cd",
          results: [],
        },
      ],
    });
    expect(search).toHaveBeenCalledWith(
      "image_vectors",
      expect.objectContaining({
        vector: Array.from({ length: 768 }, (_, index) => index / 768),
        limit: 30,
        offset: 0,
        with_payload: false,
        with_vector: false,
        filter: {
          must: [{ key: "library_id", match: { any: [library.id] } }],
        },
      }),
    );
    expect(embedText).toHaveBeenCalledWith("cat by window", 768);
  });

  test("空结果返回稳定分页结构", async () => {
    search.mockResolvedValue([]);

    await expect(service.search({ query: "nothing", media_types: ["image"], limit: 10, offset: 0 })).resolves.toEqual({
      limit: 10,
      offset: 0,
      results: [],
      groups: [
        {
          collection: "image_vectors",
          score_kind: "cosine_similarity",
          results: [],
        },
        {
          collection: "text_search",
          score_kind: "ts_rank_cd",
          results: [],
        },
      ],
    });
  });

  test("校验失败时抛出 BadRequestException", async () => {
    await expect(service.search({ query: "", limit: 10 })).rejects.toThrow(BadRequestException);
    await expect(service.search({ query: "test", limit: 0 })).rejects.toThrow(BadRequestException);
    await expect(service.search({ query: "test", limit: 101 })).rejects.toThrow(BadRequestException);
    await expect(service.search({ query: "test", library_ids: ["not-a-uuid"] })).rejects.toThrow(BadRequestException);
  });

  test("不支持向量或文本检索的 media_types 返回空 groups", async () => {
    const result = await service.search({ query: "test", media_types: ["document"], limit: 10 });

    expect(result).toEqual({
      limit: 10,
      offset: 0,
      results: [],
      groups: [],
    });
    expect(search).not.toHaveBeenCalled();
  });

  test("does not expand user queries with an internal dictionary", async () => {
    const library = await createLibrary(db, { name: "Scenes", rootPath: "/video" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/video/query-match.mp4",
      relativePath: "query-match.mp4",
      mediaType: "video",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "10",
      endTimeSeconds: "20",
    });
    const pointId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "query-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    const query = "用户输入的原始短语";
    embedText.mockResolvedValue([1, ...Array.from({ length: 767 }, () => 0)]);
    search.mockImplementation(async (collectionName: string) => {
      if (collectionName === "video_segment_vectors") {
        return [{ id: pointId, score: 0.72 }];
      }
      return [];
    });
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

    const result = await service.search({ query, media_types: ["video"], limit: 10 });

    expect(embedText).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledWith(query, 768);
    expect(logSpy).toHaveBeenCalledWith('provider=none api_key=unset query_expansion=disabled');
    expect(result.results).toEqual([
      expect.objectContaining({
        asset_id: asset.id,
        source_scores: { video_segment_vectors: 0.72 },
      }),
    ]);
  });

  test("expands vector queries through configured DeepSeek provider without hardcoded aliases", async () => {
    currentSettings = {
      ...testSettings,
      queryExpansionProvider: "deepseek",
      deepseekApiKey: "test-key",
    };
    await closeModule();
    const moduleRef = await Test.createTestingModule({
      imports: [SearchModule],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(PG_POOL)
      .useValue(null)
      .overrideProvider(SETTINGS)
      .useValue(currentSettings)
      .overrideProvider(QDRANT_CLIENT)
      .useValue({ search })
      .overrideProvider(ModelGatewayService)
      .useValue({ embedText })
      .compile();
    service = moduleRef.get(SearchService);
    closeModule = () => moduleRef.close();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  variants: [
                    { text: "架子鼓", weight: 1 },
                    { text: "drum kit", weight: 0.9 },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const library = await createLibrary(db, { name: "Stage", rootPath: "/stage" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/stage/drums.mp4",
      relativePath: "drums.mp4",
      mediaType: "video",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "0",
      endTimeSeconds: "10",
    });
    const pointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "drums-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    embedText.mockImplementation(async (text: string) => {
      if (text === "drum kit") {
        return [2, ...Array.from({ length: 767 }, () => 0)];
      }
      return [1, ...Array.from({ length: 767 }, () => 0)];
    });
    search.mockImplementation(async (collectionName: string, request: { vector?: number[] }) => {
      if (collectionName === "video_segment_vectors" && request.vector?.[0] === 2) {
        return [{ id: pointId, score: 0.8 }];
      }
      return [];
    });
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

    const result = await service.search({ query: "架子鼓", media_types: ["video"], limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
      }),
    );
    expect(embedText).toHaveBeenCalledWith("架子鼓", 768);
    expect(embedText).toHaveBeenCalledWith("drum kit", 768);
    expect(result.results[0]).toMatchObject({ asset_id: asset.id });
    expect(result.results[0]?.source_scores.video_segment_vectors).toBeCloseTo(0.72, 5);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('provider=deepseek variants="架子鼓"@1.00 original, "drum kit"@0.90 deepseek'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'collection=video_segment_vectors variant="drum kit" source=deepseek weight=0.90 raw_hits=1 top_raw_score=0.8 top_weighted_score=0.7200000000000001',
      ),
    );

    fetchMock.mockRestore();
  });

  test("searches video frame vectors and merges frame hits with nearby segments", async () => {
    const library = await createLibrary(db, { name: "Video", rootPath: "/video" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/video/scene.mp4",
      relativePath: "scene.mp4",
      mediaType: "video",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const segmentAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "10",
      endTimeSeconds: "20",
    });
    const frameAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_frame",
      frameTimeSeconds: "12",
    });
    const segmentPointId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const framePointId = "99999999-9999-4999-8999-999999999999";
    await createVectorRef(db, {
      assetId: segmentAsset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_segment_vectors",
      pointId: segmentPointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "representative_frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "segment-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    await createVectorRef(db, {
      assetId: frameAsset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "video_frame_vectors",
      pointId: framePointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "frame_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "frame-hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    search.mockImplementation(async (collectionName: string) => {
      if (collectionName === "video_segment_vectors") {
        return [{ id: segmentPointId, score: 0.58 }];
      }
      if (collectionName === "video_frame_vectors") {
        return [{ id: framePointId, score: 0.81 }];
      }
      return [];
    });

    const result = await service.search({ query: "beach", media_types: ["video"], limit: 10 });

    expect(search).toHaveBeenCalledWith("video_frame_vectors", expect.any(Object));
    expect(result.groups.map((group) => group.collection)).toEqual([
      "video_segment_vectors",
      "video_frame_vectors",
      "text_search",
    ]);
    expect(result.results).toEqual([
      expect.objectContaining({
        asset_id: frameAsset.id,
        merged_asset_ids: [segmentAsset.id, frameAsset.id],
        start_time_seconds: 10,
        end_time_seconds: 20,
        source_scores: {
          video_segment_vectors: 0.58,
          video_frame_vectors: 0.81,
        },
      }),
    ]);
  });

  test("audio-only search returns transcript matches from PostgreSQL FTS", async () => {
    const library = await createLibrary(db, { name: "Interviews", rootPath: "/audio" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/audio/interview.mp3",
      relativePath: "interview.mp3",
      mediaType: "audio",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "text_chunk",
      startTimeSeconds: "30",
      endTimeSeconds: "55",
    });
    await db.execute(sql`
      UPDATE media_assets
      SET text_content = 'the guest describes a red bicycle near the station'
      WHERE id = ${asset.id}
    `);

    const result = await service.search({
      query: "bicycle",
      media_types: ["audio"],
      library_ids: [library.id],
      limit: 10,
    });

    expect(result).toEqual({
      limit: 10,
      offset: 0,
      results: [
        {
          asset_id: asset.id,
          merged_asset_ids: [asset.id],
          file_id: file.id,
          media_type: "audio",
          path: "/audio/interview.mp3",
          start_time_seconds: 30,
          end_time_seconds: 55,
          scene_id: null,
          score: expect.any(Number),
          score_kind: "hybrid_score",
          primary_reason: "transcript_match",
          confidence: "high",
          reasons: ["transcript_match"],
          source_scores: { text_search: expect.any(Number) },
        },
      ],
      groups: [
        {
          collection: "text_search",
          score_kind: "ts_rank_cd",
          results: [
            {
              asset_id: asset.id,
              file_id: file.id,
              media_type: "audio",
              path: "/audio/interview.mp3",
              start_time_seconds: 30,
              end_time_seconds: 55,
              scene_id: null,
              score: expect.any(Number),
              reason: "transcript_match",
            },
          ],
        },
      ],
    });
    expect(search).not.toHaveBeenCalled();
  });

  test("image OCR text search returns ocr_match reason", async () => {
    const library = await createLibrary(db, { name: "Posters", rootPath: "/posters" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/posters/local-media.png",
      relativePath: "local-media.png",
      mediaType: "image",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/posters/local-media.png",
      textContent: "local media archive poster",
      metadataJson: { ocr: { engine: "paddleocr", language: "ch", block_count: 1 } },
    });
    search.mockResolvedValue([]);

    const result = await service.search({
      query: "archive",
      media_types: ["image"],
      library_ids: [library.id],
      limit: 10,
    });

    expect(result.groups).toEqual([
      {
        collection: "image_vectors",
        score_kind: "cosine_similarity",
        results: [],
      },
      {
        collection: "text_search",
        score_kind: "ts_rank_cd",
        results: [
          {
            asset_id: asset.id,
            file_id: file.id,
            media_type: "image",
            path: "/posters/local-media.png",
            start_time_seconds: null,
            end_time_seconds: null,
            scene_id: null,
            score: expect.any(Number),
            reason: "ocr_match",
          },
        ],
      },
    ]);
    expect(result.results).toEqual([
      {
        asset_id: asset.id,
        merged_asset_ids: [asset.id],
        file_id: file.id,
        media_type: "image",
        path: "/posters/local-media.png",
        start_time_seconds: null,
        end_time_seconds: null,
        scene_id: null,
        score: expect.any(Number),
        score_kind: "hybrid_score",
        primary_reason: "ocr_match",
        confidence: "high",
        reasons: ["ocr_match"],
        source_scores: { text_search: expect.any(Number) },
      },
    ]);
  });

  test("same asset vector and OCR matches merge into one hybrid result", async () => {
    const library = await createLibrary(db, { name: "Posters", rootPath: "/posters" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/posters/keynote.png",
      relativePath: "keynote.png",
      mediaType: "image",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/posters/keynote.png",
      textContent: "keynote schedule poster",
      metadataJson: { ocr: { engine: "paddleocr", language: "ch", block_count: 1 } },
    });
    const pointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "image_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    search.mockResolvedValue([{ id: pointId, score: 0.76 }]);

    const result = await service.search({
      query: "keynote",
      media_types: ["image"],
      library_ids: [library.id],
      limit: 10,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        asset_id: asset.id,
        merged_asset_ids: [asset.id],
        reasons: ["vector_match", "ocr_match"],
        source_scores: {
          image_vectors: 0.76,
          text_search: expect.any(Number),
        },
      }),
    ]);
    expect(result.groups[1].results[0]).toMatchObject({
      asset_id: asset.id,
      reason: "ocr_match",
    });
  });

  test("Qdrant 返回的 point 在 PostgreSQL 中不存在时被静默跳过", async () => {
    const library = await createLibrary(db, { name: "Test", rootPath: "/test" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/test/img.jpg",
      relativePath: "img.jpg",
      mediaType: "image",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, { fileId: file.id, assetType: "image" });
    const validPointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const orphanPointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId: validPointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "image_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    // Qdrant 返回 2 个 point，但只有 validPointId 在 PostgreSQL 中有记录
    search.mockResolvedValue([
      { id: validPointId, score: 0.9 },
      { id: orphanPointId, score: 0.8 },
    ]);

    const result = await service.search({ query: "test", media_types: ["image"], limit: 10 });

    expect(result.results).toEqual([
      expect.objectContaining({
        asset_id: asset.id,
        source_scores: { image_vectors: 0.9 },
      }),
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].results).toEqual([
      expect.objectContaining({ asset_id: asset.id, score: 0.9 }),
    ]);
    expect(result.groups[1]).toEqual({
      collection: "text_search",
      score_kind: "ts_rank_cd",
      results: [],
    });
  });

  test("soft-deleted media is filtered from vector, FTS, and hybrid results", async () => {
    const library = await createLibrary(db, { name: "Deleted", rootPath: "/deleted" });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/deleted/poster.png",
      relativePath: "poster.png",
      mediaType: "image",
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "image",
      path: "/deleted/poster.png",
      textContent: "deleted archive poster",
    });
    const pointId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: "image_vectors",
      pointId,
      modelName: "mock",
      modelVersion: "phase5",
      vectorKind: "image_embedding",
      vectorDim: 512,
      distance: "Cosine",
      contentHash: "hash",
      indexProfile: "balanced",
      status: "indexed",
    });
    await db.execute(sql`
      UPDATE media_files
      SET deleted_at = NOW()
      WHERE id = ${file.id}
    `);
    search.mockResolvedValue([{ id: pointId, score: 0.9 }]);

    const result = await service.search({
      query: "archive",
      media_types: ["image"],
      library_ids: [library.id],
      limit: 10,
    });

    expect(result.results).toEqual([]);
    expect(result.groups).toEqual([
      {
        collection: "image_vectors",
        score_kind: "cosine_similarity",
        results: [],
      },
      {
        collection: "text_search",
        score_kind: "ts_rank_cd",
        results: [],
      },
    ]);
  });
});
