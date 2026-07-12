import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  claimNextJob,
  getJob,
  heartbeatJob,
  listAttemptedEmbeddingJobs,
  listAttemptedOcrJobs,
  listJobs,
  listPendingOcrAssets,
  listPendingEmbeddingVectorRefs,
  markJobSucceeded,
  createJob,
  createVideoReindexJobs,
  getVideoReindexState,
  reclaimStaleJobs,
  resolveJobFilePaths,
  type Database,
} from '../database/repositories.js'

@Injectable()
export class JobsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listJobs(input: { limit?: number; offset?: number } = {}) {
    const { rows, total, limit, offset } = await listJobs(this.db, input)
    const filePathsByJobId = await resolveJobFilePaths(this.db, rows)
    return {
      items: rows.map((row) => this.toResponse(row, filePathsByJobId.get(row.id) ?? [])),
      total,
      limit,
      offset,
    }
  }

  async getJob(id: string) {
    const row = await getJob(this.db, id)
    if (!row) {
      throw new NotFoundException('Job not found')
    }
    const filePathsByJobId = await resolveJobFilePaths(this.db, [row])
    return this.toResponse(row, filePathsByJobId.get(row.id) ?? [])
  }

  async getVideoReindexReadiness(input: { libraryId?: string; fileId?: string } = {}) {
    const state = await getVideoReindexState(this.db, input)
    return {
      ready: state.visualNotReadyFileIds.length === 0,
      active_video_files: state.fileIds.length,
      active_video_segments: state.activeVideoSegments,
      segments_without_frames: state.segmentsWithoutFrames,
      segments_over_30_seconds: state.segmentsOver30Seconds,
      active_video_segment_vector_refs: state.activeVideoSegmentVectorRefs,
      segments_without_scene_caption_v2: state.segmentsWithoutSceneCaptionV2,
      missing_file_ids: state.notReadyFileIds,
    }
  }

  async queueVideoReindexJobs(
    input: {
      libraryId?: string
      fileId?: string
      limit?: number
      dryRun?: boolean
      onlyNotReady?: boolean
    } = {},
  ) {
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new BadRequestException('limit must be an integer between 1 and 1000')
    }
    const state = await getVideoReindexState(this.db, input)
    const candidateIds = input.onlyNotReady === false ? state.fileIds : state.notReadyFileIds
    const activeIds = candidateIds.filter((fileId) => state.activeJobFileIds.has(fileId))
    const queueableIds = candidateIds
      .filter((fileId) => !state.activeJobFileIds.has(fileId))
      .slice(0, limit)
    const created = input.dryRun ? [] : await createVideoReindexJobs(this.db, queueableIds)
    return {
      scanned: state.fileIds.length,
      queueable: queueableIds.length,
      created: created.length,
      skipped_active: activeIds.length,
      dry_run: input.dryRun ?? false,
      file_ids: queueableIds,
    }
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
    // 只为没有 embedding 尝试记录的 pending ref 创建任务，避免失败/无结果场景被 coordinator 无限重建。
    const pendingRefs = await listPendingEmbeddingVectorRefs(this.db, limit)
    const attemptedJobs = await listAttemptedEmbeddingJobs(this.db)
    const lastAttemptedAtByKey = new Map<string, Date>()
    for (const job of attemptedJobs) {
      const input = job.inputJson as {
        asset_id?: string
        collection?: string
        model_name?: string
        model_version?: string
      }
      const key = this.embeddingJobKey(input)
      const previous = lastAttemptedAtByKey.get(key)
      if (!previous || job.createdAt > previous) {
        lastAttemptedAtByKey.set(key, job.createdAt)
      }
    }
    let created = 0
    let skipped = 0

    for (const ref of pendingRefs) {
      const input = this.toEmbeddingJobInput(ref)
      const key = this.embeddingJobKey(input)
      const lastAttemptedAt = lastAttemptedAtByKey.get(key)
      if (lastAttemptedAt && lastAttemptedAt >= ref.vectorRefUpdatedAt) {
        skipped += 1
        continue
      }
      await createJob(this.db, {
        jobType: this.embeddingJobType(input.collection),
        inputJson: input,
      })
      lastAttemptedAtByKey.set(key, new Date())
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
    const attemptedJobs = await listAttemptedOcrJobs(this.db)
    const attemptedAssetIds = new Set(
      attemptedJobs.flatMap((job) => {
        const jobInput = job.inputJson as { asset_ids?: string[] }
        return jobInput.asset_ids ?? []
      }),
    )
    const queueableAssetIds = pendingAssets
      .map((asset) => asset.assetId)
      .filter((assetId) => !attemptedAssetIds.has(assetId))
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
    if (ref.collectionName === 'caption_text_vectors') {
      return {
        asset_id: ref.assetId,
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

  private embeddingJobType(collection: string) {
    if (collection === 'image_vectors') {
      return 'embed_image'
    }
    if (collection === 'caption_text_vectors') {
      return 'embed_text_asset'
    }
    if (collection === 'video_frame_vectors' || collection === 'video_segment_vectors') {
      return 'embed_video_frame'
    }
    throw new Error(`Unsupported embedding collection: ${collection}`)
  }

  private embeddingJobKey(input: {
    asset_id?: string
    collection?: string
    model_name?: string
    model_version?: string
  }) {
    return `${input.asset_id ?? ''}|${input.collection ?? ''}|${input.model_name ?? ''}|${input.model_version ?? ''}`
  }

  private toResponse(row: Awaited<ReturnType<typeof getJob>>, filePaths: string[] = []) {
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
      file_paths: filePaths,
      input: row.inputJson,
      result: row.resultJson,
      error_message: row.errorMessage,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
    }
  }
}
