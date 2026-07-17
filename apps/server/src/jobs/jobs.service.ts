import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  claimNextJob,
  getJob,
  heartbeatJob,
  listAttemptedEmbeddingJobs,
  listJobs,
  listPendingEmbeddingVectorRefs,
  markJobSucceeded,
  createJob,
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
        // embed 任务是单文件任务，填写 file_id 外键便于按文件查询活跃任务。
        fileId: ref.fileId,
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
    // 视频帧 asset 通常带 frame_time_seconds；缺失时退回到 asset 起止时间中点作为代表帧。
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
    if (collection === 'video_frame_vectors') {
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
      // error_message 是给用户看的简短错误；error_code/error_details 暴露机器可读的结构化
      // 错误码与技术诊断（场景检测失败等），供 Jobs 页面展开详情和修复后重试。
      error_message: row.errorMessage,
      error_code: row.errorCode,
      error_details: row.errorDetailsJson,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
    }
  }
}
