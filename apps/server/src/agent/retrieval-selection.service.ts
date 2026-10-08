import { retrievalModel } from './retrieval-model.policy.js'
import { MATCHED_DECISION_POLICY_VERSION } from '@local-media-agent/shared/schemas'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { retrievalBudget, type RetrievalBudget } from './retrieval-budget.policy.js'
import { selectRetrievalCandidatePlan, type RetrievalSelectionInput } from './retrieval-selection.policy.js'

export const RETRIEVAL_FROZEN_QUERIES = { cat: '小猫趴在猫爬架上', action: '有人用筷子从分格餐盒里夹食物',
  position: '人物旁边挂着衣服', exclusion: '有人在厨房灶台前操作，不要空厨房',
  multi: '戴白色耳机的人坐在绿色沙发上抱臂', empty: 'qxacceptanceempty20261005' }

/** 配置摘要不含地址、密钥或路径；固定模型、提示/选择版本及预算变更均需重新验收。 */
export function retrievalConfigurationFingerprint(settings: Settings, budget = retrievalBudget(settings)) {
  return createHash('sha256').update(JSON.stringify({ intent_model: retrievalModel(settings), decision_version: settings.agentRetrievalEvidenceMode === 'matched_multimodal' ? MATCHED_DECISION_POLICY_VERSION : 'evidence-planning-v8-sampled-evidence',
    matched_evidence: { mode: settings.agentRetrievalEvidenceMode ?? 'overview', protocol: 'matched-multimodal-v1', candidates: 20, frames: 1, image_side: 256, jpeg_quality: 45, request_bytes: 750000, maximum_assessments: 2, maximum_gap_checks: 3 },
    scene_inspection: { enabled: settings.agentSceneInspectionEnabled ?? false, protocol: 'sampled-frame-observation-v2', candidates: 3, frames: 3 },
    rerank_model: 'qwen3-vl-rerank', caption_search: settings.captionSearchEnabled,
    query_expansion: 'original', ranking: 'rrf', initial_limit: 20, final_limit: 10,
    budget, no_progress: settings.agentRetrievalMaxNoProgress ?? 2, retries: settings.agentRetrievalMaxRetries ?? 1 })).digest('hex')
}

/** 与离线冻结脚本相同的只读摘要。正文只在数据库内部聚合，不返回正文或文件路径。 */
export async function retrievalIndexFingerprint(db: Database) {
  const result = await db.execute(sql`select
    (select md5(string_agg(id::text || index_generation::text || size_bytes::text || mtime_ms::text, '|' order by id)) from media_files where deleted_at is null) as files,
    (select md5(string_agg(id::text || coalesce(text_content,'') || metadata_json::text, '|' order by id)) from media_assets) as assets,
    (select md5(string_agg(id::text || index_generation::text || start_time_seconds::text || end_time_seconds::text, '|' order by id)) from video_scenes) as scenes,
    (select md5(string_agg(point_id::text || status || content_hash || model_name || model_version, '|' order by point_id)) from vector_refs) as refs`)
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}

/** 本地资格装配入口，默认无资格。无HTTP启用参数、无模型调用；读取失败也明确保留基线。 */
@Injectable()
export class RetrievalSelectionService {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(SETTINGS) private readonly settings: Settings) {}

  /** 隔离验收显式使用，与产品同一纯选择函数；没有网络/API入口，也不授予正式质量资格。 */
  async selectForEvaluation(input: Omit<RetrievalSelectionInput, 'fingerprint' | 'configuration_fingerprint'>, limits: RetrievalBudget) {
    const configuration = retrievalConfigurationFingerprint(this.settings, limits)
    return { ...selectRetrievalCandidatePlan({ ...input, fingerprint: '', configuration_fingerprint: configuration }, { evaluation: true }),
      configuration_fingerprint: configuration, fingerprint: '' }
  }

  /** 只在首次结束时选择；Handler把计划和名单与等待/重排状态原子提交，恢复不能重新分配席位。 */
  async select(input: Omit<RetrievalSelectionInput, 'fingerprint' | 'configuration_fingerprint'>, limits: RetrievalBudget) {
    input = { ...input, required_queries: RETRIEVAL_FROZEN_QUERIES }
    const configuration = retrievalConfigurationFingerprint(this.settings, limits)
    let qualification: unknown
    let fingerprint = ''
    if (this.settings.agentRetrievalQualityReport) {
      try {
        if ((await stat(this.settings.agentRetrievalQualityReport)).size > 2_000_000) throw new Error('Quality file too large')
        qualification = JSON.parse(await readFile(this.settings.agentRetrievalQualityReport, 'utf8'))
        fingerprint = await retrievalIndexFingerprint(this.db)
      } catch {
        return { ...selectRetrievalCandidatePlan({ ...input, fingerprint, configuration_fingerprint: configuration }),
          fallback_reason: 'quality_record_unavailable', configuration_fingerprint: configuration, fingerprint }
      }
    }
    return { ...selectRetrievalCandidatePlan({ ...input, fingerprint, configuration_fingerprint: configuration }, { qualification }),
      configuration_fingerprint: configuration, fingerprint }
  }
}
