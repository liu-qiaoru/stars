/** 为统一DeepSeek决策准备本次搜索实际命中的图片和文字。
 * Server同步读取当前版本并在内存生成JPEG；不创建Worker任务、不改索引、不外发。
 * 状态只保存证据与摘要；调用者在独立授权后、派发前重新准备并核对同一指纹。
 */
import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { MATCHED_EVIDENCE_LIMITS, retrievalMatchedEvidenceSchema, type RetrievalMatchedEvidence, type RetrievalSourceMatch } from '@local-media-agent/shared/schemas'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import { agentRunCandidates, mediaAssets, mediaFiles, vectorRefs } from '../database/schema.js'
import { SceneInspectionTool } from './scene-inspection.tool.js'
import { SegmentDetailsTool, type SegmentDetails } from './segment-details.tool.js'
import type { RetrievalDecisionImage } from './retrieval-decision.runner.js'
import type { RetrievalQuerySnapshot } from './retrieval-candidates.policy.js'
import { AgentStepExecutionError } from './agent.types.js'

export type MatchedEvidence = RetrievalMatchedEvidence
export interface PreparedMatchedBatch { records: Record<string, MatchedEvidence>; images: RetrievalDecisionImage[]; fingerprint: string }
/** 新用途独立授权，不能由旧3候选采样授权或百炼重排授权推导。 */
export function matchedEvidenceAuthorized(scope: unknown): boolean {
  const grant = (scope as { retrieval_evidence?: any } | null)?.retrieval_evidence
  return grant?.allowed === true && grant.provider === 'rightapi' && grant.model === 'deepseek-v4-flash' &&
    grant.protocol === MATCHED_EVIDENCE_LIMITS.protocol && grant.maximum_candidates === 20 && grant.maximum_frames_per_candidate === 1
}
/** 使用固定元组计算，JSONB键顺序改变不能让恢复误判内容改变。 */
export function matchedEvidenceFingerprint(records: Record<string, MatchedEvidence>) {
  return createHash('sha256').update(JSON.stringify(Object.keys(records).sort().map(key => {
    const r = records[key]!
    return [key, r.file_generation, r.status, r.truncated, r.evidence.map(e => [e.evidence_id, e.source, e.text, e.start_seconds, e.end_seconds, e.truncated])]
  }))).digest('hex')
}

@Injectable()
export class MatchedEvidenceTool {
  constructor(@Inject(DATABASE) private readonly db: Database,
    @Inject(SegmentDetailsTool) private readonly details: SegmentDetailsTool,
    @Inject(SceneInspectionTool) private readonly frames: SceneInspectionTool) {}

