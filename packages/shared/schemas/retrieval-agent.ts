import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/** 本地证据提供的固定边界；批量减少模型往返，不提高候选或逐条详情预算。 */
export const RETRIEVAL_EVIDENCE_LIMITS = { overviewCharacters: 240, detailBatchSize: 3 } as const

/** 搜索折叠后的实际命中来源；Caption回源图片时仍保留Caption资产身份。 */
export const retrievalSourceMatchSchema = z.object({
  asset_id: z.string().uuid(), source: z.enum(['vector_match', 'caption_match', 'transcript_match']),
  frame_time_seconds: z.number().nonnegative().nullable(),
}).strict()
export type RetrievalSourceMatch = z.infer<typeof retrievalSourceMatchSchema>

/** 一次统一判断的固定边界；模型调用另受已冻结单任务额度与外发费用门限制。 */
export const MATCHED_EVIDENCE_LIMITS = { candidates: 20, textsPerCandidate: 2, textCharacters: 1200,
  imageSide: 256, imageQuality: 45, imageBytes: 20000, requestBytes: 750000, protocol: 'matched-multimodal-v1' } as const

/** 已发送命中证据的持久化结构；图片只保存身份/时间/摘要，绝不保存编码或路径。 */
export const retrievalMatchedEvidenceSchema = z.object({
  candidate_key: z.string().min(1).max(300), level: z.literal('matched'), file_generation: z.number().int().nonnegative(),
  status: z.enum(['available', 'empty', 'missing', 'stale', 'read_failed']), truncated: z.boolean(),
  continuous_action_verified: z.literal(false),
  evidence: z.array(z.object({ evidence_id: z.string().min(1).max(400),
    source: z.enum(['matched_visual_frame', 'pre_generated_caption', 'transcript']),
    text: z.string().refine(value => [...value].length <= MATCHED_EVIDENCE_LIMITS.textCharacters),
    start_seconds: z.number().nullable(), end_seconds: z.number().nullable(), crosses_scene_boundary: z.boolean(), truncated: z.boolean(),
  }).strict()).max(3),
}).strict()
export type RetrievalMatchedEvidence = z.infer<typeof retrievalMatchedEvidenceSchema>

/** 概要仅用于选择下一步；不是完整详情，也不提供视频连续动作验证。 */
export const retrievalOverviewSchema = z.object({
  candidate_key: z.string().min(1).max(300), level: z.literal('overview'),
  status: z.enum(['available', 'empty', 'missing', 'stale', 'read_failed']),
  evidence: z.array(z.object({ evidence_id: z.string().min(1).max(400), source: z.literal('pre_generated_caption'),
    text: z.string().refine(value => [...value].length <= RETRIEVAL_EVIDENCE_LIMITS.overviewCharacters),
    start_seconds: z.number().nullable(), end_seconds: z.number().nullable(),
    crosses_scene_boundary: z.boolean(), truncated: z.boolean(),
  }).strict()).max(1), truncated: z.boolean(), continuous_action_verified: z.literal(false),
}).strict()
export type RetrievalOverview = z.infer<typeof retrievalOverviewSchema>

/** 可审计的行动依据，不保存模型内部思考。所有身份仍须由 Server 对当前任务校验。 */
export const retrievalGapSchema = z.object({
  condition_ids: z.array(z.string().uuid()).min(1).max(31),
  kind: z.enum(['no_candidates', 'details_unread', 'not_mentioned', 'contradiction', 'stale', 'tool_failed', 'visual_unverified']),
  checked: z.array(z.object({ candidate_key: z.string().min(1).max(300),
    evidence_ids: z.array(z.string().min(1).max(400)).max(20),
    // Server 覆盖层级与状态，候选身份检查和概要都不能伪装成完整详情。
    evidence_level: z.enum(['identity', 'overview', 'detail', 'matched']).optional(),
    read_status: z.enum(['not_read', 'available', 'empty', 'missing', 'stale', 'read_failed']).optional() }).strict()).max(20),
  missing_evidence: z.string().trim().min(1).max(400),
  next_step_reason: z.string().trim().min(1).max(400),
  preserves_original_goal: z.literal(true),
}).strict()
export type RetrievalGap = z.infer<typeof retrievalGapSchema>

