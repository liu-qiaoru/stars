import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { Inject, Injectable } from '@nestjs/common'
import { RETRIEVAL_EVIDENCE_LIMITS, type RetrievalOverview, type RetrievalSourceMatch } from '@local-media-agent/shared/schemas'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  agentRunCandidates,
  agentRuns,
  libraries,
  mediaAssets,
  mediaFiles,
  videoScenes,
  vectorRefs,
} from '../database/schema.js'

export interface SegmentEvidence {
  evidence_id: string
  source: 'pre_generated_caption' | 'transcript' | 'media_metadata' | 'scene_visual_observation' | 'matched_visual_frame'
  text: string
  start_seconds: number | null
  end_seconds: number | null
  crosses_scene_boundary: boolean
  truncated: boolean
}
export interface SegmentDetails {
  candidate_key: string
  status: 'available' | 'empty' | 'missing' | 'stale' | 'read_failed'
  start_seconds?: number | null
  end_seconds?: number | null
  evidence: SegmentEvidence[]
  truncated: boolean
  unavailable_count?: number
  media_info?: {
    media_type: string
    duration_seconds: number | null
    width: number | null
    height: number | null
  }
  continuous_action_verified: false
}

/** 只接受本 run 已冻结的候选，路径永不离开数据库层。正文限长并保留真实时间和版本指纹。 */
@Injectable()
export class SegmentDetailsTool {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** 按任务及候选读取限长证据；失效/缺失以状态返回，数据库故障由执行器记录为工具失败。 */
  async read(runId: string, key: string): Promise<SegmentDetails> {
    return this.readEvidence(runId, key)
  }

  /** 只读本任务已提交候选的Caption，概要不读取转录、不生成描述。
   * 先提交原文搜索，再单独提交概要，准备失败不会丢掉已完成基线。
   */
  async readOverview(runId: string, key: string): Promise<RetrievalOverview> {
    const detail = await this.readEvidence(runId, key, true)
    const caption = detail.evidence.find(row => row.source === 'pre_generated_caption')
    const evidence = caption ? [{ ...caption, source: 'pre_generated_caption' as const,
      text: [...caption.text].slice(0, RETRIEVAL_EVIDENCE_LIMITS.overviewCharacters).join(''),
      truncated: caption.truncated || [...caption.text].length > RETRIEVAL_EVIDENCE_LIMITS.overviewCharacters }] : []
    return { candidate_key: key, level: 'overview', status: detail.status, evidence,
      truncated: evidence.some(row => row.truncated), continuous_action_verified: false }
  }

