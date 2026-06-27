import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "../../src/config/settings.js";
import { ClipsController } from "../../src/clips/clips.controller.js";
import { ClipsModule } from "../../src/clips/clips.module.js";
import { DATABASE, PG_POOL } from "../../src/database/database.module.js";
import { createLibrary, createMediaFile } from "../../src/database/repositories.js";
import { JobsController } from "../../src/jobs/jobs.controller.js";
import { JobsModule } from "../../src/jobs/jobs.module.js";
import { createTestDatabase } from "../database/test-db.js";

let closeDb: () => Promise<void>;
let closeModule: () => Promise<void>;
let clipsController: ClipsController;
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
  closeDb = testDb.close;

  const moduleRef = await Test.createTestingModule({
    imports: [ClipsModule, JobsModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile();

  clipsController = moduleRef.get(ClipsController);
  jobsController = moduleRef.get(JobsController);
  closeModule = () => moduleRef.close();
});

afterEach(async () => {
  await closeModule?.();
  await closeDb?.();
});

describe("clips API", () => {
  test("export endpoint 为媒体片段创建 queued export_clip job", async () => {
    const library = await createLibrary(db, {
      name: "Main Media",
      rootPath: "/Volumes/Media",
    });
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: "/Volumes/Media/video.mp4",
      relativePath: "video.mp4",
      mediaType: "video",
      sizeBytes: 123,
      mtimeMs: 1710000000000,
      durationSeconds: "180",
    });

    const response = await clipsController.exportClip({
      file_id: file.id,
      start_time_seconds: 12,
      end_time_seconds: 42,
      output_format: "mp4",
    });

    expect(response).toMatchObject({
      job_id: expect.any(String),
      status: "queued",
    });
    await expect(jobsController.getJob(response.job_id)).resolves.toMatchObject({
      id: response.job_id,
      job_type: "export_clip",
      status: "queued",
      input: {
        file_id: file.id,
        start_time_seconds: 12,
        end_time_seconds: 42,
        output_format: "mp4",
      },
    });
  });
});
