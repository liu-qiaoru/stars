import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "../../src/config/settings.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createLibrary, createMediaAsset, createMediaFile } from "../../src/database/repositories.js";
import { MediaController } from "../../src/media/media.controller.js";
import { MediaModule } from "../../src/media/media.module.js";
import { MediaService } from "../../src/media/media.service.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let mediaController: MediaController;
let mediaService: MediaService;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const testSettings = {
  serverHost: "127.0.0.1",
  serverPort: 4000,
  databaseUrl: "postgres://user:pass@localhost:5432/media_agent_test",
  qdrantUrl: "http://localhost:6333",
};

beforeEach(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  closeDb = testDb.close;

  const moduleRef = await Test.createTestingModule({
    imports: [MediaModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile();

  mediaController = moduleRef.get(MediaController);
  mediaService = moduleRef.get(MediaService);
  closeModule = () => moduleRef.close();
});

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
});

describe("media API", () => {
  test("detail endpoint 返回媒体 metadata 和片段 assets", async () => {
    const library = await createLibrary(db, {
      name: "Main Media",
      rootPath: "/Volumes/Media",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/video.mp4",
      relativePath: "video.mp4",
      mediaType: "video",
      sizeBytes: 123456,
      mtimeMs: 1710000000000,
      durationSeconds: "180",
      width: 1920,
      height: 1080,
      codec: "h264",
    });
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: "video_segment",
      startTimeSeconds: "30",
      endTimeSeconds: "60",
      contentHash: "segment-hash",
    });

    await expect(mediaController.getMedia(file.id)).resolves.toMatchObject({
      id: file.id,
      library_id: library.id,
      path: "/Volumes/Media/video.mp4",
      media_type: "video",
      size_bytes: 123456,
      duration_seconds: 180,
      width: 1920,
      height: 1080,
      codec: "h264",
      index_status: "pending",
      assets_limit: 50,
      assets_offset: 0,
      assets_total: 1,
      assets: [
        {
          id: asset.id,
          asset_type: "video_segment",
          start_time_seconds: 30,
          end_time_seconds: 60,
          cache_path: null,
          text_content: null,
        },
      ],
    });
  });

  test("content endpoint metadata resolves a DB-backed local media file", async () => {
    const library = await createLibrary(db, {
      name: "Main Media",
      rootPath: "/Volumes/Media",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/poster.jpg",
      relativePath: "poster.jpg",
      mediaType: "image",
      sizeBytes: 1234,
      mtimeMs: 1710000000000,
    });

    await expect(mediaService.getMediaContent(file.id)).resolves.toEqual({
      path: "/Volumes/Media/poster.jpg",
      media_type: "image",
      content_type: "image/jpeg",
    });
  });
});
