import { z } from 'zod'
import { indexProfiles, jobTypes, mediaTypes, vectorCollectionNames } from '../constants/index.js'

const uuidSchema = z.string().uuid()
const nonNegativeIntegerSchema = z.number().int().min(0)
const positiveNumberSchema = z.number().positive()
const nonNegativeNumberSchema = z.number().min(0)
const collectionSchema = z.enum(vectorCollectionNames)
const indexProfileSchema = z.enum(indexProfiles)

/**
 * 使用 Unicode code point（字符代码点）计数，避免 JavaScript 把一个表情符号算成两个字符。
 * Agent 协议的长度上限是隐私、成本和数据库边界，因此不能静默截断。
 */
function unicodeStringSchema(fieldName: string, maximum: number) {
  return z
    .string()
    .min(1)
    .refine((value) => [...value].length <= maximum, {
      message: `${fieldName} must contain at most ${maximum} Unicode characters`,
    })
}

// Phase E 的专用多模态重排协议固定在一次请求内比较完整 20 个候选，并只接受 Top-10。
// index 是请求 documents 数组中的零基位置；Server 用它回映冻结候选，Provider 不能自造 ID。
export const shadowRerankDocumentSchema = z
  .object({
    index: z.number().int().min(0).max(19),
    candidate_key: z.string().min(1).max(300),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    image_base64: z.string().min(1),
  })
  .strict()

export const shadowRerankRequestSchema = z
  .object({
    model: z.literal('qwen3-vl-rerank'),
    query: unicodeStringSchema('query', 4000),
    top_n: z.literal(10),
    documents: z.array(shadowRerankDocumentSchema).length(20),
  })
  .strict()
  .superRefine((value, context) => {
    const indices = value.documents.map((document) => document.index)
    if (new Set(indices).size !== 20 || !indices.every((index, position) => index === position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'documents must contain each index from 0 through 19 exactly once and in order',
        path: ['documents'],
      })
    }
  })

export const shadowRerankResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(19),
            relevance_score: z.number().finite(),
          })
          .strict(),
      )
      .length(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.results.map((result) => result.index)).size !== 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'results must contain 10 unique document indices',
        path: ['results'],
      })
    }
    if (
      value.results.some(
        (result, index) =>
          index > 0 && result.relevance_score > value.results[index - 1]!.relevance_score,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'results must be ordered by non-increasing relevance_score',
        path: ['results'],
      })
    }
  })

// Agent 产品允许 1～20 个视觉候选：素材不足 20 条时仍应精排已有结果，不能为了复用
// Phase E 的固定实验 Schema 而伪造候选或退回 RRF。top_n 等于 min(10, 候选数)。
export const agentRerankRequestSchema = z
  .object({
    model: z.literal('qwen3-vl-rerank'),
    query: unicodeStringSchema('query', 4000),
    top_n: z.number().int().min(1).max(10),
    documents: z.array(shadowRerankDocumentSchema).min(1).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.top_n !== Math.min(10, value.documents.length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'top_n must equal min(10, documents.length)',
        path: ['top_n'],
      })
    }
    if (value.documents.some((document, position) => document.index !== position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'documents must use contiguous zero-based indices in request order',
        path: ['documents'],
      })
    }
  })

export function agentRerankResponseSchema(documentCount: number) {
  const resultCount = Math.min(10, documentCount)
  return z
    .object({
      results: z
        .array(
          z
            .object({
              index: z.number().int().min(0).max(documentCount - 1),
              relevance_score: z.number().finite(),
            })
            .strict(),
        )
        .length(resultCount),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.results.map((result) => result.index)).size !== resultCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'results must contain unique document indices',
          path: ['results'],
        })
      }
      if (
        value.results.some(
          (result, index) =>
            index > 0 && result.relevance_score > value.results[index - 1]!.relevance_score,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'results must be ordered by non-increasing relevance_score',
          path: ['results'],
        })
      }
    })
}

