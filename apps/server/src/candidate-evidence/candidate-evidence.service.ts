import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { candidateEvidenceStrategySchema } from '@local-media-agent/shared/schemas'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { DATABASE } from '../database/database.module.js'
import { createJob, type Database } from '../database/repositories.js'
import {
  agentRunCandidates,
  candidateEvidence,
  evaluationCandidates,
  jobs,
  mediaAssets,
  mediaFiles,
  vectorRefs,
  videoScenes,
} from '../database/schema.js'

const PROTOCOL_VERSION = 'candidate-evidence-v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const listEvidenceSchema = z
  .object({
    source_type: z.enum(['agent_run_candidate', 'evaluation_candidate']),
    source_id: z.string().uuid(),
    candidate_key: z.string().min(1).max(300).optional(),
  })
  .strict()

const createEvidenceSchema = z
  .object({
    source: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('agent_run_candidate'),
          run_id: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          type: z.literal('evaluation_candidate'),
          run_id: z.string().uuid(),
          candidate_id: z.string().uuid(),
        })
        .strict(),
    ]),
    candidate_key: z.string().min(1).max(300),
    strategies: z.array(candidateEvidenceStrategySchema).min(1).max(2),
  })
  .strict()
  .refine((input) => new Set(input.strategies).size === input.strategies.length, {
    message: 'strategies must not contain duplicates',
    path: ['strategies'],
  })

/**
 * Server 只验证冻结候选并事务性创建/复用证据与 Job；拼图、哈希和文件发布均由 Python
 * Worker 异步完成。这样 HTTP 请求不会因 FFmpeg/Pillow 工作阻塞，也不会把本机路径发给浏览器。
 */
