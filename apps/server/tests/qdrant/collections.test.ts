import { describe, expect, test, vi } from "vitest";
import { QdrantCollectionsService } from "../../src/qdrant/qdrant-collections.service.js";
import { VECTOR_COLLECTIONS } from "../../src/qdrant/vector-collections.js";

describe("vector collection registry", () => {
  test("定义 Phase 4 的 SigLIP2/Caption Qdrant collections", () => {
    // 阶段 2 删除 OCR/segment 后只保留三个向量集合。
    expect(Object.keys(VECTOR_COLLECTIONS).sort()).toEqual([
      "caption_text_vectors",
      "image_vectors",
      "video_frame_vectors",
    ]);
    expect(VECTOR_COLLECTIONS.video_frame_vectors).toMatchObject({
      modality: "video",
      vectorKind: "frame_embedding",
      modelName: "google/siglip2-base-patch16-224",
      modelVersion: "siglip2-base-patch16-224",
      vectorDim: 768,
      distance: "Cosine",
    });
    expect(VECTOR_COLLECTIONS.image_vectors).toMatchObject({
      modality: "image",
      vectorKind: "image_embedding",
      vectorDim: 768,
    });
    expect(VECTOR_COLLECTIONS.caption_text_vectors).toMatchObject({
      modelName: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
      modelVersion: "paraphrase-multilingual-MiniLM-L12-v2",
      vectorKind: "vlm_caption_text_embedding",
      vectorDim: 384,
    });
  });

  test("初始化缺失的 Qdrant collections", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/collections/image_vectors") && init?.method === "GET") {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/collections/video_frame_vectors") && init?.method === "GET") {
        return new Response("exists", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
      video_frame_vectors: VECTOR_COLLECTIONS.video_frame_vectors,
    });

    const result = await service.ensureCollections();

    expect(result).toEqual({ created: ["image_vectors"], existing: ["video_frame_vectors"] });
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

  test("重建缺失 collection 时把数据库引用重置为 pending", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/collections/image_vectors") && init?.method === "GET") {
        return new Response("missing", { status: 404 });
      }
      return new Response("ok", { status: 200 });
    });
    const resetVectorRefs = vi.fn(async (_collectionName: string) => {});
    const service = new QdrantCollectionsService(
      "http://qdrant.local",
      fetcher,
      { image_vectors: VECTOR_COLLECTIONS.image_vectors },
      resetVectorRefs,
    );

    await expect(service.ensureCollections()).resolves.toEqual({
      created: ["image_vectors"],
      existing: [],
    });
    expect(resetVectorRefs).toHaveBeenCalledWith(
      "image_vectors",
      VECTOR_COLLECTIONS.image_vectors,
    );
  });

  test("Qdrant 临时错误不会被误判为 collection 缺失并触发全量重建", async () => {
    const fetcher = vi.fn(async () => new Response("temporary failure", { status: 500 }));
    const resetVectorRefs = vi.fn(async (_collectionName: string) => {});
    const service = new QdrantCollectionsService(
      "http://qdrant.local",
      fetcher,
      { image_vectors: VECTOR_COLLECTIONS.image_vectors },
      resetVectorRefs,
    );

    // 只有明确的 HTTP 404 才表示 Collection 不存在。500、401 或 429 都可能是临时故障，
    // 此时重置约 1 TB 素材的引用会造成无谓的全量重新向量化。
    await expect(service.ensureCollections()).rejects.toThrow(
      "Failed to inspect Qdrant collection image_vectors: HTTP 500",
    );
    expect(resetVectorRefs).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalledWith(
      "http://qdrant.local/collections/image_vectors",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("为所有 collection 创建 library_id 和 media_type payload keyword indexes", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });
    const service = new QdrantCollectionsService("http://qdrant.local", fetcher, {
      image_vectors: VECTOR_COLLECTIONS.image_vectors,
      video_frame_vectors: VECTOR_COLLECTIONS.video_frame_vectors,
    });

    await service.ensureCollections();

    // 每个 collection 应创建 2 个 payload index: library_id + media_type
    for (const collection of ["image_vectors", "video_frame_vectors"]) {
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

  test("模型版本变化但维度相同时仍删除并重建 collection", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/collections/image_vectors") && init?.method === "GET") {
        return Response.json({
          result: {
            config: {
              params: {
                vectors: {
                  size: 768,
                  distance: "Cosine",
                },
              },
            },
          },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const hasConfigMismatch = vi.fn(async () => true);
    const resetVectorRefs = vi.fn(async (_collectionName: string) => {});
    const service = new QdrantCollectionsService(
      "http://qdrant.local",
      fetcher,
      { image_vectors: VECTOR_COLLECTIONS.image_vectors },
      resetVectorRefs,
      hasConfigMismatch,
    );

    await expect(service.ensureCollections()).resolves.toEqual({
      created: [],
      existing: [],
      recreated: ["image_vectors"],
    });
    expect(hasConfigMismatch).toHaveBeenCalledWith(
      "image_vectors",
      VECTOR_COLLECTIONS.image_vectors,
    );
    expect(resetVectorRefs).toHaveBeenCalledWith(
      "image_vectors",
      VECTOR_COLLECTIONS.image_vectors,
    );
  });

  test("数据库引用重置失败时不删除仍可用的 Qdrant collection", async () => {
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
    const resetVectorRefs = vi.fn(async () => {
      throw new Error("postgres unavailable");
    });
    const service = new QdrantCollectionsService(
      "http://qdrant.local",
      fetcher,
      { image_vectors: VECTOR_COLLECTIONS.image_vectors },
      resetVectorRefs,
    );

    await expect(service.ensureCollections()).rejects.toThrow("postgres unavailable");
    expect(fetcher).not.toHaveBeenCalledWith(
      "http://qdrant.local/collections/image_vectors",
      { method: "DELETE" },
    );
  });

  test("删除旧 collection 失败时不继续创建同名 collection", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return Response.json({
          result: { config: { params: { vectors: { size: 512 } } } },
        });
      }
      if (init?.method === "DELETE") {
        return new Response("delete failed", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    });
    const resetVectorRefs = vi.fn(async (_collectionName: string) => {});
    const service = new QdrantCollectionsService(
      "http://qdrant.local",
      fetcher,
      { image_vectors: VECTOR_COLLECTIONS.image_vectors },
      resetVectorRefs,
    );

    // PostgreSQL 引用已经安全地回到 pending，但 Qdrant 删除失败必须如实暴露；
    // 若继续 PUT，会掩盖真正故障，并让运维人员误以为重建已经完成。
    await expect(service.ensureCollections()).rejects.toThrow(
      "Failed to delete Qdrant collection image_vectors: HTTP 503",
    );
    expect(fetcher).not.toHaveBeenCalledWith(
      "http://qdrant.local/collections/image_vectors",
      expect.objectContaining({ method: "PUT" }),
    );
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
