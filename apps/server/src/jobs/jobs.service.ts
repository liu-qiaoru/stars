import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE } from "../database/database.module.js";
import {
  claimNextJob,
  getJob,
  heartbeatJob,
  listJobs,
  markJobSucceeded,
  reclaimStaleJobs,
  type Database,
} from "../database/repositories.js";

@Injectable()
export class JobsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listJobs() {
    const rows = await listJobs(this.db);
    return {
      items: rows.map((row) => this.toResponse(row)),
    };
  }

  async getJob(id: string) {
    const row = await getJob(this.db, id);
    if (!row) {
      throw new NotFoundException("Job not found");
    }
    return this.toResponse(row);
  }

  async claimNextJob(workerId: string, now = new Date()) {
    const row = await claimNextJob(this.db, workerId, now);
    return row ? this.toResponse(row) : null;
  }

  reclaimStaleJobs(now = new Date()) {
    return reclaimStaleJobs(this.db, now);
  }

  async heartbeatJob(id: string, now = new Date()) {
    const row = await heartbeatJob(this.db, id, now);
    if (!row) {
      throw new NotFoundException("Running job not found");
    }
    return this.toResponse(row);
  }

  async markJobSucceeded(id: string, result: unknown, now = new Date()) {
    const row = await markJobSucceeded(this.db, id, result, now);
    if (!row) {
      throw new NotFoundException("Job not found");
    }
    return this.toResponse(row);
  }

  private toResponse(row: Awaited<ReturnType<typeof getJob>>) {
    if (!row) {
      throw new NotFoundException("Job not found");
    }
    return {
      id: row.id,
      job_type: row.jobType,
      status: row.status,
      priority: row.priority,
      attempt: row.attempt,
      locked_by: row.lockedBy,
      locked_at: row.lockedAt?.toISOString() ?? null,
      heartbeat_at: row.heartbeatAt?.toISOString() ?? null,
      timeout_seconds: row.timeoutSeconds,
      progress: row.progress,
      input: row.inputJson,
      result: row.resultJson,
      error_message: row.errorMessage,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
    };
  }
}
