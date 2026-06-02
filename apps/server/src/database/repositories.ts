import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  jobs,
  libraries,
  mediaAssets,
  mediaFiles,
  vectorRefs,
  type agentRunEvents,
  type agentRuns,
  type agentToolCalls,
} from "./schema.js";
import type * as schema from "./schema.js";

type JsonValue = unknown;
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

type InsertLibrary = typeof libraries.$inferInsert;
type InsertMediaFile = typeof mediaFiles.$inferInsert;
type InsertMediaAsset = typeof mediaAssets.$inferInsert;
type InsertVectorRef = typeof vectorRefs.$inferInsert;
type InsertJob = typeof jobs.$inferInsert;

export async function createLibrary(db: Database, input: Pick<InsertLibrary, "name" | "rootPath">) {
  const [row] = await db
    .insert(libraries)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning();

  return row;
}

export async function createMediaFile(
  db: Database,
  input: Pick<
    InsertMediaFile,
    "libraryId" | "path" | "relativePath" | "mediaType" | "sizeBytes" | "mtimeMs"
  > &
    Partial<Pick<InsertMediaFile, "contentHash" | "durationSeconds" | "width" | "height" | "codec">>,
) {
  const [row] = await db
    .insert(mediaFiles)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning();

  return row;
}

export async function createMediaAsset(
  db: Database,
  input: Pick<InsertMediaAsset, "fileId" | "assetType"> &
    Partial<
      Pick<
        InsertMediaAsset,
        "path" | "startTimeSeconds" | "endTimeSeconds" | "frameTimeSeconds" | "contentHash" | "metadataJson"
      >
    >,
) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning();

  return row;
}

export async function createVectorRef(
  db: Database,
  input: Pick<
    InsertVectorRef,
    | "assetId"
    | "fileId"
    | "libraryId"
    | "collectionName"
    | "pointId"
    | "modelName"
    | "modelVersion"
    | "vectorKind"
    | "vectorDim"
    | "distance"
    | "contentHash"
    | "indexProfile"
  >,
) {
  // point_id 由 worker 按 vector-index-design 的确定性规则生成；repository 只保存引用关系。
  const [row] = await db
    .insert(vectorRefs)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning();

  return row;
}

export async function createJob(
  db: Database,
  input: Pick<InsertJob, "jobType"> &
    Partial<Pick<InsertJob, "priority" | "maxAttempts" | "timeoutSeconds">> & {
      inputJson: JsonValue;
    },
) {
  // input_json 必须来自 packages/shared 的 job schema，Python worker 只消费生成后的 JSON Schema。
  const [row] = await db
    .insert(jobs)
    .values({
      id: randomUUID(),
      ...input,
    })
    .returning();

  return row;
}

export async function getFileWithAssetsAndVectors(db: Database, fileId: string) {
  const file = (await db.query.mediaFiles.findFirst({
    where: eq(mediaFiles.id, fileId),
    with: {
      assets: true,
      vectorRefs: true,
    },
  })) as
    | (typeof mediaFiles.$inferSelect & {
        assets: (typeof mediaAssets.$inferSelect)[];
        vectorRefs: (typeof vectorRefs.$inferSelect)[];
      })
    | undefined;

  if (!file) {
    return undefined;
  }

  const { assets, vectorRefs: refs, ...fileRow } = file;
  return {
    file: fileRow,
    assets,
    vectorRefs: refs,
  };
}

export interface SearchMetadataFilters {
  mediaTypes?: string[];
  libraryIds?: string[];
}

export async function listSearchResultMetadata(
  db: Database,
  collectionName: string,
  pointIds: string[],
  filters: SearchMetadataFilters = {},
) {
  if (pointIds.length === 0) {
    return [];
  }

  const conditions = [
    eq(vectorRefs.collectionName, collectionName),
    inArray(vectorRefs.pointId, pointIds),
    isNull(mediaFiles.deletedAt),
    isNull(libraries.deletedAt),
  ];
  if (filters.mediaTypes?.length) {
    conditions.push(inArray(mediaFiles.mediaType, filters.mediaTypes));
  }
  if (filters.libraryIds?.length) {
    conditions.push(inArray(mediaFiles.libraryId, filters.libraryIds));
  }

  return db
    .select({
      pointId: vectorRefs.pointId,
      assetId: mediaAssets.id,
      fileId: mediaFiles.id,
      mediaType: mediaFiles.mediaType,
      path: mediaFiles.path,
      startTimeSeconds: mediaAssets.startTimeSeconds,
      endTimeSeconds: mediaAssets.endTimeSeconds,
    })
    .from(vectorRefs)
    .innerJoin(mediaAssets, eq(vectorRefs.assetId, mediaAssets.id))
    .innerJoin(mediaFiles, eq(vectorRefs.fileId, mediaFiles.id))
    .innerJoin(libraries, eq(vectorRefs.libraryId, libraries.id))
    .where(and(...conditions));
}

export async function listLibraries(db: Database) {
  return db.select().from(libraries).where(isNull(libraries.deletedAt)).orderBy(asc(libraries.createdAt));
}

export async function getLibrary(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(libraries)
    .where(and(eq(libraries.id, id), isNull(libraries.deletedAt)))
    .limit(1);

  return row;
}

export async function getLibraryMediaCounts(db: Database, libraryId: string) {
  const rows = await db.select().from(mediaFiles).where(eq(mediaFiles.libraryId, libraryId));
  return {
    mediaCount: rows.length,
    indexedCount: rows.filter((row) => row.indexStatus === "indexed").length,
    failedCount: rows.filter((row) => row.indexStatus === "failed").length,
  };
}

export async function updateLibraryStatus(db: Database, id: string, status: "active" | "disabled" | "deleted") {
  const now = new Date();
  const [row] = await db
    .update(libraries)
    .set({
      status,
      updatedAt: now,
      deletedAt: status === "deleted" ? now : null,
    })
    .where(eq(libraries.id, id))
    .returning();

  return row;
}

export async function listJobs(db: Database) {
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(50);
}

export async function getJob(db: Database, id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

export async function claimNextJob(db: Database, workerId: string, now = new Date()) {
  // PostgreSQL worker claim uses an atomic status guard so concurrent workers cannot claim the same queued job.
  const [candidate] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(desc(jobs.priority), asc(jobs.createdAt))
    .limit(1);

  if (!candidate) {
    return undefined;
  }

  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedAt: now,
      heartbeatAt: now,
      attempt: candidate.attempt + 1,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
    .returning();

  return claimed;
}

export async function reclaimStaleJobs(db: Database, now = new Date()) {
  const runningJobs = await db.select().from(jobs).where(eq(jobs.status, "running"));
  const staleIds = runningJobs
    .filter((job) => {
      if (!job.heartbeatAt) {
        return true;
      }
      return now.getTime() - job.heartbeatAt.getTime() > job.timeoutSeconds * 1000;
    })
    .map((job) => job.id);

  for (const id of staleIds) {
    await db
      .update(jobs)
      .set({
        status: "queued",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, id));
  }

  return staleIds.length;
}

export async function markJobSucceeded(db: Database, id: string, resultJson: JsonValue, now = new Date()) {
  const [row] = await db
    .update(jobs)
    .set({
      status: "succeeded",
      progress: 100,
      resultJson,
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(jobs.id, id))
    .returning();

  return row;
}

export async function heartbeatJob(db: Database, id: string, now = new Date()) {
  const [row] = await db
    .update(jobs)
    .set({
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .returning();

  return row;
}

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect;
export type AgentToolCallRow = typeof agentToolCalls.$inferSelect;
