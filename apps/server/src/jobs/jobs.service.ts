import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  claimNextJob,
  getJob,
  heartbeatJob,
  listActiveOcrJobs,
  listActiveEmbeddingJobs,
  listJobs,
  listPendingOcrAssets,
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
    // 只为没有 active job 的 pending ref 创建任务，避免重复 worker 同时写同一个 Qdrant point。
    const pendingRefs = await listPendingEmbeddingVectorRefs(this.db, limit)
    const activeJobs = await listActiveEmbeddingJobs(this.db)
    const activeKeys = new Set(
      activeJobs.map((job) => {
        const input = job.inputJson as {
          asset_id?: string
          collection?: string
          model_name?: string
          model_version?: string
        }
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

  async queuePendingOcrJobs(
    input: { libraryId?: string; fileId?: string; batchSize?: number; limit?: number } = {},
  ) {
    // OCR 以 asset batch 为单位创建 job，降低每个图片/关键帧一个 job 的队列噪音。
    const defaultBatchSize = Number.parseInt(process.env.OCR_BATCH_SIZE ?? '20', 10)
    const batchSize = Math.max(
      1,
      input.batchSize ?? (Number.isFinite(defaultBatchSize) ? defaultBatchSize : 20),
    )
    const pendingAssets = await listPendingOcrAssets(this.db, {
      libraryId: input.libraryId,
      fileId: input.fileId,
      limit: input.limit ?? 500,
    })
    const activeJobs = await listActiveOcrJobs(this.db)
    const activeAssetIds = new Set(
      activeJobs.flatMap((job) => {
        const activeInput = job.inputJson as { asset_ids?: string[] }
        return activeInput.asset_ids ?? []
      }),
    )
    const queueableAssetIds = pendingAssets
      .map((asset) => asset.assetId)
      .filter((assetId) => !activeAssetIds.has(assetId))
    const skipped = pendingAssets.length - queueableAssetIds.length
    let created = 0

    for (let index = 0; index < queueableAssetIds.length; index += batchSize) {
      const assetIds = queueableAssetIds.slice(index, index + batchSize)
      if (!assetIds.length) {
        continue
      }
      await createJob(this.db, {
        jobType: 'run_ocr',
        timeoutSeconds: 7200,
        inputJson: {
          asset_ids: assetIds,
          engine: 'paddleocr',
          language: 'ch',
        },
      })
      created += 1
    }

    return {
      scanned: pendingAssets.length,
      created,
      skipped,
    }
  }

  private toEmbeddingJobInput(
    ref: Awaited<ReturnType<typeof listPendingEmbeddingVectorRefs>>[number],
  ) {
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
    // video_segment 没有独立 frame asset 时，取 segment 中点作为代表帧时间。
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