/** 命中图文决策的新停止策略；与素材传输许可协议分别版本化。 */
export const MATCHED_DECISION_POLICY_VERSION = 'matched-pixel-stop-v2' as const
/** 只保存可审查的行动结论，不要求或保存内部推理过程。
 * 身份、引用、预算和实际空结果由Server另行核对；“没有有用下一步”仍是模型意见。
 */
export const retrievalStopBasisSchema = z.object({
  kind: z.enum(['sufficient_evidence', 'no_useful_next_action', 'no_results']),
  condition_ids: z.array(z.string().uuid()).max(31),
  checked: retrievalGapSchema.shape.checked.max(3),
  search: z.object({ status: z.enum(['not_useful', 'exhausted', 'not_needed']), reason: z.string().trim().min(1).max(240) }).strict(),
  detail: z.object({ status: z.enum(['not_useful', 'exhausted', 'not_needed']), reason: z.string().trim().min(1).max(240) }).strict(),
}).strict()
export type RetrievalStopBasis = z.infer<typeof retrievalStopBasisSchema>

/** 模型只能提出一个动作；素材库范围、文件路径、任意时间段均不属于工具输入。 */
export const retrievalActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('search_media'),
      // 与创建任务的 4000 Unicode 字符边界一致；JS 长度可能占用两个编码单元。
      query: z.string().min(1).max(8000).refine(value => value.trim().length > 0 && [...value].length <= 4000),
      search_scope: z.enum(['visual', 'spoken', 'all']),
      media_types: z
        .array(z.enum(['image', 'video', 'audio']))
        .min(1)
        .max(3),
      limit: z.number().int().min(1).max(20),
      // 兼容已保存的旧 pending；新模型动作在 Server 中强制要求 gap。
      gap: retrievalGapSchema.optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('get_segment_details'), candidate_key: z.string().min(1).max(300), gap: retrievalGapSchema.optional() })
    .strict(),
  z.object({ action: z.literal('get_segment_details_batch'),
    candidate_keys: z.array(z.string().min(1).max(300)).min(1).max(RETRIEVAL_EVIDENCE_LIMITS.detailBatchSize)
      .refine(keys => new Set(keys).size === keys.length, 'Candidate identities must be distinct'),
    gap: retrievalGapSchema.optional(),
  }).strict(),
  // 图片工具只接受冻结候选和原文缺口；授权及取帧范围由服务端决定。
  z.object({ action: z.literal('inspect_segment_frames'), candidate_key: z.string().min(1).max(300), gap: retrievalGapSchema }).strict(),
  z.object({ action: z.literal('clarify'), question: z.string().min(1).max(500) }).strict(),
  z
    .object({
      action: z.literal('finish'),
      reason: z.enum([
        'found',
        'partial',
        'no_results',
        'insufficient_evidence',
        'conditions_not_met',
      ]),
      assessments: z
        .array(
          z
            .object({
              candidate_key: z.string().min(1).max(300),
              conditions: z
                .array(
                  z
                    .object({
                      condition_id: z.string().uuid(),
                      status: z.enum(['satisfied', 'not_satisfied', 'unknown']),
                      evidence_ids: z.array(z.string().min(1).max(400)).max(20),
                      basis: z.enum(['explicit_support', 'explicit_contradiction', 'not_mentioned', 'not_read', 'stale', 'tool_failed']).optional(),
                    })
                    .strict(),
                )
                .max(31),
            })
            .strict(),
        )
        .max(20),
      // 旧overview动作兼容省略；新命中模式在Server按当前证据强制验证。
      stop_basis: retrievalStopBasisSchema.optional(),
    })
    .strict(),
])
export type RetrievalAction = z.infer<typeof retrievalActionSchema>
// 传输约束与返回校验从同一份定义生成，避免两套协议漂移。
export const retrievalActionJsonSchema = zodToJsonSchema(retrievalActionSchema, {
  $refStrategy: 'none',
})

/** 20候选图文输入不意味着要逐个输出20份判断。保留原候选池和全部原条件，
 * 仅限制本轮解释数量，以适配已授权2000输出token；无法完整解释时可返回空判断。
 * 从同一动作结构派生传输Schema，旧协议的20份输出上限不改写。
 */