  /** 共用当前身份校验，概要与详情只改变所读正文的类别和输出上限。 */
  private async readEvidence(runId: string, key: string, overview = false): Promise<SegmentDetails> {
    const base: SegmentDetails = {
      candidate_key: key,
      status: 'missing',
      evidence: [],
      truncated: false,
      continuous_action_verified: false,
    }
    const [candidate] = await this.db
      .select()
      .from(agentRunCandidates)
      .where(and(eq(agentRunCandidates.runId, runId), eq(agentRunCandidates.candidateKey, key)))
      .limit(1)
    if (candidate?.candidateKey !== key) return base
    if (!candidate) return base
    const [run] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    const [file] = await this.db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, candidate.fileId))
      .limit(1)
    if (!file || file.deletedAt || file.indexGeneration !== candidate.fileGeneration)
      return { ...base, status: 'stale' }
    const [library] = await this.db
      .select()
      .from(libraries)
      .where(eq(libraries.id, file.libraryId))
      .limit(1)
    const scope = run?.enforcedScopeJson as
      | { library_ids?: string[]; media_types?: string[] }
      | undefined
    if (
      !library ||
      library.deletedAt ||
      library.status !== 'active' ||
      !scope ||
      (scope.library_ids?.length && !scope.library_ids.includes(file.libraryId)) ||
      (scope.media_types?.length && !scope.media_types.includes(file.mediaType))
    )
      return { ...base, status: 'stale' }
    // 路径只取自已验证的文件行，工具输入没有路径字段；检查磁盘变化不会读取媒体正文。
    try {
      const info = await stat(file.path)
      if (
        !info.isFile() ||
        info.size !== file.sizeBytes ||
        Math.abs(info.mtimeMs - file.mtimeMs) > 1
      )
        return { ...base, status: 'stale' }
    } catch (error) {
      return {
        ...base,
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'stale' : 'read_failed',
      }
    }
    const [asset] = await this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, candidate.assetId))
      .limit(1)
    if (
      !asset ||
      asset.fileId !== file.id ||
      asset.sceneId !== candidate.sceneId ||
      (asset.metadataJson as { stale?: boolean }).stale
    )
      return { ...base, status: 'stale' }
    // 回表后的业务身份可能是原图，实际Caption向量却属于另一条资产。
    // 逐通道校验已冻结的真实来源，不能要求原图也有视觉向量；全文命中不要求向量。
    // 旧任务无source_matches时，Caption仅兼容同文件/同场景的当前有效Caption。
    const retrieval = candidate.retrievalJson as { reasons?: string[]; source_matches?: RetrievalSourceMatch[] }
    for (const source of ['vector_match', 'caption_match'] as const) {
      if (!retrieval.reasons?.includes(source)) continue
      const match = retrieval.source_matches?.find(row => row.source === source)
      const [ref] = await this.db
        .select({ id: vectorRefs.id })
        .from(vectorRefs)
        .innerJoin(mediaAssets, eq(vectorRefs.assetId, mediaAssets.id))
        .where(
          and(
            match ? eq(vectorRefs.assetId, match.asset_id) : source === 'vector_match' ? eq(vectorRefs.assetId, asset.id) : undefined,
            eq(vectorRefs.fileId, file.id),
            eq(vectorRefs.libraryId, file.libraryId),
            eq(vectorRefs.status, 'indexed'),
            eq(mediaAssets.fileId, file.id),
            candidate.sceneId ? eq(mediaAssets.sceneId, candidate.sceneId) : sql`${mediaAssets.sceneId} IS NULL`,
            sql`coalesce(${mediaAssets.metadataJson}->>'stale', 'false') <> 'true'`,
            source === 'caption_match' ? and(eq(vectorRefs.collectionName, 'caption_text_vectors'), eq(mediaAssets.assetType, 'caption'),
              sql`${mediaAssets.metadataJson}->>'prompt_version' = ${file.mediaType === 'video' ? 'scene-caption-v2' : 'caption-v1'}`) :
              and(inArray(mediaAssets.assetType, ['image', 'video_frame']), eq(vectorRefs.collectionName, file.mediaType === 'image' ? 'image_vectors' : 'video_frame_vectors')),
          ),
        )
        .limit(1)
      if (!ref) return { ...base, status: 'stale' }
    }
    const start = candidate.sceneStartSeconds === null ? null : Number(candidate.sceneStartSeconds)
    const end = candidate.sceneEndSeconds === null ? null : Number(candidate.sceneEndSeconds)
    if (candidate.sceneId) {
      const [scene] = await this.db
        .select()
        .from(videoScenes)
        .where(eq(videoScenes.id, candidate.sceneId))
        .limit(1)
      if (
        !scene ||
        scene.fileId !== file.id ||
        scene.indexGeneration !== file.indexGeneration ||
        Number(scene.startTimeSeconds) !== start ||
        Number(scene.endTimeSeconds) !== end
      )
        return { ...base, status: 'stale' }
    } else if (file.mediaType === 'video' || file.mediaType === 'audio') {
      // 全文检索的转录候选没有 scene_id；它的有效片段是 text_chunk 自己的真实时间，不能伪造场景。
      if (
        asset.assetType !== 'text_chunk' ||
        start === null ||
        end === null ||
        end <= start ||
        start < 0 ||
        asset.startTimeSeconds === null ||
        asset.endTimeSeconds === null ||
        Number(asset.startTimeSeconds) !== start ||
        Number(asset.endTimeSeconds) !== end ||
        (file.durationSeconds !== null && end > Number(file.durationSeconds))
      )
        return { ...base, status: 'stale' }
    }
    // 限定 SQL 时间窗口，避免为了一个场景读取整部影片转录；额外一行用于报告截断。
    const rows = await this.db
      .select({
        id: mediaAssets.id,
        type: mediaAssets.assetType,
        sceneId: mediaAssets.sceneId,
        start: mediaAssets.startTimeSeconds,
        end: mediaAssets.endTimeSeconds,
        text: sql<string | null>`left(${mediaAssets.textContent}, 1201)`,
        metadata: mediaAssets.metadataJson,
        captionSceneFileId: videoScenes.fileId,
        captionSceneGeneration: videoScenes.indexGeneration,
      })
      .from(mediaAssets)
      .leftJoin(videoScenes, eq(mediaAssets.sceneId, videoScenes.id))
      .where(
        and(
          eq(mediaAssets.fileId, file.id),
          inArray(mediaAssets.assetType, overview ? ['caption'] : ['caption', 'text_chunk']),
          sql`(${mediaAssets.assetType} = 'caption' AND ${candidate.sceneId ? sql`${mediaAssets.sceneId} = ${candidate.sceneId}` : file.mediaType === 'video' ? sql`${videoScenes.startTimeSeconds} < ${end} AND ${videoScenes.endTimeSeconds} > ${start}` : sql`${mediaAssets.sceneId} IS NULL`}
          OR ${mediaAssets.assetType} = 'text_chunk' AND ${start === null || end === null ? sql`true` : sql`${mediaAssets.startTimeSeconds} < ${end} AND ${mediaAssets.endTimeSeconds} > ${start}`})`,
        ),
      )
      .orderBy(asc(mediaAssets.startTimeSeconds), asc(mediaAssets.id))
      .limit(9)
    let unavailable = 0
    const mediaInfo = {
      media_type: file.mediaType,
      duration_seconds: file.durationSeconds === null ? null : Number(file.durationSeconds),
      width: file.width,
      height: file.height,
    }
    const metadataText = JSON.stringify(mediaInfo)
    const evidence: SegmentEvidence[] = [
      {
        evidence_id: `metadata:${file.id}:${createHash('sha256')
          .update(metadataText + file.indexGeneration + key)
          .digest('hex')
          .slice(0, 24)}`,
        source: 'media_metadata',
        text: metadataText,
        start_seconds: start,
        end_seconds: end,
        crosses_scene_boundary: false,
        truncated: false,
      },
    ]
    for (const row of rows.slice(0, 8)) {
      const metadata = row.metadata as Record<string, unknown>
      if (
        metadata.stale === true ||
        metadata.stale === 'true' ||
        (row.type === 'caption' &&
          (metadata.prompt_version !==
            (file.mediaType === 'video' ? 'scene-caption-v2' : 'caption-v1') ||
            (file.mediaType === 'video' &&
              (row.captionSceneFileId !== file.id ||
                row.captionSceneGeneration !== file.indexGeneration))))
      ) {
        unavailable++
        continue
      }
      if (!row.text) continue
      const evidenceStart = row.start === null ? null : Number(row.start)
      const evidenceEnd = row.end === null ? null : Number(row.end)
      if (
        row.type === 'text_chunk' &&
        (evidenceStart === null || evidenceEnd === null || evidenceEnd <= evidenceStart)
      ) {
        unavailable++
        continue
      }
      const text = row.text.slice(0, 1200)
      // 内容和时间都进入指纹：同一个 asset 的文字发生变化也不能继续引用旧证据。
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([text, row.start, row.end, metadata.prompt_version, file.indexGeneration]),
        )
        .digest('hex')
        .slice(0, 24)
      evidence.push({
        evidence_id: `${row.id}:${fingerprint}`,
        source: row.type === 'caption' ? 'pre_generated_caption' : 'transcript',
        text,
        start_seconds: evidenceStart,
        end_seconds: evidenceEnd,
        crosses_scene_boundary:
          start !== null &&
          end !== null &&
          evidenceStart !== null &&
          evidenceEnd !== null &&
          (evidenceStart < start || evidenceEnd > end),
        truncated: row.text.length > 1200,
      })
    }
    return {
      ...base,
      status:
        evidence.length > 1
          ? 'available'
          : unavailable
            ? 'stale'
            : rows.length
              ? 'empty'
              : 'missing',
      start_seconds: start,
      end_seconds: end,
      evidence,
      media_info: mediaInfo,
      truncated: rows.length > 8 || evidence.some((item) => item.truncated),
      unavailable_count: unavailable,
    }
  }
}
