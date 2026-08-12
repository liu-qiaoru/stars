import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { agentIntentSchema } from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  agentRunSteps,
  agentRunAuthorizations,
  agentRunInputs,
  libraries,
  mediaAssets,
  mediaFiles,
  videoScenes,
} from '../database/schema.js'
import { SearchService } from '../search/search.service.js'
import {
  AGENT_INTENT_RUNNER,
  type AgentIntentRunner,
  type ValidatedAgentIntent,
} from './qwen-agent-intent.runner.js'
import { AgentStepExecutionError } from './agent.types.js'
import type { AgentStepHandler, FrozenAgentCandidate, PreparedAgentStep } from './agent.types.js'
import { AgentRuntimeConfigService } from './agent-runtime-config.service.js'

const supportedSearchMediaTypes = ['image', 'video', 'audio'] as const
type SupportedSearchMediaType = (typeof supportedSearchMediaTypes)[number]

const enforcedScopeSchema = z
  .object({
    library_ids: z.array(z.string().uuid()),
    media_types: z.array(z.enum(['image', 'video', 'audio', 'document'])),
  })
  .strict()

const storedIntentOutputSchema = z
  .object({
    intent: agentIntentSchema,
    conditions: z.array(
      z
        .object({
          condition_id: z.string().uuid(),
          source_text: z.string(),
          normalized_source_text: z.string(),
          kind: z.enum(['must_have', 'optional', 'exclusion']),
          evidence_type: z.enum(['visual', 'spoken', 'metadata', 'unknown']),
        })
        .strict(),
    ),
    enforced_scope: z
      .object({
        search_scope: z.enum(['visual', 'spoken', 'all']),
        media_types: z.array(z.enum(supportedSearchMediaTypes)),
        library_ids: z.array(z.string().uuid()),
      })
      .strict(),
    provider: z.object({
      model: z.string(),
      prompt_version: z.string(),
      schema_version: z.string(),
      request_id: z.string(),
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
    }),
  })
  .strict()

const searchCandidateSchema = z
  .object({
    asset_id: z.string().uuid(),
    file_id: z.string().uuid(),
    media_type: z.enum(supportedSearchMediaTypes),
    start_time_seconds: z.number().nullable(),
    end_time_seconds: z.number().nullable(),
    scene_id: z.string().uuid().nullable(),
    best_frame_time_seconds: z.number().nullable(),
    score: z.number(),
    score_kind: z.literal('rrf_score'),
    primary_reason: z.enum(['vector_match', 'caption_match', 'transcript_match']),
    reasons: z.array(z.enum(['vector_match', 'caption_match', 'transcript_match'])),
    source_scores: z.record(z.string(), z.number()),
  })
  .passthrough()

function failStep(code: string, message: string): never {
  throw new AgentStepExecutionError(code, message)
}

/**
 * Phase B 的固定两步工作流：一次外部 AgentIntent，再一次本地 SearchService 搜索。
 * 模型不拥有 SearchService，也不会接触搜索候选；步骤顺序只由 PostgreSQL next_step 决定。
 */