@Injectable()
export class CandidateEvidenceService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createEvidence(rawInput: unknown) {
    const parsed = createEvidenceSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten())
    }
    const input = parsed.data
    const strategies = [...input.strategies].sort()

    return this.db.transaction(async (tx) => {
      const identity =
        input.source.type === 'agent_run_candidate'
          ? await this.resolveAgentCandidate(
              tx as Database,
              input.source.run_id,
              input.candidate_key,
            )
          : await this.resolveEvaluationCandidate(
              tx as Database,
              input.source.run_id,
              input.source.candidate_id,
              input.candidate_key,
            )
      const sourceId =
        input.source.type === 'agent_run_candidate'
          ? input.source.run_id
          : input.source.candidate_id
      const isEvaluation = input.source.type === 'evaluation_candidate'
      const rows = []
      for (const strategy of strategies) {
        const id = randomUUID()
        const [inserted] = await tx
          .insert(candidateEvidence)
          .values({
            id,
            sourceType: input.source.type,
            sourceId,
            candidateKey: identity.candidateKey,
            fileId: identity.fileId,
            fileGeneration: identity.fileGeneration,
            assetId: identity.assetId,
            sceneId: identity.sceneId,
            strategy,
            protocolVersion: PROTOCOL_VERSION,
            status: 'queued',
            retentionClass: isEvaluation ? 'evaluation_frozen' : 'cache_24h',
            expiresAt: isEvaluation ? null : new Date(Date.now() + CACHE_TTL_MS),
            frozenAt: isEvaluation ? new Date() : null,
          })
          .onConflictDoNothing()
          .returning()
        const row =
          inserted ??
          (
            await tx
              .select()
              .from(candidateEvidence)
              .where(
                and(
                  eq(candidateEvidence.sourceType, input.source.type),
                  eq(candidateEvidence.sourceId, sourceId),
                  eq(candidateEvidence.candidateKey, identity.candidateKey),
                  eq(candidateEvidence.fileGeneration, identity.fileGeneration),
                  eq(candidateEvidence.strategy, strategy),
                  eq(candidateEvidence.protocolVersion, PROTOCOL_VERSION),
                ),
              )
              .limit(1)
              .for('update')
          )[0]
        if (!row) throw new Error('Candidate evidence conflict could not be reloaded')
        if (
          row.fileId !== identity.fileId ||
          row.assetId !== identity.assetId ||
          row.sceneId !== identity.sceneId
        ) {
          // 唯一键按冻结来源和 candidate_key 复用；若数据库中的候选身份被异常改写，
          // 必须暴露冲突，不能把旧证据悄悄挂到新的 Asset/场景。
          throw new ConflictException('Existing evidence does not match the frozen candidate')
        }
        rows.push(row)
      }

      const needsJob = rows.filter(
        (row) => !row.jobId || row.status === 'failed' || row.status === 'cancelled',
      )
      if (needsJob.length > 0) {
        const job = await createJob(tx as Database, {
          jobType: 'build_candidate_evidence',
          fileId: identity.fileId,
          timeoutSeconds: 3600,
          inputJson: {
            candidate_key: identity.candidateKey,
            file_id: identity.fileId,
            file_generation: identity.fileGeneration,
            asset_id: identity.assetId,
            scene_id: identity.sceneId,
            strategies: needsJob.map((row) => row.strategy).sort(),
          },
        })
        const now = new Date()
        for (const row of needsJob) {
          const [updated] = await tx
            .update(candidateEvidence)
            .set({
              jobId: job.id,
              status: 'queued',
              errorCode: null,
              errorMessage: null,
              errorDetailsJson: null,
              updatedAt: now,
              finishedAt: null,
            })
            .where(eq(candidateEvidence.id, row.id))
            .returning()
          const index = rows.findIndex((item) => item.id === row.id)
          rows[index] = updated
        }
      }

      return { items: rows.map((row) => this.toResponse(row)) }
    })
  }

  async getEvidence(id: string) {
    const [row] = await this.db
      .select()
      .from(candidateEvidence)
      .where(eq(candidateEvidence.id, id))
      .orderBy(asc(candidateEvidence.createdAt))
      .limit(1)
    if (!row) throw new NotFoundException('Candidate evidence not found')
    return this.toResponse(row)
  }

  async listEvidence(rawQuery: unknown) {
    const parsed = listEvidenceSchema.safeParse(rawQuery)
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten())
    const filters = [
      eq(candidateEvidence.sourceType, parsed.data.source_type),
      eq(candidateEvidence.sourceId, parsed.data.source_id),
    ]
    if (parsed.data.candidate_key) {
      filters.push(eq(candidateEvidence.candidateKey, parsed.data.candidate_key))
    }
    const rows = await this.db
      .select()
      .from(candidateEvidence)
      .where(and(...filters))
      .orderBy(asc(candidateEvidence.createdAt))
    return { items: rows.map((row) => this.toResponse(row)) }
  }

  async cancelEvidence(id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(candidateEvidence)
        .where(eq(candidateEvidence.id, id))
        .limit(1)
      if (!row) throw new NotFoundException('Candidate evidence not found')
      if (!row.jobId || ['succeeded', 'failed', 'cancelled'].includes(row.status)) {
        return this.toResponse(row)
      }
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, row.jobId))
        .limit(1)
        .for('update')
      if (!job) throw new ConflictException('Candidate evidence Job is missing')
      const [lockedRow] = await tx
        .select()
        .from(candidateEvidence)
        .where(eq(candidateEvidence.id, id))
        .limit(1)
        .for('update')
      if (!lockedRow || lockedRow.jobId !== job.id) {
        throw new ConflictException('Candidate evidence Job changed during cancellation')
      }
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        return this.toResponse(lockedRow)
      }
      const now = new Date()
      if (job.status === 'queued') {
        await tx
          .update(jobs)
          .set({
            status: 'cancelled',
            errorCode: 'EVIDENCE_CANCELLED',
            errorMessage: '候选证据构建已取消',
            errorDetailsJson: { stage: 'candidate_evidence' },
            updatedAt: now,
            finishedAt: now,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      } else if (job.status === 'running') {
        // running Job 只写取消请求；Worker 在帧读取与发布边界检查后清理 partial，
        // 再把 Job/evidence 一起转为 cancelled。
        await tx
          .update(jobs)
          .set({ status: 'cancel_requested', updatedAt: now })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')))
      }
      const nextStatus = job.status === 'queued' ? 'cancelled' : 'cancel_requested'
      const updatedRows = await tx
        .update(candidateEvidence)
        .set({
          status: nextStatus,
          errorCode: nextStatus === 'cancelled' ? 'EVIDENCE_CANCELLED' : null,
          errorMessage: nextStatus === 'cancelled' ? '候选证据构建已取消' : null,
          errorDetailsJson: nextStatus === 'cancelled' ? { stage: 'candidate_evidence' } : null,
          updatedAt: now,
          finishedAt: nextStatus === 'cancelled' ? now : null,
        })
        .where(eq(candidateEvidence.jobId, job.id))
        .returning()
      return this.toResponse(updatedRows.find((item) => item.id === id) ?? row)
    })
  }

  async getArtifact(id: string) {
    const [row] = await this.db
      .select()
      .from(candidateEvidence)
      .where(eq(candidateEvidence.id, id))
      .limit(1)
    if (!row) throw new NotFoundException('Candidate evidence not found')
    if (row.status !== 'succeeded' || !row.artifactPath || !row.artifactSha256) {
      throw new ConflictException('Candidate evidence artifact is not ready')
    }
    let content: Buffer
    try {
      content = await readFile(row.artifactPath)
    } catch {
      throw new ConflictException({
        error_code: 'EVIDENCE_ARTIFACT_MISSING',
        message: '候选证据文件不存在',
      })
    }
    const actualSha256 = createHash('sha256').update(content).digest('hex')
    if (actualSha256 !== row.artifactSha256) {
      throw new ConflictException({
        error_code: 'EVIDENCE_ARTIFACT_FINGERPRINT_MISMATCH',
        message: '候选证据文件指纹不匹配',
      })
    }
    return {
      content,
      contentType: row.artifactMimeType ?? 'application/octet-stream',
      filename: row.strategy === 'contact_sheet_v1' ? `${row.id}.png` : `${row.id}.json`,
    }
  }

  private async resolveAgentCandidate(db: Database, runId: string, candidateKey: string) {
    const [candidate] = await db
      .select()
      .from(agentRunCandidates)
      .where(
        and(eq(agentRunCandidates.runId, runId), eq(agentRunCandidates.candidateKey, candidateKey)),
      )
      .limit(1)
    if (!candidate) throw new NotFoundException('Frozen Agent candidate not found')
    return this.validateIdentity(db, candidate)
  }

  private async resolveEvaluationCandidate(
    db: Database,
    runId: string,
    candidateId: string,
    candidateKey: string,
  ) {
    const [candidate] = await db
      .select()
      .from(evaluationCandidates)
      .where(
        and(
          eq(evaluationCandidates.id, candidateId),
          eq(evaluationCandidates.runId, runId),
          eq(evaluationCandidates.candidateKey, candidateKey),
        ),
      )
      .limit(1)
    if (!candidate) throw new NotFoundException('Frozen Evaluation candidate not found')
    // Evaluation 的 RRF Top-20 可能由 Caption 通道单独召回。此时冻结 asset_id 必须
    // 继续指向 Caption 以保留检索事实，但联系表协议需要一个已索引 video_frame 作为
    // Worker 的身份锚点。Agent 候选没有这个转换，仍执行原来的严格帧身份校验。
    return this.validateIdentity(db, candidate, true)
  }

  private async validateIdentity(
    db: Database,
    candidate: {
      candidateKey: string
      fileId: string
      fileGeneration: number
      assetId: string
      sceneId: string | null
    },
    allowEvaluationCaptionAnchor = false,
  ) {
    if (!candidate.sceneId) {
      throw new BadRequestException('Phase D candidate evidence only supports video scenes')
    }

    const [file] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, candidate.fileId))
      .limit(1)
    if (!file || file.deletedAt || file.mediaType !== 'video') {
      throw new ConflictException('Candidate file is missing or is not an active video')
    }
    if (file.indexGeneration !== candidate.fileGeneration) {
      throw new ConflictException({
        error_code: 'STALE_FILE_GENERATION',
        expected_generation: candidate.fileGeneration,
        current_generation: file.indexGeneration,
      })
    }

    const [scene] = await db
      .select()
      .from(videoScenes)
      .where(eq(videoScenes.id, candidate.sceneId))
      .limit(1)
    if (
      !scene ||
      scene.fileId !== candidate.fileId ||
      scene.indexGeneration !== candidate.fileGeneration
    ) {
      throw new ConflictException('Candidate scene does not match the frozen file generation')
    }
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, candidate.assetId))
      .limit(1)
    if (
      !asset ||
      asset.fileId !== candidate.fileId ||
      asset.sceneId !== candidate.sceneId ||
      (asset.metadataJson as { stale?: unknown }).stale === true
    ) {
      throw new ConflictException('Candidate asset does not match the frozen video scene')
    }
    if (asset.assetType === 'video_frame') {
      return candidate as typeof candidate & { sceneId: string }
    }
    if (!allowEvaluationCaptionAnchor || asset.assetType !== 'caption') {
      throw new ConflictException('Candidate asset does not match the frozen video scene')
    }

    // contact_sheet_v1 会读取这个场景的全部 indexed 帧；anchor 只用于让 Server 与
    // Worker 对“该冻结场景至少仍有一个可检索帧”做两次一致性校验。按时间和 UUID
    // 选择第一条使重启、重复请求和多 Server 进程得到完全相同的 evidence 身份。
    const indexedFrames = await db
      .select({ id: mediaAssets.id, metadataJson: mediaAssets.metadataJson })
      .from(mediaAssets)
      .innerJoin(vectorRefs, eq(vectorRefs.assetId, mediaAssets.id))
      .where(
        and(
          eq(mediaAssets.fileId, candidate.fileId),
          eq(mediaAssets.sceneId, candidate.sceneId),
          eq(mediaAssets.assetType, 'video_frame'),
          eq(vectorRefs.collectionName, 'video_frame_vectors'),
          eq(vectorRefs.status, 'indexed'),
        ),
      )
      .orderBy(asc(mediaAssets.frameTimeSeconds), asc(mediaAssets.id))
    const anchor = indexedFrames.find(
      (frame) => (frame.metadataJson as { stale?: unknown }).stale !== true,
    )
    if (!anchor) {
      throw new ConflictException('Frozen video scene has no indexed frame for candidate evidence')
    }
    return { ...candidate, assetId: anchor.id } as typeof candidate & { sceneId: string }
  }

  private toResponse(row: typeof candidateEvidence.$inferSelect) {
    return {
      id: row.id,
      candidate_key: row.candidateKey,
      file_id: row.fileId,
      file_generation: row.fileGeneration,
      asset_id: row.assetId,
      scene_id: row.sceneId,
      job_id: row.jobId,
      status: row.status,
      strategy: row.strategy,
      protocol_version: row.protocolVersion,
      manifest: row.manifestJson,
      frame_count:
        row.manifestJson &&
        typeof row.manifestJson === 'object' &&
        'frame_count' in row.manifestJson
          ? row.manifestJson.frame_count
          : null,
      artifact_url: row.status === 'succeeded' ? `/candidate-evidence/${row.id}/artifact` : null,
      error:
        row.errorCode && row.errorMessage
          ? { code: row.errorCode, message: row.errorMessage, details: row.errorDetailsJson }
          : null,
      expires_at: row.expiresAt?.toISOString() ?? null,
      frozen_at: row.frozenAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }
  }
}
