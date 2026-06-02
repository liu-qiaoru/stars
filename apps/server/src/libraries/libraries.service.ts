import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { scanLibraryInputSchema } from "@local-media-agent/shared/schemas";
import { DATABASE } from "../database/database.module.js";
import {
  createJob,
  createLibrary,
  getLibrary,
  getLibraryMediaCounts,
  listLibraries,
  updateLibraryStatus,
  type Database,
} from "../database/repositories.js";

interface CreateLibraryInput {
  name: string;
  root_path: string;
}

@Injectable()
export class LibrariesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createLibrary(input: CreateLibraryInput) {
    const row = await createLibrary(this.db, {
      name: input.name,
      rootPath: input.root_path,
    });
    return this.toResponse(row);
  }

  async listLibraries() {
    const rows = await listLibraries(this.db);
    const items = await Promise.all(
      rows.map(async (row) => {
        const counts = await getLibraryMediaCounts(this.db, row.id);
        return {
          ...this.toResponse(row),
          media_count: counts.mediaCount,
          indexed_count: counts.indexedCount,
          failed_count: counts.failedCount,
        };
      }),
    );
    return {
      items,
    };
  }

  async getLibrary(id: string) {
    const row = await getLibrary(this.db, id);
    if (!row) {
      throw new NotFoundException("Library not found");
    }
    return this.toResponse(row);
  }

  async disableLibrary(id: string) {
    const row = await updateLibraryStatus(this.db, id, "disabled");
    if (!row) {
      throw new NotFoundException("Library not found");
    }
    return this.toResponse(row);
  }

  async deleteLibrary(id: string) {
    const row = await updateLibraryStatus(this.db, id, "deleted");
    if (!row) {
      throw new NotFoundException("Library not found");
    }
    return { deleted: true };
  }

  async createScanJob(id: string) {
    const library = await getLibrary(this.db, id);
    if (!library) {
      throw new NotFoundException("Library not found");
    }
    const inputJson = scanLibraryInputSchema.parse({
      library_id: library.id,
      root_path: library.rootPath,
      scan_mode: "mtime_size",
    });
    const job = await createJob(this.db, {
      jobType: "scan_library",
      inputJson,
    });
    return {
      job_id: job.id,
      status: job.status,
    };
  }

  private toResponse(row: Awaited<ReturnType<typeof getLibrary>>) {
    if (!row) {
      throw new NotFoundException("Library not found");
    }
    return {
      id: row.id,
      name: row.name,
      root_path: row.rootPath,
      enabled: row.status === "active",
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