// Phase F 只冻结“原查询 + Server 分配的原子条件 + 1～12 张独立索引帧”。
// Provider 不得修改条件、发明帧 ID 或把 Phase E 的 rerank 模型代替为复核模型。
export const vlmReviewConditionKindSchema = z.enum(['must_have', 'optional', 'exclusion'])
export const vlmReviewVerdictSchema = z.enum(['yes', 'no', 'uncertain'])
export const vlmBlindGroupSchema = z.enum([
  'exact_match',
  'missing_must_have',
  'exclusion_hit',
  'partial_relevance',
  'insufficient_evidence',
])

const vlmReviewConditionSchema = z
  .object({
    condition_id: z.string().min(1).max(100),
    kind: vlmReviewConditionKindSchema,
    source_text: unicodeStringSchema('source_text', 200),
  })
  .strict()

export const vlmCandidateReviewRequestSchema = z
  .object({
    protocol_version: z.literal('vlm-review-v1'),
    model: z.literal('qwen3.7-plus'),
    original_query: unicodeStringSchema('original_query', 4000),
    candidate_key: z.string().min(1).max(300),
    // 可为空：Server 会在调用 Provider 之前直接派生 review_not_applicable。
    // 保留空数组比伪造一个条件更忠实于冻结查询。
    conditions: z.array(vlmReviewConditionSchema).max(30),
    evidence_frames: z
      .array(
        z
          .object({
            frame_id: uuidSchema,
            image_base64: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      new Set(request.conditions.map((condition) => condition.condition_id)).size !==
      request.conditions.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conditions must contain unique condition_id values',
        path: ['conditions'],
      })
    }
    if (
      new Set(request.evidence_frames.map((frame) => frame.frame_id)).size !==
      request.evidence_frames.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidence_frames must contain unique frame_id values',
        path: ['evidence_frames'],
      })
    }
  })

export const vlmCandidateReviewOutputSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    conditions: z
      .array(
        z
          .object({
            condition_id: z.string().min(1).max(100),
            verdict: vlmReviewVerdictSchema,
            evidence_frame_ids: z.array(uuidSchema).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()

/**
 * Zod 只能校验单个 JSON 的形状；条件和帧是否来自本次冻结请求，必须把
 * Provider 输出与请求对照。任何缺失、重复或陌生 ID 都整体失败，不猜测修复。
 */
export function parseVlmCandidateReviewOutput(requestInput: unknown, outputInput: unknown) {
  const request = vlmCandidateReviewRequestSchema.parse(requestInput)
  const output = vlmCandidateReviewOutputSchema.parse(outputInput)
  if (output.candidate_key !== request.candidate_key) {
    throw new Error('candidate_key does not match the frozen request')
  }
  const expectedConditionIds = request.conditions.map((condition) => condition.condition_id)
  const returnedConditionIds = output.conditions.map((condition) => condition.condition_id)
  if (
    new Set(returnedConditionIds).size !== returnedConditionIds.length ||
    returnedConditionIds.length !== expectedConditionIds.length ||
    expectedConditionIds.some((id) => !returnedConditionIds.includes(id))
  ) {
    throw new Error('conditions must match the frozen request exactly once')
  }
  const allowedFrameIds = new Set(request.evidence_frames.map((frame) => frame.frame_id))
  if (
    output.conditions.some(
      (condition) =>
        new Set(condition.evidence_frame_ids).size !== condition.evidence_frame_ids.length ||
        condition.evidence_frame_ids.some((id) => !allowedFrameIds.has(id)),
    )
  ) {
    throw new Error('evidence_frame_ids must reference unique frames from the frozen request')
  }
  return output
}

const vlmBlindCandidateProposalSchema = z
  .object({
    proposal_id: z.string().min(1).max(100),
    source_evaluation_run_id: uuidSchema,
    source_candidate_id: uuidSchema,
    query_text: unicodeStringSchema('query_text', 4000),
    candidate_key: z.string().min(1).max(300),
    file_id: uuidSchema,
    scene_id: uuidSchema,
    start_time_seconds: nonNegativeNumberSchema.finite(),
    end_time_seconds: positiveNumberSchema.finite(),
    proposed_group: vlmBlindGroupSchema,
    selection_basis: unicodeStringSchema('selection_basis', 500),
    conditions: z.array(vlmReviewConditionSchema).min(1).max(30),
  })
  .strict()
  .refine((proposal) => proposal.end_time_seconds > proposal.start_time_seconds, {
    message: 'end_time_seconds must be greater than start_time_seconds',
    path: ['end_time_seconds'],
  })

// 这是“待用户审核”的候选包，不是已冻结人工真值。固定 60 对和 5×12 只为了
// 防止抽样阶段悠然改变分母；每对的组别仍需用户逐条确认。
export const vlmBlindCandidateReviewPacketSchema = z
  .object({
    schema_version: z.literal('phase-f-vlm-candidate-review-v1'),
    proposals: z.array(vlmBlindCandidateProposalSchema).length(60),
  })
  .strict()
  .superRefine((packet, context) => {
    const proposalIds = packet.proposals.map((proposal) => proposal.proposal_id)
    const candidateIds = packet.proposals.map((proposal) => proposal.source_candidate_id)
    if (new Set(proposalIds).size !== proposalIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'proposal_id must be unique',
        path: ['proposals'],
      })
    }
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'source_candidate_id must be unique',
        path: ['proposals'],
      })
    }
    for (const group of vlmBlindGroupSchema.options) {
      if (packet.proposals.filter((proposal) => proposal.proposed_group === group).length !== 12) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `proposed_group ${group} must contain exactly 12 proposals`,
          path: ['proposals'],
        })
      }
    }
  })

export const vlmBlindCandidateReviewInputSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    reviewed_group: vlmBlindGroupSchema.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === 'accepted' && input.reviewed_group === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reviewed_group is required when a proposal is accepted',
        path: ['reviewed_group'],
      })
    }
    if (input.decision === 'rejected' && input.reviewed_group !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reviewed_group must be omitted when a proposal is rejected',
        path: ['reviewed_group'],
      })
    }
  })

// 条件标签使用稳定的 condition row UUID + 标注阶段作为幂等身份。相同阶段重复保存
// 只更新同一个字段；API 不追加匿名数组项，也不会把候选审核状态当作人工真值。
export const vlmBlindLabelStageSchema = z.enum(['first', 'second', 'final'])
export const vlmBlindConditionLabelInputSchema = z
  .object({
    verdict: vlmReviewVerdictSchema,
    notes: z.string().max(1000).optional(),
  })
  .strict()

// 视觉授权必须回传刚刚只读 preflight 的内容指纹，防止用户确认 A 输入后，Server
// 实际执行已经漂移的 B 输入。授权只覆盖当前 Phase F 能力盲测，不覆盖 AgentIntent。
export const vlmBlindVisualAuthorizationInputSchema = z
  .object({
    confirmed: z.literal(true),
    preflight_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    max_calls: z.number().int().min(1).max(84),
    max_cost_cny: z.number().positive().max(5),
    expires_in_minutes: z.number().int().min(5).max(1440).default(60),
  })
  .strict()

export const vlmBlindRetryUnknownInputSchema = z
  .object({
    confirmed: z.literal(true),
    reason: z.string().min(1).max(500),
  })
  .strict()

// Agent V1 是 Server 控制的固定状态机。模型输出和 API 输入都只能使用这些状态，
// 不能自造“思考中”或跳过等待授权边界的状态。
export const agentRunStatusSchema = z.enum([
  'queued',
  'extracting_intent',
  'waiting_for_user_input',
  'searching',
  // 本地 RRF 候选已经冻结，但最终 Rerank 尚未完成。该状态不是终态，普通用户
  // 只能看到进度；完整 RRF 候选只通过只读审计接口提供。
  'ranking',
  'waiting_for_export_selection',
  'waiting_for_confirmation',
  'succeeded',
  'failed',
  'timed_out',
  'completed_with_errors',
  'cancel_requested',
  'cancelled',
  'expired',
  'outcome_unknown',
])

export const agentNextStepSchema = z.enum(['extracting_intent', 'searching', 'reranking'])
export const agentExternalCallStatusSchema = z.enum([
  'not_dispatched',
  'dispatched',
  'completed',
  'outcome_unknown',
])

