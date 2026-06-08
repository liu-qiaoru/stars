import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  claimNextJob,
  getJob,
  heartbeatJob,
  listActiveEmbeddingJobs,
  listJobs,
  listPendingEmbeddingVectorRefs,
  markJobSucceeded,
  createJob,
  reclaimStaleJobs,
  type Database,
} from '../database/repositories.js'

@Injectable()
export class JobsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listJobs() {
    const rows = await listJobs(this.db)
    return {
      items: rows.map((row) => this.toResponse(row)),
    }
  }

  async getJob(id: string) {
    const row = await getJob(this.db, id)
    if (!row) {
      throw new NotFoundException('Job not found')
    }
    return this.toResponse(row)
  }

  async claimNextJob(workerId: string, now = new Date()) {
    const row = await claimNextJob(this.db, workerId, now)
    return row ? this.toResponse(row) : null
  }

  reclaimStaleJobs(now = new Date()) {
    return reclaimStaleJobs(this.db, now)
  }

  async heartbeatJob(id: string, now = new Date()) {
    const row = await heartbeatJob(this.db, id, now)
    if (!row) {
      throw new NotFoundException('Running job not found')
    }
    return this.toResponse(row)
  }

  async markJobSucceeded(id: string, result: unknown, now = new Date()) {
    const row = await markJobSucceeded(this.db, id, result, now)
    if (!row) {
      throw new NotFoundException('Job not found')
    }
    return this.toResponse(row)
  }

  async queuePendingEmbeddingJobs(limit = 100) {
    const pendingRefs = await listPendingEmbeddingVectorRefs(this.db, limit)
    const activeJobs = await listActiveEmbeddingJobs(this.db)
    const activeKeys = new Set(
      activeJobs.map((job) => {
        const input = job.inputJson as { asset_id?: string; collection?: string; model_name?: string; model_version?: string }
        return this.embeddingJobKey(input)
      }),
    )
    let created = 0
    let skipped = 0

    for (const ref of pendingRefs) {
      const input = this.toEmbeddingJobInput(ref)
      const key = this.embeddingJobKey(input)
      if (activeKeys.has(key)) {
        skipped += 1
        continue
      }
      await createJob(this.db, {
        jobType: input.collection === 'image_vectors' ? 'embed_image' : 'embed_video_frame',
        inputJson: input,
      })
      activeKeys.add(key)
      created += 1
    }

    return {
      scanned: pendingRefs.length,
      created,
      skipped,
    }
  }

  private toEmbeddingJobInput(ref: Awaited<ReturnType<typeof listPendingEmbeddingVectorRefs>>[number]) {
    if (ref.collectionName === 'image_vectors') {
      return {
        asset_id: ref.assetId,
        path: ref.assetPath ?? ref.filePath,
        collection: ref.collectionName,
        model_name: ref.modelName,
        model_version: ref.modelVersion,
      }
    }

    return {
      asset_id: ref.assetId,
      frame_path: ref.assetPath ?? ref.filePath,
      frame_time_seconds: this.representativeFrameTime(ref),
      collection: ref.collectionName,
      model_name: ref.modelName,
      model_version: ref.modelVersion,
    }
  }

  private representativeFrameTime(
    ref: Awaited<ReturnType<typeof listPendingEmbeddingVectorRefs>>[number],
  ) {
    if (ref.frameTimeSeconds !== null) {
      return Number(ref.frameTimeSeconds)
    }
    if (ref.startTimeSeconds !== null && ref.endTimeSeconds !== null) {
      return (Number(ref.startTimeSeconds) + Number(ref.endTimeSeconds)) / 2
    }
    return 0
  }

  private embeddingJobKey(input: {
    asset_id?: string
    collection?: string
    model_name?: string
    model_version?: string
  }) {
    return `${input.asset_id ?? ''}|${input.collection ?? ''}|${input.model_name ?? ''}|${input.model_version ?? ''}`
  }

  private toResponse(row: Awaited<ReturnType<typeof getJob>>) {
    if (!row) {
      throw new NotFoundException('Job not found')
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
    }
  }
}