@Injectable()
export class AgentV1StepHandler implements AgentStepHandler {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AGENT_INTENT_RUNNER) private readonly intentRunner: AgentIntentRunner,
    @Inject(SearchService) private readonly searchService: SearchService,
    @Optional() private readonly runtimeConfig?: AgentRuntimeConfigService,
  ) {}

  isReady() {
    return this.intentRunner.isReady()
  }

  async prepare(input: Parameters<AgentStepHandler['prepare']>[0]): Promise<PreparedAgentStep> {
    if (input.step === 'extracting_intent') {
      return this.prepareIntent(input)
    }
    if (input.step === 'searching') {
      return this.prepareSearch(input)
    }
    return failStep('AGENT_STEP_UNSUPPORTED', `不支持的 Agent V1 步骤：${String(input.step)}。`)
  }

  private async prepareIntent(
    input: Parameters<AgentStepHandler['prepare']>[0],
  ): Promise<PreparedAgentStep> {
    const scope = this.parseEnforcedScope(input.enforcedScope)
    if (scope.media_types.includes('document')) {
      // 兼容迁移前已经排队的 run：即使它绕过了当前创建接口，也要在 Provider 派发前拒绝，
      // 不能先发送 prompt 再等模型输出后才发现 Phase B 不支持 document。
      failStep('AGENT_MEDIA_SCOPE_UNSUPPORTED', 'Agent V1 Phase B 不支持 document 检索。')
    }
    const [authorization] = await this.db
      .select({
        allowExternalText: agentRunAuthorizations.allowExternalText,
        textScopeJson: agentRunAuthorizations.textScopeJson,
      })
      .from(agentRunAuthorizations)
      .where(eq(agentRunAuthorizations.runId, input.runId))
      .limit(1)
    const authorizedFields = z
      .object({
        fields: z
          .array(z.string())
          .length(2)
          .refine(
            (fields) =>
              fields.includes('user_prompt') && fields.includes('deidentified_capability_boundary'),
          ),
      })
      .strict()
      .safeParse(authorization?.textScopeJson)
    if (!authorization?.allowExternalText || !authorizedFields.success) {
      failStep(
        'AGENT_EXTERNAL_TEXT_AUTHORIZATION_INVALID',
        '本 run 的外部文本授权缺失或与 Phase B 外发字段不匹配。',
      )
    }
    const runnerInput = {
      userPrompt: input.prompt,
      capabilityBoundary: {
        // 只发送媒体类型能力和“是否有硬素材库范围”这一布尔值；不发送 UUID 或名称。
        allowedMediaTypes: scope.media_types.length
          ? scope.media_types
          : [...supportedSearchMediaTypes],
        hasEnforcedLibraryScope: scope.library_ids.length > 0,
      },
    }
    return {
      external: true,
      inputFingerprint: this.intentRunner.fingerprint(runnerInput),
      execute: async () => {
        const validated = await this.intentRunner.extract(runnerInput)
        const enforcedScope = await this.resolveScope(validated, scope)
        const outputJson = {
          intent: validated.intent,
          // condition_id 由 Server 生成并随已校验条件一起持久化；模型无权自造数据库身份。
          conditions: validated.conditions.map((condition) => ({
            condition_id: randomUUID(),
            ...condition,
          })),
          enforced_scope: enforcedScope,
          provider: validated.provider,
        }
        if (validated.intent.needs_clarification) {
          return {
            transition: {
              status: 'waiting_for_user_input',
              nextStep: 'searching',
              waitingStepId: randomUUID(),
              waitingExpiresAt: new Date(
                Date.now() +
                  (this.runtimeConfig?.values().waiting_ttl_seconds ??
                    this.settings.agentWaitingTtlSeconds) *
                    1000,
              ),
            },
            outputJson,
          }
        }
        return {
          transition: { status: 'searching', nextStep: 'searching' },
          outputJson,
        }
      },
    }
  }

  private async prepareSearch(
    input: Parameters<AgentStepHandler['prepare']>[0],
  ): Promise<PreparedAgentStep> {
    const intentOutput = await this.loadCommittedIntent(input.runId)
    if (intentOutput.intent.needs_clarification) {
      const [clarification] = await this.db
        .select({ responseJson: agentRunInputs.responseJson })
        .from(agentRunInputs)
        .where(
          and(eq(agentRunInputs.runId, input.runId), eq(agentRunInputs.inputType, 'clarification')),
        )
        .orderBy(desc(agentRunInputs.createdAt))
        .limit(1)
      const accepted = z
        .object({
          response: z.literal('continue_as_read_only_search_with_resolved_scope'),
        })
        .strict()
        .safeParse(clarification?.responseJson)
      if (!accepted.success) {
        failStep(
          'AGENT_CLARIFICATION_NOT_CONFIRMED',
          '需要澄清的 run 缺少“按只读搜索和已解析范围继续”的固定确认。',
        )
      }
    }
    return {
      external: false,
      execute: async () => {
        // query 保持用户提交的完整原文；original 明确绕过 DeepSeek 查询扩展，rrf 固定排序。
        const response = await this.searchService.search({
          query: input.prompt,
          query_expansion_mode: 'original',
          ranking_mode: 'rrf',
          search_scope: intentOutput.enforced_scope.search_scope,
          media_types: intentOutput.enforced_scope.media_types,
          library_ids: intentOutput.enforced_scope.library_ids,
          limit: 20,
          offset: 0,
          include_diagnostics: false,
        })
        const candidates = await this.freezeCandidates(
          response.results,
          intentOutput.enforced_scope,
        )
        const expectsExport =
          intentOutput.intent.goal === 'export_clip' &&
          intentOutput.intent.requested_effect?.type === 'export_clip'
        return {
          transition: expectsExport
            ? {
                status: 'waiting_for_export_selection',
                waitingStepId: randomUUID(),
                waitingExpiresAt: new Date(
                  Date.now() +
                    (this.runtimeConfig?.values().waiting_ttl_seconds ??
                      this.settings.agentWaitingTtlSeconds) *
                      1000,
                ),
              }
            : { status: 'succeeded' },
          outputJson: {
            candidate_count: candidates.length,
            enforced_scope: intentOutput.enforced_scope,
          },
          candidates,
        }
      },
    }
  }

  private parseEnforcedScope(raw: unknown) {
    const parsed = enforcedScopeSchema.safeParse(raw)
    if (!parsed.success) {
      return failStep('AGENT_ENFORCED_SCOPE_INVALID', '持久化的 Agent enforced_scope 无效。')
    }
    return parsed.data
  }

  private async resolveScope(
    validated: ValidatedAgentIntent,
    enforced: z.infer<typeof enforcedScopeSchema>,
  ) {
    const intent = validated.intent
    const allowedByScope: Record<typeof intent.search_scope, SupportedSearchMediaType[]> = {
      visual: ['image', 'video'],
      spoken: ['audio', 'video'],
      all: [...supportedSearchMediaTypes],
    }
    if (intent.media_types.some((mediaType) => mediaType === 'document')) {
      failStep('AGENT_MEDIA_SCOPE_UNSUPPORTED', 'Agent V1 不支持 document 检索。')
    }
    const requestedMediaTypes = intent.media_types as SupportedSearchMediaType[]
    const scopeMediaTypes = allowedByScope[intent.search_scope]
    if (requestedMediaTypes.some((mediaType) => !scopeMediaTypes.includes(mediaType))) {
      failStep('AGENT_MEDIA_SCOPE_INVALID', 'AgentIntent media_types 超出 search_scope。')
    }
    // search_scope 与客户端预选都是硬约束，最终媒体类型只能取两者交集。例如客户端只
    // 允许 image 而模型选择 spoken 时没有合法通道，必须失败，不能把 image 交给语音检索。
    const hardMediaTypes = enforced.media_types.length
      ? (enforced.media_types as SupportedSearchMediaType[]).filter((mediaType) =>
          scopeMediaTypes.includes(mediaType),
        )
      : scopeMediaTypes
    if (enforced.media_types.length && !hardMediaTypes.length) {
      failStep('AGENT_MEDIA_SCOPE_INVALID', 'AgentIntent search_scope 与 Server 媒体范围不相容。')
    }
    const mediaTypes = requestedMediaTypes.length ? requestedMediaTypes : hardMediaTypes
    if (mediaTypes.some((mediaType) => !hardMediaTypes.includes(mediaType))) {
      failStep('AGENT_ENFORCED_SCOPE_EXCEEDED', 'AgentIntent 媒体范围超出 Server enforced_scope。')
    }

    const libraryIds = await this.resolveLibraryReferences(
      intent.library_references,
      enforced.library_ids,
    )
    return {
      search_scope: intent.search_scope,
      media_types: mediaTypes,
      library_ids: libraryIds,
    }
  }

  private async resolveLibraryReferences(references: string[], enforcedLibraryIds: string[]) {
    if (!references.length) return enforcedLibraryIds
    const rows = await this.db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries)
      .where(
        and(
          inArray(libraries.name, [...new Set(references)]),
          eq(libraries.status, 'active'),
          isNull(libraries.deletedAt),
        ),
      )
    const byName = new Map<string, string[]>()
    for (const row of rows) {
      byName.set(row.name, [...(byName.get(row.name) ?? []), row.id])
    }
    const resolved = references.map((reference) => {
      const matches = byName.get(reference) ?? []
      if (matches.length !== 1) {
        failStep('AGENT_LIBRARY_REFERENCE_INVALID', 'AgentIntent 素材库名称不存在或不唯一。')
      }
      return matches[0]!
    })
    if (
      enforcedLibraryIds.length &&
      resolved.some((libraryId) => !enforcedLibraryIds.includes(libraryId))
    ) {
      failStep(
        'AGENT_ENFORCED_SCOPE_EXCEEDED',
        'AgentIntent 素材库范围超出 Server enforced_scope。',
      )
    }
    return [...new Set(resolved)]
  }

  private async loadCommittedIntent(runId: string) {
    const [row] = await this.db
      .select({ outputJson: agentRunSteps.outputJson })
      .from(agentRunSteps)
      .where(
        and(
          eq(agentRunSteps.runId, runId),
          eq(agentRunSteps.stepKind, 'extracting_intent'),
          eq(agentRunSteps.status, 'completed'),
        ),
      )
      .orderBy(desc(agentRunSteps.createdAt))
      .limit(1)
    const parsed = storedIntentOutputSchema.safeParse(row?.outputJson)
    if (!parsed.success) {
      return failStep('AGENT_INTENT_STATE_INVALID', '搜索步骤缺少已提交且有效的 AgentIntent。')
    }
    return parsed.data
  }

  private async freezeCandidates(
    rawResults: unknown[],
    enforcedScope: z.infer<typeof storedIntentOutputSchema>['enforced_scope'],
  ): Promise<FrozenAgentCandidate[]> {
    const parsedCandidates = z.array(searchCandidateSchema).safeParse(rawResults)
    if (!parsedCandidates.success) {
      return failStep('AGENT_SEARCH_RESPONSE_INVALID', 'SearchService 返回了无法冻结的候选结构。')
    }
    const parsed = parsedCandidates.data
    const fileIds = [...new Set(parsed.map((candidate) => candidate.file_id))]
    if (!fileIds.length) return []
    const fileRows = await this.db
      .select({
        id: mediaFiles.id,
        libraryId: mediaFiles.libraryId,
        mediaType: mediaFiles.mediaType,
        indexGeneration: mediaFiles.indexGeneration,
      })
      .from(mediaFiles)
      .where(and(inArray(mediaFiles.id, fileIds), isNull(mediaFiles.deletedAt)))
    const files = new Map(fileRows.map((file) => [file.id, file]))
    if (files.size !== fileIds.length) {
      failStep('AGENT_CANDIDATE_STALE', '搜索候选文件在快照提交前已失效。')
    }

    const assetIds = [...new Set(parsed.map((candidate) => candidate.asset_id))]
    const assetRows = await this.db
      .select({ id: mediaAssets.id, fileId: mediaAssets.fileId, sceneId: mediaAssets.sceneId })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, assetIds))
    const assets = new Map(assetRows.map((asset) => [asset.id, asset]))
    const sceneIds = parsed.flatMap((candidate) => (candidate.scene_id ? [candidate.scene_id] : []))
    const sceneRows = sceneIds.length
      ? await this.db
          .select()
          .from(videoScenes)
          .where(inArray(videoScenes.id, [...new Set(sceneIds)]))
      : []
    const scenes = new Map(sceneRows.map((scene) => [scene.id, scene]))

    return parsed.map((candidate, index) => {
      const file = files.get(candidate.file_id)
      const generation = file?.indexGeneration
      const asset = assets.get(candidate.asset_id)
      if (
        generation === undefined ||
        !file ||
        !asset ||
        asset.fileId !== candidate.file_id ||
        file.mediaType !== candidate.media_type ||
        asset.sceneId !== candidate.scene_id
      ) {
        failStep('AGENT_CANDIDATE_STALE', '搜索候选 Asset 身份在快照提交前发生变化。')
      }
      if (
        !enforcedScope.media_types.includes(file.mediaType as SupportedSearchMediaType) ||
        (enforcedScope.library_ids.length > 0 &&
          !enforcedScope.library_ids.includes(file.libraryId))
      ) {
        failStep('AGENT_ENFORCED_SCOPE_EXCEEDED', '搜索候选超出已校验的 Server 范围。')
      }
      if (candidate.scene_id) {
        const scene = scenes.get(candidate.scene_id)
        if (
          !scene ||
          scene.fileId !== candidate.file_id ||
          scene.indexGeneration !== generation ||
          Number(scene.startTimeSeconds) !== candidate.start_time_seconds ||
          Number(scene.endTimeSeconds) !== candidate.end_time_seconds
        ) {
          failStep('AGENT_CANDIDATE_STALE', '搜索候选场景版本在快照提交前发生变化。')
        }
      }
      return {
        candidateKey: candidate.scene_id
          ? `video:${candidate.scene_id}`
          : `${candidate.media_type}:${candidate.asset_id}`,
        fileId: candidate.file_id,
        fileGeneration: generation,
        assetId: candidate.asset_id,
        sceneId: candidate.scene_id,
        sceneStartSeconds: candidate.start_time_seconds,
        sceneEndSeconds: candidate.end_time_seconds,
        rank: index + 1,
        retrievalJson: {
          score: candidate.score,
          score_kind: candidate.score_kind,
          primary_reason: candidate.primary_reason,
          reasons: candidate.reasons,
          source_scores: candidate.source_scores,
          best_frame_time_seconds: candidate.best_frame_time_seconds,
        },
      }
    })
  }
}