const agentConditionSchema = z
  .object({
    source_text: unicodeStringSchema('source_text', 200),
    kind: z.enum(['must_have', 'optional', 'exclusion']),
    evidence_type: z.enum(['visual', 'spoken', 'metadata', 'unknown']),
  })
  .strict()

// AgentIntent 只分类用户原文中的意图和条件，故意没有 query 字段。
// Phase B 将校验 source_text 是原 prompt 的连续子串，检索仍使用完整原文。
export const agentIntentSchema = z
  .object({
    goal: z.enum(['search', 'inspect', 'export_clip']),
    search_scope: z.enum(['visual', 'spoken', 'all']),
    media_types: z.array(z.enum(mediaTypes)).max(4),
    library_references: z.array(unicodeStringSchema('library_reference', 200)).max(10),
    conditions: z.array(agentConditionSchema).max(30),
    needs_clarification: z.boolean(),
    clarification_reason: unicodeStringSchema('clarification_reason', 500).nullable(),
    requested_effect: z
      .object({
        type: z.literal('export_clip'),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((intent, context) => {
    for (const kind of ['must_have', 'optional', 'exclusion'] as const) {
      if (intent.conditions.filter((condition) => condition.kind === kind).length > 10) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${kind} conditions must contain at most 10 items`,
          path: ['conditions'],
        })
      }
    }
  })

export const createAgentRunInputSchema = z
  .object({
    prompt: unicodeStringSchema('prompt', 4000),
    // 客户端明确选择时是硬范围；省略才由意图模型解析，不能悄悄从词语全文改为画面搜索。
    search_scope: z.enum(['visual', 'spoken', 'all']).optional(),
    // 文本和视觉授权必须分开。允许发 prompt 不等于允许发候选帧。
    allow_external_text: z.boolean(),
    workflow: z.enum(['retrieval_agent', 'legacy']).optional().default('retrieval_agent'),
    allow_external_media_text: z.boolean().optional().default(false),
    allow_external_visual: z.boolean().optional().default(false),
    // RightAPI场景看图与百炼最终重排是两个目的地，必须分别授权。
    allow_external_scene_visual: z.boolean().optional().default(false),
    // 20候选单帧图文决策，与3候选额外帧观察及最终重排独立授权。
    allow_external_retrieval_visual: z.boolean().optional().default(false),
    library_ids: z.array(uuidSchema).max(100).optional().default([]),
    media_types: z.array(z.enum(mediaTypes)).max(4).optional().default([]),
  })
  .strict()

export const resumeAgentRunInputSchema = z
  .object({
    waiting_step_id: uuidSchema,
    client_request_id: z.string().min(1).max(200),
    // Phase B 不允许模型二次解释自由文本；该动作明确覆盖为无副作用只读搜索。
    response: unicodeStringSchema('response', 2000),
    allow_external_media_text: z.boolean().optional(),
    // 最终图片重排的独立授权；自由文本不能代替这个字段。
    allow_external_visual: z.boolean().optional(),
    allow_external_scene_visual: z.boolean().optional(),
    allow_external_retrieval_visual: z.boolean().optional(),
  })
  .strict()

export const cancelAgentRunInputSchema = z
  .object({
    client_request_id: z.string().min(1).max(200),
    reason: unicodeStringSchema('reason', 500).optional(),
  })
  .strict()

export const retryUnknownAgentRunInputSchema = z
  .object({
    step_attempt_id: uuidSchema,
    client_request_id: z.string().min(1).max(200),
  })
  .strict()

// Phase C 的选择请求只接受冻结候选身份和场景内时间范围。输出格式在 V1 冻结为 mp4，
// 浏览器不能提交任意输出路径或 FFmpeg 参数。
export const agentExportSelectionInputSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    start_time_seconds: nonNegativeNumberSchema,
    end_time_seconds: positiveNumberSchema,
    output_format: z.literal('mp4').default('mp4'),
  })
  .strict()
  .refine((input) => input.end_time_seconds > input.start_time_seconds, {
    message: 'end_time_seconds must be greater than start_time_seconds',
    path: ['end_time_seconds'],
  })

export const confirmAgentExportInputSchema = z
  .object({
    waiting_step_id: uuidSchema,
    tool_call_id: z.string().min(1).max(300),
    client_request_id: z.string().min(1).max(200),
  })
  .strict()

export const agentErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    retryable: z.boolean(),
  })
  .strict()

// 这里是跨语言 job 协议的事实来源：NestJS 创建 job，Python worker 读取生成的 JSON Schema 校验输入。
// 新 job type 必须先在这里声明输入/输出，再生成 packages/shared/generated/job-schemas.json。
export const jobTypeSchema = z.enum(jobTypes)

export const scanLibraryInputSchema = z.object({
  library_id: uuidSchema,
  root_path: z.string().min(1),
  scan_mode: z.enum(['mtime_size', 'full']),
})

export const scanLibraryOutputSchema = z.object({
  discovered: nonNegativeIntegerSchema,
  created: nonNegativeIntegerSchema,
  updated: nonNegativeIntegerSchema,
  skipped: nonNegativeIntegerSchema,
  failed: nonNegativeIntegerSchema,
})

export const probeMediaInputSchema = z.object({
  file_id: uuidSchema,
  path: z.string().min(1),
  media_type: z.enum(mediaTypes),
})

export const probeMediaOutputSchema = z.object({
  duration_seconds: nonNegativeNumberSchema.optional(),
  width: nonNegativeIntegerSchema.optional(),
  height: nonNegativeIntegerSchema.optional(),
  codec: z.string().min(1).optional(),
  streams: nonNegativeIntegerSchema,
})

// index_media 不再携带 segment_strategy：旧 fixed_30s fallback 已删除，视频索引只走
// PySceneDetect 场景检测；检测失败直接让任务失败，不再回退到固定窗口。
export const indexMediaInputSchema = z.object({
  file_id: uuidSchema,
  index_profile: indexProfileSchema,
})

// 输出不再有 segment_strategy / fallback / fallback_reason / keyframes_selected /
// keyframe_density：场景检测要么成功写出 video_scenes 与 video_frame，要么结构化失败。
export const indexMediaOutputSchema = z.object({
  assets_created: nonNegativeIntegerSchema,
  vector_refs_created: nonNegativeIntegerSchema,
  collections: z.array(collectionSchema),
  scenes_detected: nonNegativeIntegerSchema.optional(),
  frames_created: nonNegativeIntegerSchema.optional(),
})

export const transcribeAudioInputSchema = z.object({
  file_id: uuidSchema,
  path: z.string().min(1),
  media_type: z.enum(['video', 'audio']),
  model: z.string().min(1).default('base'),
  language: z.string().min(1).default('auto'),
})

export const transcribeAudioOutputSchema = z.object({
  chunks_created: nonNegativeIntegerSchema,
  language: z.string().min(1),
  duration_seconds: nonNegativeNumberSchema.optional(),
})

export const embedImageInputSchema = z.object({
  asset_id: uuidSchema,
  path: z.string().min(1),
  collection: z.literal('image_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

// 视频帧向量只写入 video_frame_vectors；video_segment_vectors 集合已删除（场景不再有独立向量点）。
export const embedVideoFrameInputSchema = z.object({
  asset_id: uuidSchema,
  frame_path: z.string().min(1),
  frame_time_seconds: nonNegativeNumberSchema.optional(),
  collection: z.literal('video_frame_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const embedTextAssetInputSchema = z.object({
  asset_id: uuidSchema,
  collection: z.literal('caption_text_vectors'),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

// generate_caption 支持两种来源，由 prompt_version 决定（Worker 侧强制）：
// - caption-v1（图片）：source_asset_ids 给出图片 asset，无 scene_id。
// - scene-caption-v2（视频场景）：scene_id 给出正式 video_scenes.id，Worker 通过它取按时间
//   排序的场景帧；不再接受 video_segment 来源，也不再从 metadata_json.scene_id 解析。
export const generateCaptionInputSchema = z.object({
  file_id: uuidSchema,
  prompt_version: z.enum(['caption-v1', 'scene-caption-v2']).default('caption-v1'),
  source_asset_ids: z.array(uuidSchema).min(1).optional(),
  scene_id: uuidSchema.optional(),
  model_name: z.string().min(1).default('Qwen/Qwen2.5-VL-7B-Instruct'),
  model_version: z.string().min(1).default('qwen2.5-vl-7b-instruct'),
})

export const embeddingOutputSchema = z.object({
  point_id: uuidSchema,
  collection: collectionSchema,
  vector_dim: z.number().int().positive(),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
})

export const generateCaptionOutputSchema = z.object({
  caption_asset_id: uuidSchema,
  source_assets: z.array(uuidSchema).min(1),
  text_written: nonNegativeIntegerSchema,
  vector_ref_created: z.boolean().optional(),
})

export const candidateEvidenceStrategySchema = z.enum(['contact_sheet_v1', 'all_indexed_frames_v1'])

// 证据 Job 只携带冻结候选的稳定身份与小型协议选择。源视频路径、图片字节、Caption、
// 转录和向量都由 Worker 在本地重新读取 PostgreSQL 事实，绝不能穿过跨语言 Job 参数。
export const buildCandidateEvidenceInputSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    file_id: uuidSchema,
    file_generation: nonNegativeIntegerSchema,
    asset_id: uuidSchema,
    scene_id: uuidSchema,
    strategies: z.array(candidateEvidenceStrategySchema).min(1).max(2),
  })
  .strict()
  .refine((input) => new Set(input.strategies).size === input.strategies.length, {
    message: 'strategies must not contain duplicates',
    path: ['strategies'],
  })

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const candidateEvidenceManifestSchema = z
  .object({
    candidate_key: z.string().min(1).max(300),
    file_id: uuidSchema,
    file_generation: nonNegativeIntegerSchema,
    asset_id: uuidSchema,
    scene_id: uuidSchema,
    frame_asset_ids: z.array(uuidSchema).min(1).max(12),
    frame_time_seconds: z.array(nonNegativeNumberSchema.finite()).min(1).max(12),
    strategy: candidateEvidenceStrategySchema,
    protocol_version: z.literal('candidate-evidence-v1'),
    frame_count: z.number().int().min(1).max(12),
    input_sha256: sha256Schema,
    artifact_sha256: sha256Schema,
    // artifact_id 是受控 API 标识，不是文件系统路径；浏览器只能经 Server 读取成功证据。
    artifact_id: z.string().regex(/^candidate-evidence\/[0-9a-f-]{36}\/artifact$/),
    protocol_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    format: z.enum(['png', 'json']),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    byte_size: z.number().int().positive(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.frame_count !== manifest.frame_asset_ids.length ||
      manifest.frame_count !== manifest.frame_time_seconds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frame_count must match frame ids and times',
        path: ['frame_count'],
      })
    }
    if (
      manifest.strategy === 'contact_sheet_v1' &&
      (manifest.format !== 'png' || manifest.width === null || manifest.height === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contact_sheet_v1 requires PNG dimensions',
        path: ['format'],
      })
    }
    if (
      manifest.strategy === 'all_indexed_frames_v1' &&
      (manifest.format !== 'json' || manifest.width !== null || manifest.height !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'all_indexed_frames_v1 is a dimensionless JSON artifact',
        path: ['format'],
      })
    }
  })

export const buildCandidateEvidenceOutputSchema = z
  .object({
    evidence_ids: z.array(uuidSchema).min(1).max(2),
    manifests: z.array(candidateEvidenceManifestSchema).min(1).max(2),
  })
  .strict()

export const exportClipInputSchema = z
  .object({
    file_id: uuidSchema,
    start_time_seconds: nonNegativeNumberSchema,
    end_time_seconds: positiveNumberSchema,
    output_format: z.enum(['mp4', 'mov']).default('mp4'),
    // Agent 确认使用稳定 UUID 生成唯一输出名；旧的 Media Detail 导出没有该字段，
    // 因此保持可选以维持已有 API 契约。
    export_request_id: uuidSchema.optional(),
  })
  .refine((input) => input.end_time_seconds > input.start_time_seconds, {
    message: 'end_time_seconds must be greater than start_time_seconds',
    path: ['end_time_seconds'],
  })

export const exportClipOutputSchema = z.object({
  export_path: z.string().min(1),
  duration_seconds: positiveNumberSchema,
})

// purge_video_index：单文件破坏性重索引。Server 在确认无活跃媒体任务后创建该任务；
// Worker 先删 Qdrant points，再在 PostgreSQL 事务中删除场景/帧/Caption/Vector Ref 等派生数据，
// 条件递增 index_generation（仅在文件仍为 purge_queued 时），然后把文件状态翻回 pending。
// 失败必须可安全重试：Qdrant/PG 清理都幂等，generation 递增受状态条件保护不重复。
export const purgeVideoIndexInputSchema = z.object({
  file_id: uuidSchema,
})

export const purgeVideoIndexOutputSchema = z.object({
  points_deleted: nonNegativeIntegerSchema,
  vector_refs_deleted: nonNegativeIntegerSchema,
  assets_deleted: nonNegativeIntegerSchema,
  scenes_deleted: nonNegativeIntegerSchema,
  index_generation: nonNegativeIntegerSchema,
  reindex_job_created: z.boolean(),
})

export const jobInputSchemas = {
  scan_library: scanLibraryInputSchema,
  probe_media: probeMediaInputSchema,
  index_media: indexMediaInputSchema,
  purge_video_index: purgeVideoIndexInputSchema,
  transcribe_audio: transcribeAudioInputSchema,
  embed_image: embedImageInputSchema,
  embed_video_frame: embedVideoFrameInputSchema,
  embed_text_asset: embedTextAssetInputSchema,
  generate_caption: generateCaptionInputSchema,
  build_candidate_evidence: buildCandidateEvidenceInputSchema,
  export_clip: exportClipInputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>

// 输出 schema 主要用于文档和测试一致性；worker 写 result_json，server/web 只按稳定字段展示。
export const jobOutputSchemas = {
  scan_library: scanLibraryOutputSchema,
  probe_media: probeMediaOutputSchema,
  index_media: indexMediaOutputSchema,
  purge_video_index: purgeVideoIndexOutputSchema,
  transcribe_audio: transcribeAudioOutputSchema,
  embed_image: embeddingOutputSchema,
  embed_video_frame: embeddingOutputSchema,
  embed_text_asset: embeddingOutputSchema,
  generate_caption: generateCaptionOutputSchema,
  build_candidate_evidence: buildCandidateEvidenceOutputSchema,
  export_clip: exportClipOutputSchema,
} satisfies Record<z.infer<typeof jobTypeSchema>, z.ZodTypeAny>

export { retrievalActionSchema, retrievalActionJsonSchema, RETRIEVAL_EVIDENCE_LIMITS, retrievalOverviewSchema,
  type RetrievalOverview, type RetrievalAction } from './retrieval-agent.js'

export { retrievalQualityQualificationSchema, type RetrievalQualityQualification } from './retrieval-agent.js'
export { retrievalSourceMatchSchema, type RetrievalSourceMatch, MATCHED_EVIDENCE_LIMITS, retrievalMatchedActionSchema, retrievalMatchedActionJsonSchema } from './retrieval-agent.js'
export { retrievalMatchedEvidenceSchema, type RetrievalMatchedEvidence } from './retrieval-agent.js'
export { MATCHED_DECISION_POLICY_VERSION, retrievalStopBasisSchema, type RetrievalStopBasis } from './retrieval-agent.js'

export { retrievalVisualVerificationSchema, type RetrievalVisualVerification } from './retrieval-agent.js'

export { sceneObservationSchema, sceneObservationJsonSchema, sceneObservationNormalizationSchema, SCENE_INSPECTION_LIMITS, type SceneObservationNormalization, type SceneObservation } from './retrieval-agent.js'