const matchedGapSchema = retrievalGapSchema.extend({ checked: retrievalGapSchema.shape.checked.max(3) })
export const retrievalMatchedActionSchema = z.discriminatedUnion('action', [
  retrievalActionSchema.options[0].extend({ gap: matchedGapSchema.optional() }),
  retrievalActionSchema.options[1].extend({ gap: matchedGapSchema.optional() }),
  retrievalActionSchema.options[2].extend({ gap: matchedGapSchema.optional() }),
  retrievalActionSchema.options[3].extend({ gap: matchedGapSchema }),
  retrievalActionSchema.options[4],
  retrievalActionSchema.options[5].extend({ assessments: retrievalActionSchema.options[5].shape.assessments.max(2) }),
])
export const retrievalMatchedActionJsonSchema = zodToJsonSchema(retrievalMatchedActionSchema, { $refStrategy: 'none' })

/** 程序提交的核实边界，不属于模型可填写的动作字段。文字来源有效并不证明画面事实。 */
export const retrievalVisualVerificationSchema = z.object({
  status: z.literal('unverified'),
  reason: z.enum(['text_only_tools', 'sampled_frames']),
  model_stop_reason: z.enum(['found', 'partial', 'no_results', 'insufficient_evidence', 'conditions_not_met']),
}).strict()
export type RetrievalVisualVerification = z.infer<typeof retrievalVisualVerificationSchema>

/** 本地质量资格记录，不由模型生成，也不接受HTTP直接启用。服务端还要重新计算逐查询指标。 */
export const retrievalQualityQualificationSchema = z.object({
  protocol: z.literal('retrieval-selection-qualification-v1'),
  policy_version: z.literal('evidence-selection-v2'),
  report_id: z.string().min(1).max(100),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  configuration_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  label_source: z.literal('human_review'),
  cases: z.array(z.object({
    id: z.string().min(1).max(100), query: z.string().min(1).max(8000),
    scope: z.object({ search_scope: z.enum(['visual', 'spoken', 'all']),
      media_types: z.array(z.enum(['image', 'video', 'audio'])).min(1).max(3), library_ids: z.array(z.string().uuid()).max(100) }).strict(),
    baseline_candidate_keys: z.array(z.string().min(1).max(300)).max(20),
    selected_candidate_keys: z.array(z.string().min(1).max(300)).max(20),
    baseline_final: z.array(z.string().min(1).max(300)).max(10),
    enhanced_final: z.array(z.string().min(1).max(300)).max(10),
    target: z.string().min(1).max(300).nullable(),
    judgments: z.array(z.object({ candidate_key: z.string().min(1).max(300), relevance: z.number().int().min(0).max(2) }).strict()).max(40),
    // 无画面候选的全文空结果无需外发；其他查询的两个结果必须有确定的请求身份。
    baseline_request: z.object({ status: z.literal('received'), model: z.literal('qwen3-vl-rerank'), request_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
    enhanced_request: z.object({ status: z.literal('received'), model: z.literal('qwen3-vl-rerank'), request_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
  }).strict()).min(1).max(32),
}).strict()
export type RetrievalQualityQualification = z.infer<typeof retrievalQualityQualificationSchema>

/** 采样画面观察是模型意见，不是人工标签，也不能验证连续动作。 */
export const sceneObservationSchema = z.object({
  candidate_key: z.string().min(1).max(300),
  summary: z.string().min(1).max(400),
  conditions: z.array(z.object({ condition_id: z.string().uuid(),
    status: z.enum(['satisfied', 'not_satisfied', 'unknown']),
    frame_ids: z.array(z.string().uuid()).max(3),
    observation: z.string().min(1).max(240),
  }).strict()).max(31),
}).strict()
export const sceneObservationJsonSchema = zodToJsonSchema(sceneObservationSchema, { $refStrategy: 'none' })
export type SceneObservation = z.infer<typeof sceneObservationSchema>
export const SCENE_INSPECTION_LIMITS = { candidates: 3, frames: 3, requestBytes: 100000 } as const

/** 程序对采样覆盖边界的降级记录，不保存模型内部推理。 */
export const sceneObservationNormalizationSchema = z.object({
  condition_id: z.string().uuid(),
  original_status: z.enum(['satisfied', 'not_satisfied']),
  reason: z.enum(['sampled_frames_not_exhaustive', 'continuous_action_unverified']),
}).strict()
export type SceneObservationNormalization = z.infer<typeof sceneObservationNormalizationSchema>