  /** 每候选最多一张本轮命中图及两份实际命中文字；没有视觉命中不臆造MaxSim帧。
   * queries是已提交搜索快照，不能接收模型自造帧或素材身份。最新匹配优先，原来源不覆盖。
   */
  async prepare(runId: string, keys: string[], queries: RetrievalQuerySnapshot[]): Promise<PreparedMatchedBatch> {
    if (keys.length > 20 || new Set(keys).size !== keys.length) throw new AgentStepExecutionError('AGENT_CONTEXT_LIMIT', '命中证据候选超限或重复。')
    const records: Record<string, MatchedEvidence> = {}, images: RetrievalDecisionImage[] = []
    for (const key of keys) {
      const [candidate] = await this.db.select().from(agentRunCandidates).where(and(eq(agentRunCandidates.runId, runId), eq(agentRunCandidates.candidateKey, key))).limit(1)
      if (!candidate) throw new AgentStepExecutionError('AGENT_CANDIDATE_INVALID', '命中证据必须属于当前任务。')
      const checked = await this.details.read(runId, key)
      const record: MatchedEvidence = { candidate_key: key, level: 'matched', file_generation: candidate.fileGeneration,
        status: checked.status, evidence: [], truncated: false, continuous_action_verified: false }
      records[key] = record
      if (checked.status === 'stale' || checked.status === 'read_failed') continue
      const [file] = await this.db.select({ libraryId: mediaFiles.libraryId, mediaType: mediaFiles.mediaType }).from(mediaFiles).where(eq(mediaFiles.id, candidate.fileId)).limit(1)
      if (!file) { record.status = 'stale'; continue }
      const matches: Array<RetrievalSourceMatch & { query_step_id?: string }> = []
      for (const query of [...queries].reverse()) {
        const rank = query.ranks?.find(row => row.candidate_key === key)
        for (const hit of rank?.hits ?? []) for (const match of hit.source_matches ?? []) {
          if (!matches.some(row => row.source === match.source)) matches.push({ ...match, query_step_id: query.step_id })
        }
      }
      // 历史搜索没有完整source_matches时只复用明确的视觉代表帧；不得猜测Caption资产。
      const retrieval = candidate.retrievalJson as { source_matches?: RetrievalSourceMatch[]; reasons?: string[]; best_frame_time_seconds?: number | null }
      for (const match of retrieval.source_matches ?? []) if (!matches.some(row => row.source === match.source)) matches.push(match)
      if (!matches.length && retrieval.reasons?.includes('vector_match')) matches.push({ asset_id: candidate.assetId, source: 'vector_match', frame_time_seconds: retrieval.best_frame_time_seconds ?? null })
      for (const match of matches) {
        const [asset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, match.asset_id)).limit(1)
        const metadata = asset?.metadataJson as Record<string, unknown> | undefined
        if (!asset || asset.fileId !== candidate.fileId || asset.sceneId !== candidate.sceneId || metadata?.stale === true || metadata?.stale === 'true' ||
          (match.source === 'caption_match' && (asset.assetType !== 'caption' || metadata?.prompt_version !== (file.mediaType === 'video' ? 'scene-caption-v2' : 'caption-v1')))) {
          // 必须校验本次实际命中的版本；同场景其他有效描述不能替过期来源背书。
          record.status = 'stale'; record.evidence = []; break
        }
        if (match.source !== 'transcript_match') {
          const collection = match.source === 'caption_match' ? 'caption_text_vectors' : file.mediaType === 'image' ? 'image_vectors' : 'video_frame_vectors'
          const [ref] = await this.db.select().from(vectorRefs).where(and(eq(vectorRefs.assetId, asset.id), eq(vectorRefs.status, 'indexed'), eq(vectorRefs.fileId, candidate.fileId), eq(vectorRefs.libraryId, file.libraryId), eq(vectorRefs.collectionName, collection))).limit(1)
          if (!ref) { record.status = 'stale'; record.evidence = []; break }
        }
        if (match.source === 'vector_match') {
          if (!['image', 'video_frame'].includes(asset.assetType)) throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '视觉命中不是图片或视频帧。')
          const prepared = await this.frames.prepare(runId, key, { frame_id: asset.id, time_seconds: match.frame_time_seconds })
          const frame = prepared.metadata.frames[0]!
          const evidenceId = `frame:${frame.frame_id}:${frame.sha256}`
          record.evidence.push({ evidence_id: evidenceId, source: 'matched_visual_frame',
            text: JSON.stringify({ frame_id: frame.frame_id, time_seconds: frame.time_seconds, sha256: frame.sha256, role: 'query_maxsim_frame', query_step_id: match.query_step_id ?? null }),
            start_seconds: frame.time_seconds, end_seconds: frame.time_seconds, crosses_scene_boundary: false, truncated: false })
          images.push({ candidate_key: key, evidence_id: evidenceId, data_url: prepared.images[0]! })
        } else {
          const type = match.source === 'caption_match' ? 'caption' : 'text_chunk'
          if (asset.assetType !== type) throw new AgentStepExecutionError('AGENT_EVIDENCE_INVALID', '文字命中资产类型不匹配。')
          const full = asset.textContent ?? '', chars = [...full], text = chars.slice(0, MATCHED_EVIDENCE_LIMITS.textCharacters).join('')
          if (!text) continue
          const truncated = chars.length > MATCHED_EVIDENCE_LIMITS.textCharacters
          const digest = createHash('sha256').update(JSON.stringify([asset.id, full, asset.metadataJson, candidate.fileGeneration])).digest('hex')
          record.evidence.push({ evidence_id: `${asset.id}:${digest}`, source: type === 'caption' ? 'pre_generated_caption' : 'transcript',
            text, start_seconds: asset.startTimeSeconds === null ? null : Number(asset.startTimeSeconds),
            end_seconds: asset.endTimeSeconds === null ? null : Number(asset.endTimeSeconds), crosses_scene_boundary: false, truncated })
          record.truncated ||= truncated
        }
      }
      if (record.status === 'stale') {
        // 某来源失效时整条候选不提供旧图文，绝不把残留图像发送给模型。
        for (let i = images.length - 1; i >= 0; i--) if (images[i]!.candidate_key === key) images.splice(i, 1)
      } else record.status = record.evidence.length ? 'available' : 'empty'
    }
    for (const record of Object.values(records)) retrievalMatchedEvidenceSchema.parse(record)
    return { records, images, fingerprint: matchedEvidenceFingerprint(records) }
  }
}
