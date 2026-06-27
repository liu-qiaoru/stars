import { describe, expect, test, vi } from "vitest";
import { QdrantCollectionsService } from "../../src/qdrant/qdrant-collections.service.js";
import { VECTOR_COLLECTIONS } from "../../src/qdrant/vector-collections.js";

describe("vector collection registry", () => {
  test("定义 Phase 10 SigLIP Qdrant collections", () => {
    expect(Object.keys(VECTOR_COLLECTIONS).sort()).toEqual([
      "audio_segment_vectors",
      "image_vectors",
      "text_chunk_vectors",
      "video_frame_vectors",
      "video_segment_vectors",
    ]);
    expect(VECTOR_COLLECTIONS.video_segment_vectors).toMatchObject({
      modality: "video",
      vectorKind: "representative_frame_embedding",
      modelName: "google/siglip-base-patch16-224",
      modelVersion: "siglip-base-patch16-224",
      vectorDim: 768,
      distance: "Cosine",
    });
    expect(VECTOR_COLLECTIONS.text_chunk_vectors).toMatchObject({
      modelName: "sentence-transformers",
      modelVersion: "all-MiniLM-L6-v2",
      vectorDim: 384,
    });
  });

  test("初始化缺失的 Qdrant collections", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/collections/image_vectors") && init?.method === "GET") {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/collections/video_segment_vectors") && init?.method === "GET") {
        return new Response("exists", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
      video_segment_vectors: VECTOR_COLLECTIONS.video_segment_vectors,
    });

    const result = await service.ensureCollections();

    expect(result).toEqual({ created: ["image_vectors"], existing: ["video_segment_vectors"] });
    expect(fetcher).toHaveBeenCalledWith("http://qdrant.local/collections/image_vectors", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: 768,
          distance: "Cosine",
        },
      }),
    });
  });

  test("为所有 collection 创建 library_id 和 media_type payload keyword indexes", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
      video_segment_vectors: VECTOR_COLLECTIONS.video_segment_vectors,
    });

    await service.ensureCollections();

    // 每个 collection 应创建 2 个 payload index: library_id + media_type
    for (const collection of ["image_vectors", "video_segment_vectors"]) {
      expect(fetcher).toHaveBeenCalledWith(`http://qdrant.local/collections/${collection}/index`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field_name: "library_id", field_schema: "keyword" }),
      });
      expect(fetcher).toHaveBeenCalledWith(`http://qdrant.local/collections/${collection}/index`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field_name: "media_type", field_schema: "keyword" }),
      });
    }
  });

  test("发现旧维度 collection 时删除并重建", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/collections/image_vectors") && init?.method === "GET") {
        return Response.json({
          result: {
            config: {
              params: {
                vectors: {
                  size: 512,
                  distance: "Cosine",
                },
              },
            },
          },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const resetVectorRefs = vi.fn(async (_collectionName: string) => {});
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
    }, resetVectorRefs);

    const result = await service.ensureCollections();

    expect(result).toEqual({ created: [], existing: [], recreated: ["image_vectors"] });
    expect(resetVectorRefs).toHaveBeenCalledWith("image_vectors", VECTOR_COLLECTIONS.image_vectors);
    expect(fetcher).toHaveBeenCalledWith("http://qdrant.local/collections/image_vectors", {
      method: "DELETE",
    });
    expect(fetcher).toHaveBeenCalledWith("http://qdrant.local/collections/image_vectors", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: 768,
          distance: "Cosine",
        },
      }),
    });
  });

  test("启动生命周期会初始化 collections，失败时不阻断 Nest 启动", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("qdrant unavailable");
    });
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
    });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
