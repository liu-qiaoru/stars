import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "../../src/config/settings.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createMediaFile } from "../../src/database/repositories.js";
import { JobsController } from "../../src/jobs/jobs.controller.js";
import { JobsModule } from "../../src/jobs/jobs.module.js";
import { LibrariesController } from "../../src/libraries/libraries.controller.js";
import { LibrariesModule } from "../../src/libraries/libraries.module.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let librariesController: LibrariesController;
let jobsController: JobsController;
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
  const { close } = testDb;
  closeDb = close;

  const moduleRef = await Test.createTestingModule({
    imports: [JobsModule, LibrariesModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile();

  librariesController = moduleRef.get(LibrariesController);
  jobsController = moduleRef.get(JobsController);
  closeModule = () => moduleRef.close();
});

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
});

describe("libraries API", () => {
  test("创建、列表、详情、禁用和删除 library", async () => {
    const created = await librariesController.createLibrary({
      name: "Main Media",
      root_path: "/Volumes/Media",
    });

    expect(created).toMatchObject({
      id: expect.any(String),
      name: "Main Media",
      root_path: "/Volumes/Media",
      enabled: true,
    });

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [
        {
          id: created.id,
          name: "Main Media",
          root_path: "/Volumes/Media",
          enabled: true,
          media_count: 0,
          indexed_count: 0,
          failed_count: 0,
        },
      ],
    });

    await expect(librariesController.getLibrary(created.id)).resolves.toMatchObject({
      id: created.id,
      root_path: "/Volumes/Media",
      enabled: true,
    });

    await expect(librariesController.disableLibrary(created.id)).resolves.toMatchObject({
      id: created.id,
      enabled: false,
    });

    await expect(librariesController.deleteLibrary(created.id)).resolves.toEqual({
      deleted: true,
    });

    await expect(librariesController.listLibraries()).resolves.toEqual({ items: [] });
  });

  test("scan endpoint 为 library 创建 queued scan_library job", async () => {
    const library = await librariesController.createLibrary({
      name: "Main Media",
      root_path: "/Volumes/Media",
    });

    const scan = await librariesController.scanLibrary(library.id);

    expect(scan).toMatchObject({
      job_id: expect.any(String),
      status: "queued",
    });
    await expect(jobsController.getJob(scan.job_id)).resolves.toMatchObject({
      id: scan.job_id,
      job_type: "scan_library",
      status: "queued",
      input: {
        library_id: library.id,
        root_path: "/Volumes/Media",
        scan_mode: "mtime_size",
      },
    });
  });

  test("list endpoint 返回 media 计数", async () => {
    const library = await librariesController.createLibrary({
      name: "Main Media",
      root_path: "/Volumes/Media",
    });
    await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/video.mp4",
      relativePath: "video.mp4",
      mediaType: "video",
      sizeBytes: 10,
      mtimeMs: 1710000000000,
    });

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [
        {
          id: library.id,
          media_count: 1,
          indexed_count: 0,
          failed_count: 0,
        },
      ],
    });
  });
});
