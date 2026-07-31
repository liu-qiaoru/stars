import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  claimNextJob,
  createVideoReindex,
  getActiveMediaJobsForFile,
  getJob,
  getMediaFile,
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

// 视觉/文本 Embedding 已有明确输入，只需完成模型计算和 Qdrant 写入；优先级高于
// 默认的 Caption/转录任务，让大型素材库先恢复可检索状态，之后再补齐更慢的语义通道。
const EMBEDDING_JOB_PRIORITY = 10

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

  async retryJob(id: string) {
    const failed = await getJob(this.db, id)
    if (!failed) {
      throw new NotFoundException('Job not found')
    }
    if (failed.status !== 'failed') {
      throw new ConflictException('Only failed jobs can be retried')
    }
    // 重试创建新的 queued 审计行，而不把原失败行改回 queued。这样用户仍能看到原错误，
    // Python Worker 也只会领取新任务；输入仍由原任务创建时通过的共享 Job Schema 约束。
    const replacement = await createJob(this.db, {
      jobType: failed.jobType,
      priority: failed.priority,
      maxAttempts: failed.maxAttempts,
      timeoutSeconds: failed.timeoutSeconds,
      fileId: failed.fileId ?? undefined,
      inputJson: failed.inputJson as never,
    })
    return { job_id: replacement.id, status: replacement.status }
  }

  async requestVideoReindex(input: { fileId: string }) {
    // 阶段 3：单文件破坏性重索引入口。先确认文件存在且没有正在运行的媒体索引任务，
    // 再在同一事务里把文件标记为 purge_queued 并创建 purge_video_index 任务；
    // purge 成功后由 Worker 重新创建 index_media，实现"先清后重建"。
    const file = await getMediaFile(this.db, input.fileId)
    if (!file) {
      throw new NotFoundException('Media file not found')
    }
    const activeJobs = await getActiveMediaJobsForFile(this.db, input.fileId)
    if (activeJobs.length > 0) {
      // 不支持强制取消正在写索引的媒体任务；返回结构化错误和任务 ID 让调用方等待或处理。
      throw new ConflictException({
        error_code: 'VIDEO_INDEX_JOBS_ACTIVE',
        job_ids: activeJobs.map((job) => job.id),
      })
    }
    const job = await createVideoReindex(this.db, input.fileId)
    return { job_id: job.id, status: 'purge_queued' }
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
    // limit 表示“本轮最多新建多少任务”，不是只查看多少条 ref。若前一页 pending ref
    // 已经有 queued/running/failed 尝试，必须继续翻页，否则它们会永久挡住后续大素材库。
    const creationLimit = Math.max(0, Math.floor(limit))
    if (creationLimit === 0) {
      return { scanned: 0, created: 0, skipped: 0 }
    }

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
    let scanned = 0
    let cursor: { createdAtCursor: string; id: string } | undefined

    while (created < creationLimit) {
      const pendingRefs = await listPendingEmbeddingVectorRefs(
        this.db,
        creationLimit,
        cursor,
      )
      if (pendingRefs.length === 0) {
        break
      }
      const lastRef = pendingRefs.at(-1)!
      cursor = {
        createdAtCursor: lastRef.vectorRefCreatedAtCursor,
        id: lastRef.vectorRefId,
      }

      for (const ref of pendingRefs) {
        scanned += 1
        const input = this.toEmbeddingJobInput(ref)
        const key = this.embeddingJobKey(input)
        const lastAttemptedAt = lastAttemptedAtByKey.get(key)
        if (lastAttemptedAt && lastAttemptedAt >= ref.vectorRefUpdatedAt) {
          skipped += 1
          continue
        }
        await createJob(this.db, {
          jobType: this.embeddingJobType(input.collection),
          priority: EMBEDDING_JOB_PRIORITY,
          // embed 任务是单文件任务，填写 file_id 外键便于按文件查询活跃任务。
          fileId: ref.fileId,
          inputJson: input,
        })
        lastAttemptedAtByKey.set(key, new Date())
        created += 1
        if (created >= creationLimit) {
          break
        }
      }
    }

    return {
      scanned,
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
