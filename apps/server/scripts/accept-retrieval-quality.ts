import { MatchedEvidenceTool } from '../src/agent/matched-evidence.tool.js'
import { sofaPhoneDiagnosticSnapshot, sofaPhoneApproval, sofaPhoneSelectionControlAllowed } from './retrieval-sofa-phone-authorization.js'
import type { RetrievalDecisionImage, RetrievalDecisionRunner } from '../src/agent/retrieval-decision.runner.js'
import { SceneInspectionTool } from '../src/agent/scene-inspection.tool.js'
import { MediaThumbnailService, runFfmpegThumbnail } from '../src/media/media-thumbnail.service.js'
import { saveVerificationLedger, reloadVerificationLedger, verificationAttemptsReady, textOnlyMessages, mediaResultsAuthorized, matchedPositionSupplementCostLimit } from './retrieval-verification-ledger.js'
import { retrievalBudget, retrievalBudgetStop, verificationCostFits } from '../src/agent/retrieval-budget.policy.js'
import { AgentStepExecutionError } from '../src/agent/agent.types.js'
import { RetrievalSelectionService } from '../src/agent/retrieval-selection.service.js'
/**
 * 用户 2026-10-05 授权的有界真实验收：生产库连接强制只读，任务/授权/步骤只写隔离 PGlite。
 * 先派发记账，再请求模型；未知结果或无用量时停止，重启脚本不能自动重放。
 * 不启动生产执行器，不修改影子评测额度。每个任务独立记录文字和图片授权。
 */
import { corpusFingerprint } from './retrieval-quality-corpus.js'
import { buildLocalReviewEvidence } from './retrieval-review-evidence.js'
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { Pool } from 'pg'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { QdrantClient } from '@qdrant/js-client-rest'
import { createTestDatabase } from '../tests/database/test-db.js'
import { createSettings } from '../src/config/settings.js'
import * as schema from '../src/database/schema.js'
import type { Database } from '../src/database/repositories.js'
import { SearchService } from '../src/search/search.service.js'
import { SearchQueryVectorService } from '../src/search/search-query-vector.service.js'
import { QueryExpansionService } from '../src/search/query-expansion.service.js'
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service.js'
import { QwenAgentIntentRunner } from '../src/agent/qwen-agent-intent.runner.js'
import { RightApiRetrievalDecisionRunner } from '../src/agent/retrieval-decision.runner.js'
import { AgentV1StepHandler } from '../src/agent/agent-v1-step.handler.js'
import { RetrievalAgentHandler } from '../src/agent/retrieval-agent.handler.js'
import { SegmentDetailsTool } from '../src/agent/segment-details.tool.js'
import { AgentExecutorService } from '../src/agent/agent-executor.service.js'
import { AgentRerankService } from '../src/agent/agent-rerank.service.js'
import { createAgentRerankProvider, type AgentRerankProvider } from '../src/agent/agent-rerank.provider.js'
import { AgentService } from '../src/agent/agent.service.js'
import { CandidateEvidenceService } from '../src/candidate-evidence/candidate-evidence.service.js'
import { createDurableAgentRun, getDurableAgentRun } from '../src/agent/agent-run.repository.js'
import { AGENT_RERANK_POLICY } from '../src/agent/agent-rerank.policy.js'

loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const caseId = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'cat'
const revision = Number(process.argv.find(arg => arg.startsWith('--revision='))?.slice(11) ?? 1)
if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid acceptance revision')
const artifactPrefix = revision === 1 ? caseId : `${caseId}-r${revision}`
const live = process.argv.includes('--live')
const matchedMode = process.argv.includes('--matched-evidence')
const deepseek = process.argv.includes('--deepseek')
// 新查询独立冻结，不能替换原六查询或借旧许可扩大素材池。
const diagnosticMode = caseId === 'sofa-phone'
if (diagnosticMode && (!deepseek || !matchedMode || revision < 48 || revision > 49)) throw new Error('Diagnostic protocol or revision invalid')
const reuseIntentFrom = process.argv.find(arg => arg.startsWith('--reuse-intent='))?.split('=')[1]
if (reuseIntentFrom && (!deepseek || !new RegExp(`^${caseId}-r[0-9]+$`).test(reuseIntentFrom))) throw new Error('Confirmed intent reuse requires same frozen DeepSeek case')
const scenePreflight = process.argv.includes('--scene-preflight')
const reuseReceived = process.argv.find(arg => arg.startsWith('--reuse-received='))?.split('=')[1]
if (reuseReceived && (!new RegExp(`^${caseId}-r[0-9]+$`).test(reuseReceived) || !process.argv.includes('--resume-confirmed'))) throw new Error('Confirmed response reuse requires same case and saved handoff')
const derivedSource = process.argv.find(arg => arg.startsWith('--reuse-derived='))?.split('=')[1]
if (derivedSource && !new RegExp(`^${caseId}-r[0-9]+$`).test(derivedSource)) throw new Error('Derived evidence must come from same frozen case')
const derivedSnapshot = derivedSource && caseId !== 'empty' ? JSON.parse(await readFile(`../../.scratch/retrieval-quality/${derivedSource}-baseline.json`, 'utf8')) : null
const reviewFramesFrom = process.argv.find(arg => arg.startsWith('--review-frames='))?.split('=')[1]
if (reviewFramesFrom && (!scenePreflight || live || !new RegExp(`^${caseId}-r[0-9]+$`).test(reviewFramesFrom))) throw new Error('Frame review is local-only for same frozen case')
const sceneVision = deepseek && !matchedMode && !process.argv.includes('--text-only') && !scenePreflight
if (scenePreflight && live) throw new Error('Scene preflight never uses live mode')
const localChain = process.argv.includes('--local-chain')
// 零外发链路单独允许新本地revision，避免覆盖已有真实响应；真实调用的交接要求不变。
if (deepseek && (revision < 30 || (!scenePreflight && !(localChain && !live) && !reuseReceived && !process.argv.includes('--prepare-handoff') && !diagnosticMode) || (process.argv.includes('--resume-confirmed') && !reuseReceived && !diagnosticMode))) throw new Error('DeepSeek verification requires fresh revision>=30 and local rerank handoff')
if (matchedMode && !localChain && !deepseek) throw new Error('Matched evidence live mode requires explicit DeepSeek selection and its independent material approval')
const batchProof = process.argv.includes('--overview-batch-proof')
if (batchProof && (live || !localChain || caseId !== 'cat' || revision !== 6))
  throw new Error('Overview/batch proof is a local-only cat revision 6; no paid authorization inferred')
// 独立选择实验明确使用本地决策替身：可验证真实候选/重排，不能声称GLM自主补搜。
const selectionControl = process.argv.includes('--selection-control')
if (live && localChain) throw new Error('Local chain forbids live mode')
const prepareHandoff = !reuseReceived && process.argv.includes('--prepare-handoff') || (selectionControl && !live)
if (prepareHandoff && !live && !selectionControl) throw new Error('Handoff preparation requires explicitly authorized GLM mode')
const resumeConfirmed = process.argv.includes('--resume-confirmed')
const diagnosticFrozen = diagnosticMode ? JSON.parse(await readFile(`${root}/sofa-phone/frozen.json`, 'utf8')) : null
const diagnostic = diagnosticFrozen ? sofaPhoneDiagnosticSnapshot(diagnosticFrozen) : null
const diagnosticApproval = diagnosticMode && live ? sofaPhoneApproval(JSON.parse(await readFile(`${root}/sofa-phone/live-approval.json`, 'utf8')),
  { fingerprint: diagnosticFrozen.corpus_fingerprint, freezeSha256: diagnosticFrozen.freeze_sha256, revision }) : null
const snapshot = diagnostic?.snapshot ?? JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const testCase = snapshot.cases.find((item: any) => item.id === caseId)
const approvedExtension = deepseek && !diagnosticMode ? JSON.parse(await readFile(`${root}/review-extension.json`, 'utf8')) : null
if (approvedExtension && approvedExtension.fingerprint !== snapshot.fingerprint) throw new Error('Frozen index approved media identities changed')
// 本次批准仅覆盖已人工标注素材。补搜可本地查询索引，越出授权身份的结果不能进入模型上下文。
const approvedMediaKeys = new Set<string>(diagnostic?.approved_keys ?? [...snapshot.cases.flatMap((c: any) => c.results.map((r: any) => r.scene_id ? `video:${r.scene_id}` : `image:${r.asset_id}`)), ...(approvedExtension?.cases ?? []).flatMap((c: any) => c.candidates.map((r: any) => r.candidate_key))])
// 只接受此次人工明确批准的单查询/单请求追加记录；不是可任意调高上限的配置。
// Schema仍以TypeScript为权威，JSON仅是聊天中已获授权事实的本地审计副本。
const additionalAuthorizationSchema = z.object({ source: z.literal('direct_user_approval'),
  authorized_on: z.literal('2026-10-05'), user_answer: z.literal('授权增加 1 次重排'),
  case_id: z.literal('exclusion'), query: z.literal('有人在厨房灶台前操作，不要空厨房'),
  request_sha256: z.literal('a60efed7d9bbe5aa6a35d26189e3a75e031bd78183de060e75cebd077f6c1813'),
  maximum_glm_calls: z.literal(24), maximum_product_rerank_calls: z.literal(5),
  maximum_total_cost_cny: z.literal(5), maximum_new_call_reserve_cny: z.literal(0.216),
}).strict()
let additionalAuthorization: z.infer<typeof additionalAuthorizationSchema> | null = null
try { additionalAuthorization = additionalAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/additional-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid additional authorization; no dispatch') }
// 尚未获批时此文件不存在。新增额度只能来自当前聊天直接授权，不能从计划或goal状态推断。
const nextAuthorizationSchema = z.object({ source: z.literal('direct_user_approval'),
  authorized_on: z.literal('2026-10-06'), user_answer: z.enum(['授权这批验证', '授权']), case_id: z.literal('cat'), revision: z.literal(3),
  query: z.literal('小猫趴在猫爬架上'), reuse_confirmed_intent_from: z.literal('cat-r2'),
  maximum_glm_calls: z.literal(29), maximum_product_rerank_calls: z.literal(7), maximum_total_cost_cny: z.literal(5),
  maximum_decision_request_bytes: z.literal(30000), maximum_model_calls_per_run: z.literal(5),
}).strict()
let nextAuthorization: z.infer<typeof nextAuthorizationSchema> | null = null
try { nextAuthorization = nextAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/next-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid next authorization; no dispatch') }
const nextBatch = Boolean(nextAuthorization && caseId === nextAuthorization.case_id && revision === nextAuthorization.revision)
// 修复后的下一版仅准备入口；没有单独的直接用户批准文件时，绝不继承已耗尽的GLM额度。
const repairAuthorizationSchema = nextAuthorizationSchema.extend({
  user_answer: z.enum(['授权修复复验', '授权', '为什么还是没有完成goal，继续执行']), revision: z.literal(4), maximum_glm_calls: z.literal(33),
  maximum_model_calls_per_run: z.literal(4), maximum_tool_calls_per_run: z.literal(9),
}).strict()
let repairAuthorization: z.infer<typeof repairAuthorizationSchema> | null = null
try { repairAuthorization = repairAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/repair-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid repair authorization; no dispatch') }
const repairBatch = Boolean(repairAuthorization && caseId === repairAuthorization.case_id && revision === repairAuthorization.revision)
const selectionControlAuthorizationSchema = z.object({ source: z.literal('direct_user_approval'),
  authorized_on: z.literal('2026-10-06'), user_answer: z.literal('授权调整这2次用途'),
  case_id: z.literal('cat'), revision: z.literal(5), query: z.literal('小猫趴在猫爬架上'),
  reuse_confirmed_intent_from: z.literal('cat-r2'), maximum_glm_calls: z.literal(33),
  maximum_product_rerank_calls: z.literal(7), maximum_total_cost_cny: z.literal(5),
  maximum_new_call_reserve_cny: z.literal(0.432), purpose: z.literal('local_selection_control_not_autonomous_glm'),
  baseline_request_sha256: z.literal('28416c27425ad0d0723803e569f9bedf6a11ad06687f6cedc47c759ee1b049e3'),
  experimental_request_sha256: z.literal('19fa4d0e5d45a4b02ead487a0b816adaf2965c4d46070bfea0171937d2832e04'),
}).strict()
let selectionControlAuthorization: z.infer<typeof selectionControlAuthorizationSchema> | null = null
try { selectionControlAuthorization = selectionControlAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/selection-control-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid selection control authorization; no dispatch') }
const controlBatch = Boolean(selectionControl && selectionControlAuthorization && caseId === 'cat' && revision === 5)
// 新版概要/批量复验必须有新直接授权，旧33/7额度不能被“继续”自动刷新。
const overviewAuthorizationSchema = z.object({ protocol: z.literal('overview-batch-reverification-v1'),
  authorized_on: z.literal('2026-10-06'), user_answer: z.string().min(1), case_id: z.literal('cat'), revision: z.literal(6),
  query: z.literal('小猫趴在猫爬架上'), fingerprint: z.literal(snapshot.fingerprint),
  maximum_glm_calls: z.literal(36), maximum_product_rerank_calls: z.literal(9), maximum_total_cost_cny: z.literal(5),
  maximum_decision_request_bytes: z.literal(48000), maximum_model_calls_per_run: z.literal(3),
  prior_glm_dispatches: z.literal(33), prior_rerank_dispatches: z.literal(7),
}).strict()
let overviewAuthorization: z.infer<typeof overviewAuthorizationSchema> | null = null
try { overviewAuthorization = overviewAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/overview-batch-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const overviewBatch = Boolean(overviewAuthorization && caseId === 'cat' && revision === 6)
if (selectionControl && !sofaPhoneSelectionControlAllowed(diagnosticApproval, { caseId, revision, live, localChain }) &&
  (caseId !== 'cat' || revision !== 5 || (live && !controlBatch) || localChain || resumeConfirmed))
  throw new Error('Selection control requires separately approved case/revision; no resume or mixed mode')
// 2026-10-06用户扩大累计预算至20元；工程次数上限是额外保守边界，绝非必须用满。
const goalAuthorizationSchema = z.object({ protocol: z.literal('goal-budget20-verification-v1'),
  source: z.literal('direct_user_approval'), authorized_on: z.literal('2026-10-06'),
  user_answer: z.literal('我授权多次真实glm调用，只要总费用不超过20，继续执行，完成goal'),
  fingerprint: z.literal(snapshot.fingerprint), case_ids: z.array(z.enum(['cat','action','position','exclusion','multi','empty'])),
  minimum_revision: z.literal(7), maximum_glm_calls: z.literal(73), maximum_product_rerank_calls: z.literal(19),
  maximum_total_cost_cny: z.literal(20), maximum_decision_request_bytes: z.literal(64000),
  maximum_model_calls_per_run: z.literal(6), maximum_tool_calls_per_run: z.literal(9),
  prior_glm_dispatches: z.literal(33), prior_rerank_dispatches: z.literal(7),
}).strict()
let goalAuthorization: z.infer<typeof goalAuthorizationSchema> | null = null
try { goalAuthorization = goalAuthorizationSchema.parse(JSON.parse(await readFile(`${root}/goal-budget20-authorization.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const goalBatch = Boolean(goalAuthorization && revision >= goalAuthorization.minimum_revision && goalAuthorization.case_ids.includes(caseId as any))
const authorizedBatch = goalBatch ? goalAuthorization : overviewBatch ? overviewAuthorization : controlBatch ? selectionControlAuthorization : repairBatch ? repairAuthorization : nextBatch ? nextAuthorization : null
const deepseekAuthorization = deepseek ? z.object({ protocol: z.literal('deepseek-scene-verification-v1'), source: z.literal('direct_user_message'),
  user_answer: z.literal('继续，授权新模型的10元调用，必须完成goal'), model: z.literal('deepseek-v4-flash'), fingerprint: z.literal(snapshot.fingerprint),
  maximum_new_calls: z.literal(59), maximum_deepseek_total_cost_cny: z.literal(10), maximum_historical_total_cost_cny: z.literal(20), maximum_product_rerank_calls: z.literal(19), maximum_request_bytes: z.literal(100000), maximum_model_calls_per_run: z.literal(5) }).passthrough()
  .parse(JSON.parse(await readFile(`${root}/deepseek-scene-authorization.json`, 'utf8'))) : null
// 新20×1用途只认本次聊天直接批准。原3×3记录与旧59次计划均保留，不改写历史授权。
const matchedApproval = diagnosticApproval ?? (matchedMode && live ? z.object({ source: z.literal('direct_user_reply'),
  authorized_on: z.literal('2026-10-07'), user_answer: z.literal('批准这批20候选命中图文用途'),
  protocol: z.literal('matched-multimodal-v1'), model: z.literal('deepseek-v4-flash'), fingerprint: z.literal(snapshot.fingerprint),
  case_ids: z.tuple([z.literal('cat'), z.literal('action'), z.literal('position'), z.literal('exclusion'), z.literal('multi'), z.literal('empty')]),
  minimum_revision: z.literal(42), maximum_new_calls: z.literal(12), prior_deepseek_agent_calls: z.literal(57),
  maximum_candidates: z.literal(20), maximum_frames_per_candidate: z.literal(1), maximum_texts_per_candidate: z.literal(2), maximum_characters_per_text: z.literal(1200),
  maximum_request_bytes: z.literal(750000), maximum_deepseek_total_cost_cny: z.literal(10), maximum_historical_total_cost_cny: z.literal(20),
  maximum_product_rerank_calls: z.literal(19), unknown_requests_replay: z.literal(false),
}).passthrough().parse(JSON.parse(await readFile('../../.scratch/deepseek-matched-retrieval/media-approval.json', 'utf8'))) : null)
if (matchedApproval && (revision < matchedApproval.minimum_revision || !(matchedApproval.case_ids as readonly string[]).includes(caseId))) throw new Error('Matched approval revision or case exceeded')
const maximumDeepseekAgentCalls = matchedApproval ? matchedApproval.prior_deepseek_agent_calls + matchedApproval.maximum_new_calls : deepseekAuthorization?.maximum_new_calls ?? 0
// 单次追加金额单独保存，不覆盖旧10元授权。只在持锁重读账本后启用。
let positionBudgetSupplement: unknown = null
let maximumDeepseekCost = 10
if (live && matchedMode && !resumeConfirmed && caseId === 'position' && revision === 47) {
  positionBudgetSupplement = JSON.parse(await readFile('../../.scratch/deepseek-matched-retrieval/position-budget12-approval.json', 'utf8'))
}
if (live && sceneVision) {
  z.object({ source: z.literal('direct_user_reply'), user_answer: z.enum(['批准以上素材、目的地和图片用途', '批准']), fingerprint: z.literal(snapshot.fingerprint), model: z.literal('deepseek-v4-flash') }).passthrough().parse(JSON.parse(await readFile(`${root}/deepseek-scene-media-approval.json`, 'utf8')))
}
const maximumDecisionBytes = matchedApproval?.maximum_request_bytes ?? (deepseek ? 100000 : authorizedBatch && 'maximum_decision_request_bytes' in authorizedBatch ? authorizedBatch.maximum_decision_request_bytes : authorizedBatch ? 30000 : 100000)
if (live && caseId === 'cat' && revision >= 3 && !authorizedBatch) throw new Error('Reviewed revision has no direct authorization; no dispatch')
const repairPreview = !live && caseId === 'cat' && revision === 4
const maximumTotalCost = diagnosticApproval?.maximum_historical_total_cost_cny ?? authorizedBatch?.maximum_total_cost_cny ?? 5
const maximumGlmCalls = authorizedBatch?.maximum_glm_calls ?? 24
const maximumRerankCalls = diagnosticApproval?.maximum_product_rerank_calls ?? authorizedBatch?.maximum_product_rerank_calls
  ?? (additionalAuthorization && caseId === additionalAuthorization.case_id ? additionalAuthorization.maximum_product_rerank_calls : 4)
// 真实查询只能来自执行前写入CALL-PLAN的冻结验收项；新增查询不刷新累计额度。
if (!testCase || (live && !diagnosticApproval && !goalBatch && !['cat', 'multi', 'action', 'position'].includes(caseId) &&
  !(caseId === 'exclusion' && (prepareHandoff || additionalAuthorization)))) throw new Error('Only pre-reviewed frozen cases may call external models')
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: live || localChain || selectionControl ? 'true' : 'false',
  AGENT_EXECUTOR_ENABLED: 'true', AGENT_MAX_STEPS: '6', AGENT_RETRIEVAL_MAX_RETRIES: '1',
  AGENT_TOOL_TIMEOUT_MS: '120000', AGENT_ACTIVITY_TIMEOUT_MS: '120000',
  AGENT_MODEL_TIMEOUT_MS: '60000', AGENT_LEASE_DURATION_MS: '130000',
  ...(nextBatch ? { AGENT_RETRIEVAL_MAX_MODEL_CALLS: '5' } : {}),
  // 原文1+补搜2+详情6共9个本地位置，模型仍只有4次；不强制用满，不修改产品.env。
  ...(repairBatch || repairPreview ? { AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '4' } : {}),
  ...(selectionControl ? { AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '6' } : {}),
  ...(batchProof ? { AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '3' } : {}),
  ...(goalBatch ? { AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '6' } : {}),
  ...(overviewBatch ? { AGENT_RETRIEVAL_MAX_TOOL_CALLS: '9', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '3' } : {}),
  ...(matchedMode ? { AGENT_RETRIEVAL_MODEL: 'deepseek-v4-flash', AGENT_RETRIEVAL_EVIDENCE_MODE: 'matched_multimodal', AGENT_RETRIEVAL_MAX_TOOL_CALLS: '4', AGENT_RETRIEVAL_MAX_MODEL_CALLS: '5' } : { AGENT_RETRIEVAL_EVIDENCE_MODE: 'overview' }),
  ...(deepseek ? { AGENT_RETRIEVAL_MODEL: 'deepseek-v4-flash', AGENT_SCENE_INSPECTION_ENABLED: sceneVision ? 'true' : 'false', AGENT_RETRIEVAL_MAX_MODEL_CALLS: String(deepseekAuthorization!.maximum_model_calls_per_run), AGENT_RETRIEVAL_MAX_RETRIES: '1' } : {}),
  // 此批3次包括意图；决策最多2次。只限隔离验收，产品配置不改变。
  ...(diagnosticMode ? { AGENT_RETRIEVAL_MAX_MODEL_CALLS: '3' } : {}),
})
const controlledSearch = selectionControl || batchProof
  ? diagnostic?.controlled_search ?? JSON.parse(await readFile(`${root}/supplement-local-preflight.json`, 'utf8')) : null
if (controlledSearch && (controlledSearch.fingerprint !== snapshot.fingerprint || controlledSearch.query !== testCase.query ||
  controlledSearch.provenance !== 'local_search_preflight_not_model_decision')) throw new Error('Selection control source mismatch')
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const sourceDb = drizzle(pool, { schema }) as unknown as Database
const isolated = await createTestDatabase()
const db = isolated.db
const realSearch = new SearchService(sourceDb, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
// 明确402拒绝与未知响应不同。只接受直接用户确认恢复的那一条，仍保留全额未知费用预留。
const paymentRecoverySchema = z.object({ source: z.literal('direct_user_reply'), authorized_on: z.literal('2026-10-06'),
  user_answer: z.literal('已检查并恢复平台余额/渠道额度'), confirmed_rejected_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fee_unknown_reserve_cny: z.number().positive(), failed_case: z.literal('action'), failed_revision: z.literal(7), fresh_revision: z.literal(8) }).strict()
let paymentRecovery: z.infer<typeof paymentRecoverySchema> | null = null
try { paymentRecovery = paymentRecoverySchema.parse(JSON.parse(await readFile(`${root}/provider-payment-recovery.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
// 第二次明确拒绝后用户要求再试一次；未知结果不适用此入口，旧请求身份绝不重放。
const explicitRetrySchema = z.object({ source: z.literal('direct_user_reply'), authorized_on: z.literal('2026-10-06'),
  user_answer: z.literal('再试一下，平台可能抖动了'), confirmed_rejected_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fee_unknown_reserve_cny: z.number().positive(), case_id: z.literal('action'), fresh_revision: z.literal(9), maximum_new_initial_attempts: z.literal(1) }).strict()
let explicitRetry: z.infer<typeof explicitRetrySchema> | null = null
try { explicitRetry = explicitRetrySchema.parse(JSON.parse(await readFile(`${root}/provider-explicit-retry.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
// 第三次402后用户再次明确要求下午复验；只承认已收到的拒绝，不放行未知请求。
const afternoonRetrySchema = z.object({ source: z.literal('direct_user_reply'), authorized_on: z.literal('2026-10-06'),
  user_answer: z.literal('再试一下，glm下午的时候似乎好了'), confirmed_rejected_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fee_unknown_reserve_cny: z.number().positive(), case_id: z.literal('action'), fresh_revision: z.literal(10), maximum_new_initial_attempts: z.literal(1) }).strict()
let afternoonRetry: z.infer<typeof afternoonRetrySchema> | null = null
try { afternoonRetry = afternoonRetrySchema.parse(JSON.parse(await readFile(`${root}/provider-afternoon-retry.json`, 'utf8'))) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const confirmedPaymentRejections = [paymentRecovery?.confirmed_rejected_request_sha256, explicitRetry?.confirmed_rejected_request_sha256,
  afternoonRetry?.confirmed_rejected_request_sha256]
  .filter((value): value is string => Boolean(value))
const ledgerFile = `${root}/live-ledger.json`
type Attempt = { kind: 'glm' | 'rerank' | 'deepseek_probe' | 'deepseek_agent'; run_id: string; status: string; reserve_cny: number; model: string;
  request_bytes?: number; latency_ms?: number; usage?: unknown; estimated_cost_cny: number | null;
  billed_cost_cny: null; http_status?: number; request_id?: string | null; request_sha256?: string;
  query?: string; candidate_keys?: string[]; evidence_sha256?: string[]; rejection_category?: string; evidence_protocol?: string; image_count?: number }
let ledger: { authorization: string; carried_prior_estimate_and_reserve_cny: number; attempts: Attempt[]; runs: any[] }
try { ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unreadable existing ledger; never reset usage')
  // 新授权建立独立协议账本，旧验收 40 次与未知费用全部保留，不删除或刷新旧账本额度。
  const previous = JSON.parse(await readFile('../../.scratch/retrieval-live-ledger.json', 'utf8'))
  ledger = { authorization: '2026-10-05 user goal: new GLM<=24, product rerank<=4, total<=5CNY',
    carried_prior_estimate_and_reserve_cny: previous.attempts.reduce((sum: number, item: any) => sum + (item.estimated_cost_cny ?? 0.25), 0),
    attempts: [], runs: [] }
}
// 已收到且经用户确认修正白名单的那次403仍保留正预留；只豁免这一条已知拒绝的用量缺失。
let recoveredProbe: any = null
try { recoveredProbe = JSON.parse(await readFile(`${root}/deepseek-permission-recovery.json`, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const ready = () => {
  if (!recoveredProbe) return verificationAttemptsReady(ledger.attempts, confirmedPaymentRejections)
  const rejected = ledger.attempts.filter(a => a.request_sha256 === recoveredProbe.confirmed_rejected_request_sha256)
  if (recoveredProbe.user_answer !== '我更新了，重试一下，刚刚网站没有设置允许访问`deepseek-v4-flash`' || rejected.length !== 1 || rejected[0].kind !== 'deepseek_probe' || rejected[0].http_status !== 403 || rejected[0].status !== 'received' || !(rejected[0].reserve_cny > 0)) return false
  return verificationAttemptsReady(ledger.attempts.filter(a => a !== rejected[0]), confirmedPaymentRejections)
}
const save = () => saveVerificationLedger(lock, ledgerFile, ledger)
let activeRunId = ''
/** 按最坏预留计入预算，任何失败/未知外发都占次数；只执行单进程并持有排他目录锁。 */
const reserve = async (kind: Attempt['kind'], amount: number, model: string) => {
  if (!live) throw new Error('Dry mode forbids external request')
  if (ledger.attempts.some(attempt => ['dispatched', 'outcome_unknown'].includes(attempt.status))) throw new Error('Unknown dispatch forbids further live calls')
  if (!ready()) throw new Error('Unknown usage forbids further live calls')
  if (ledger.attempts.filter(attempt => attempt.kind === kind).length >= (kind === 'deepseek_agent' ? maximumDeepseekAgentCalls : kind === 'glm' ? maximumGlmCalls : maximumRerankCalls)) throw new Error('Authorized call count exhausted')
  // DeepSeek发送前同时保留本批最终图片对照空间，不能把全部预算用在循环上。
  if (!verificationCostFits(maximumTotalCost, ledger.carried_prior_estimate_and_reserve_cny, ledger.attempts, amount + (diagnosticMode && kind === 'deepseek_agent' ? .432 : 0))) throw new Error('Authorized conservative cost budget exhausted')
  if (kind === 'deepseek_agent' && !verificationCostFits(maximumDeepseekCost, 0, ledger.attempts.filter(a => a.kind.startsWith('deepseek')), amount)) throw new Error('Authorized DeepSeek cumulative cost exhausted')
  const attempt: Attempt = { kind, run_id: activeRunId, status: 'dispatched', reserve_cny: amount, model,
    estimated_cost_cny: null, billed_cost_cny: null }
  ledger.attempts.push(attempt); await save(); return attempt
}
/** 账本额度耗尽仍允许已经决定的本地工具/预算收尾，禁止新的模型派发。 */
const localBudgetStop = (state: any) => state && !state.pending && retrievalBudgetStop(state.budget?.limits ?? retrievalBudget(settings),
  { tools: state.tool_calls, searches: state.budget?.searches ?? state.queries?.length ?? 0,
    details: state.budget?.details ?? Object.keys(state.details ?? {}).length, models: state.model_calls ?? 0 })
const request: typeof fetch = async (url, init) => {
  if (selectionControl || reuseReceived || diagnosticMode && resumeConfirmed) throw new Error('This mode forbids model dispatch')
  const body = String(init?.body ?? ''), parsed = JSON.parse(body)
  if (deepseek && !sceneVision && !matchedApproval && !textOnlyMessages(parsed.messages)) throw new Error('Text-only verification forbids image content')
  const imageBlocks = parsed.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'image_url')
  if (matchedApproval) {
    if (imageBlocks.length > 20 || imageBlocks.some((block: any) => !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(block.image_url?.url ?? '') || Buffer.from(block.image_url.url.split(',')[1], 'base64').length > 20000)) throw new Error('Matched material image boundary exceeded')
    const isDecision = parsed.tools?.some((tool: any) => tool.function?.name === 'next_retrieval_action')
    const message = parsed.messages.find((row: any) => row.role === 'user')
    // 原文意图请求的首块是普通用户文字，不是JSON上下文。只有图文决策才解析证据关联。
    const context = isDecision ? JSON.parse(Array.isArray(message.content) ? message.content[0].text : message.content) : {}
    // 意图请求没有媒体；图文决策的身份须属于获批池，20张图片不能从旧授权推导。
    if (context.matched_evidence && (Object.keys(context.matched_evidence).length > 20 || Object.keys(context.matched_evidence).some(key => !approvedMediaKeys.has(key)))) throw new Error('Matched media outside approved identities')
    if (imageBlocks.length && !context.matched_evidence) throw new Error('Matched image ownership unavailable')
  }
  if (parsed.model !== (deepseek ? 'deepseek-v4-flash' : 'glm-5.3') || parsed.max_tokens > 2000 || Buffer.byteLength(body) > maximumDecisionBytes) throw new Error('GLM request limit')
  // UTF-8 字节数作为输入 token 的保守上界；8/28 是公开基础价估算，非 RightAPI 实际账单。
  const attempt = await reserve(deepseek ? 'deepseek_agent' : 'glm', (Buffer.byteLength(body) + 4096) * 8 / 1e6 + 2000 * 28 / 1e6, parsed.model)
  attempt.request_bytes = Buffer.byteLength(body)
  attempt.request_sha256 = createHash('sha256').update(body).digest('hex')
  if (matchedApproval) { attempt.evidence_protocol = matchedApproval.protocol; attempt.image_count = imageBlocks.length }
  await save()
  const started = performance.now()
  try {
    const response = await fetch(url, init)
    attempt.http_status = response.status
    const data = await response.clone().json() as any
    attempt.usage = data.usage ?? null
    if (!response.ok) {
      // 仅固定分类，不保存服务商错误正文、陌生字段、密钥或素材文字。
      const code = String(data.error?.code ?? '').toLowerCase()
      const message = String(data.error?.message ?? '').toLowerCase()
      attempt.rejection_category = /balance|insufficient.*credit|额度|余额/.test(code + ' ' + message) ? 'balance_or_quota'
        : /payment_required/.test(code) ? 'payment_required' : /permission|unauthori/.test(code) ? 'permission' : 'unclassified_http_error'
    }
    attempt.request_id = typeof data.id === 'string' ? data.id : null
    attempt.status = response.status >= 500 ? 'outcome_unknown' : 'received'
    if (Number.isInteger(data.usage?.prompt_tokens) && Number.isInteger(data.usage?.completion_tokens))
      attempt.estimated_cost_cny = (data.usage.prompt_tokens * 8 + data.usage.completion_tokens * 28) / 1e6
    // 不保存 raw response、content 或 reasoning；工具动作由严格 Runner 校验后写步骤记录。
    return response
  } catch { attempt.status = 'outcome_unknown'; throw new Error('Live GLM outcome unknown') }
  finally { attempt.latency_ms = Math.round(performance.now() - started); await save() }
}
const provider = createAgentRerankProvider(settings)
let confirmedRerank: { input_sha256: string; result: Awaited<ReturnType<AgentRerankProvider['rerank']>> } | null = null
const inputHash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const cached = reuseReceived ? JSON.parse(await readFile(`${root}/${reuseReceived}-baseline.json`, 'utf8')) : null
const cachedAttempt = cached?.rerank_attempts?.find((a: any) => a.status === 'succeeded' && a.externalCallStatus === 'completed')
const cachedLedger = cached ? ledger.attempts.find(a => a.kind === 'rerank' && a.run_id === cached.run.id && a.status === 'received') : null
if (cached && (!cachedAttempt || !cachedLedger || cached.run.prompt !== testCase.query || !Number.isInteger((cachedLedger.usage as any)?.total_tokens))) throw new Error('Confirmed rerank source missing')
const cachedResponse = cached ? { results: cached.rankings.filter((r: any) => r.rerankRank !== null).sort((a: any, b: any) => a.rerankRank - b.rerankRank).map((r: any) => ({ index: cached.candidates.findIndex((c: any) => c.candidateKey === r.candidateKey), relevance_score: Number(r.relevanceScore) })) } : null
if (cached && inputHash(cachedResponse) !== cachedAttempt.responseFingerprint) throw new Error('Confirmed rerank response fingerprint mismatch')
const controlledProvider: AgentRerankProvider = { available: live && provider.available, rerank: async (input, signal) => {
  if (cached) {
    // 仅复用已收到且请求/响应摘要完全一致的历史响应；没有模型调用，也不进入收费账本。
    if (inputHash(input) !== cachedLedger!.request_sha256) throw new Error('Confirmed rerank request differs; no replay')
    const result = { response: cachedResponse, providerRequestId: cachedAttempt.providerRequestId, responseModel: cachedAttempt.responseModel,
      modelSnapshot: cachedAttempt.modelSnapshot, region: cachedAttempt.region, inputTokens: cachedAttempt.inputTokens, outputTokens: cachedAttempt.outputTokens,
      totalTokens: cachedAttempt.totalTokens, billedCostCny: cachedAttempt.billedCostCny }
    confirmedRerank = { input_sha256: inputHash(input), result }
    return result
  }
  const attempt = await reserve('rerank' , AGENT_RERANK_POLICY.maximumCostCny, 'qwen3-vl-rerank')
  attempt.query = input.query; attempt.request_sha256 = inputHash(input)
  attempt.candidate_keys = input.documents.map(row => row.candidate_key)
  attempt.evidence_sha256 = input.documents.map(row => row.evidence_sha256)
  await save()
  const started = performance.now()
  try {
    const result = await provider.rerank(input, signal)
    confirmedRerank = { input_sha256: inputHash(input), result }
    attempt.status = 'received'; attempt.usage = { total_tokens: result.totalTokens }
    attempt.request_id = result.providerRequestId
    attempt.estimated_cost_cny = result.totalTokens === null ? null : result.totalTokens * 1.8 / 1e6
    return result
  } catch (error) { attempt.status = 'outcome_unknown'; throw error }
  finally { attempt.latency_ms = Math.round(performance.now() - started); await save() }
} }
const copiedFiles = new Set<string>()
/** 搜索事实来自只读真实库，逐文件复制到内存测试库以运行真实身份/详情校验，不重建索引。 */
async function copyFiles(ids: string[]) {
  const fresh = [...new Set(ids)].filter(id => !copiedFiles.has(id))
  if (!fresh.length) return
  const files = await sourceDb.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.id, fresh))
  const libs = await sourceDb.select().from(schema.libraries).where(inArray(schema.libraries.id, [...new Set(files.map(file => file.libraryId))]))
  const scenes = await sourceDb.select().from(schema.videoScenes).where(inArray(schema.videoScenes.fileId, fresh))
  const assets = await sourceDb.select().from(schema.mediaAssets).where(inArray(schema.mediaAssets.fileId, fresh))
  const refs = await sourceDb.select().from(schema.vectorRefs).where(inArray(schema.vectorRefs.fileId, fresh))
  await db.insert(schema.libraries).values(libs).onConflictDoNothing()
  await db.insert(schema.mediaFiles).values(files)
  if (scenes.length) await db.insert(schema.videoScenes).values(scenes)
  // text_tsv 是数据库自动生成字段，不能复制赋值。
  for (let index = 0; index < assets.length; index += 100)
    await db.insert(schema.mediaAssets).values(assets.slice(index, index + 100).map(({ textTsv: _generated, ...asset }) => asset))
  for (let index = 0; index < refs.length; index += 100) await db.insert(schema.vectorRefs).values(refs.slice(index, index + 100))
  fresh.forEach(id => copiedFiles.add(id))
}
const searchProxy = { search: async (input: any, options: any) => {
  // 初始原文返回冻结快照，补搜实时只读同一索引；两种流程共享完全相同首轮。
  if (input.query === testCase.query && (input.search_scope !== testCase.scope ||
    JSON.stringify([...input.media_types].sort()) !== JSON.stringify([...testCase.request.media_types].sort())))
    throw new Error('Intent narrowed frozen comparison scope; no paid rerank')
  const response = input.query === testCase.query && !matchedMode ? { results: testCase.results } : await realSearch.search(input)
  if (matchedMode && input.query === testCase.query && JSON.stringify(response.results.map((r: any) => [r.file_id, r.asset_id, r.scene_id])) !== JSON.stringify(testCase.results.map((r: any) => [r.file_id, r.asset_id, r.scene_id]))) throw new Error('Matched evidence changed frozen original candidates')
  if (controlledSearch && input.query !== testCase.query) {
    const frozenQuery = controlledSearch.observations.find((row: any) => row.query === input.query)
    const identities = (rows: any[]) => rows.map(row => [row.file_id, row.asset_id, row.scene_id ?? null])
    if (!frozenQuery || JSON.stringify(identities(response.results)) !== JSON.stringify(identities(frozenQuery.results)))
      throw new Error('Frozen index supplemental identities changed; no paid rerank')
  }
  if (deepseek && !mediaResultsAuthorized(response.results, approvedMediaKeys))
    throw new AgentStepExecutionError('AGENT_MEDIA_NOT_AUTHORIZED', '补搜包含本次未批准外发的素材，停止工具并保留基线。')
  await copyFiles(response.results.map((item: any) => item.file_id))
  await options?.onProgress?.('retrieving', 'running'); await options?.onProgress?.('rrf', 'succeeded')
  return response
} } as unknown as SearchService
const substituteIntent = { isReady: () => true, fingerprint: () => 'local-frozen-control', extract: async () => ({
  intent: { goal: 'search' as const, search_scope: testCase.scope, media_types: testCase.request.media_types,
    library_references: [], conditions: [{ source_text: testCase.query, kind: 'must_have' as const,
      evidence_type: testCase.scope === 'spoken' ? 'spoken' as const : 'visual' as const }], needs_clarification: false,
    clarification_reason: null, requested_effect: null },
  conditions: [{ source_text: testCase.query, normalized_source_text: testCase.query, kind: 'must_have' as const,
    evidence_type: testCase.scope === 'spoken' ? 'spoken' as const : 'visual' as const }],
  provider: { model: 'substitute', prompt_version: 'local-frozen-control', schema_version: 'local', request_id: 'no-external-call', input_tokens: 0, output_tokens: 0 } }) }
let reusedIntent: any = null
const reusedIntentPrefix = reuseIntentFrom ?? (caseId === 'cat' ? 'cat-r2' : caseId)
if (reuseIntentFrom || (authorizedBatch && !deepseek && caseId !== 'empty')) {
  const saved = JSON.parse(await readFile(`${root}/${reusedIntentPrefix}-enhanced.json`, 'utf8'))
  const original = saved.steps.find((step: any) => step.stepKind === 'extracting_intent' && step.status === 'completed')?.outputJson
  if (saved.run.prompt !== testCase.query || !(deepseek ? /^deepseek-v4(?:-1)?-flash(?:-\d{6})?$/.test(original?.provider?.model ?? '') : original?.provider?.model === 'glm-5.3') ||
    original?.enforced_scope?.search_scope !== testCase.scope ||
    JSON.stringify([...original.enforced_scope.media_types].sort()) !== JSON.stringify([...testCase.request.media_types].sort()) ||
    JSON.stringify([...original.enforced_scope.library_ids].sort()) !== JSON.stringify([...testCase.request.library_ids].sort()) ||
    !ledger.attempts.some(attempt => attempt.kind === (deepseek ? 'deepseek_agent' : 'glm') && attempt.status === 'received' && attempt.run_id === saved.run.id))
    throw new Error('Confirmed intent identity/scope mismatch; no reuse')
  reusedIntent = { isReady: () => true, fingerprint: () => `reuse-confirmed-intent:${original.provider.request_id}`,
    extract: async () => ({ intent: original.intent, conditions: original.conditions.map(({ condition_id: _id, ...row }: any) => row),
      provider: { ...original.provider, reused_from_run: saved.run.id, actual_external_dispatch: false } }) }
}
/** 复用确定意图时保存本地步骤，不能把账本外的复用伪装成本次新外发。 */
class ConfirmedIntentHandler extends AgentV1StepHandler {
  override async prepare(input: Parameters<AgentV1StepHandler['prepare']>[0]) {
    const prepared = await super.prepare(input)
    return { ...prepared, external: input.step === 'extracting_intent' ? false : prepared.external }
  }
}
const intentRunner = localChain ? substituteIntent : reusedIntent ?? new QwenAgentIntentRunner(settings, request)
const legacy = reusedIntent ? new ConfirmedIntentHandler(db, settings, intentRunner, searchProxy)
  : new AgentV1StepHandler(db, settings, intentRunner, searchProxy)
const details = new SegmentDetailsTool(db)
const localDecisionPreflights: Array<{ request_bytes: number; request_sha256: string; external_calls: number; image_count?: number; maximum_next_reserve_cny?: number }> = []
const baseDecision = selectionControl ? {
  fingerprint: (context: unknown) => inputHash({ protocol: 'local-selection-control-v1', context }),
  decide: async (context: any) => {
    const checked = Object.entries(context.details).map(([candidate_key, detail]: [string, any]) => ({
      candidate_key, evidence_ids: detail.evidence.filter((row: any) => row.source !== 'media_metadata').map((row: any) => row.evidence_id),
    }))
    const gap = { condition_ids: context.conditions.map((row: any) => row.condition_id),
      kind: 'details_unread' as 'details_unread' | 'not_mentioned', checked,
      missing_evidence: diagnosticMode ? '独立本地变式选择对照；文字缺失不能证明手持手机或排除抱臂，不代表真实模型判断' : '既有两份描述未支持小猫趴在猫爬架上的动作和位置关系；未提到不等于不符合',
      next_step_reason: '已获批准的独立本地选择实验；保留完整原目标，条件语义仍未验证', preserves_original_goal: true as const }
    if (context.checked_candidate_keys.length < Math.min(2, context.candidates.length)) {
      const target = context.candidates.find((row: any) => !context.checked_candidate_keys.includes(row.candidate_key))
      return { action: { action: 'get_segment_details' as const, candidate_key: target.candidate_key,
        gap: { ...gap, missing_evidence: '先检查现有候选详情，未读不能作为反证' } },
      provider: { model: 'substitute', origin: 'local_selection_control', actual_external_dispatch: false } }
    }
    const next = controlledSearch.observations.find((row: any) => !context.queries.some((query: any) => query.query === row.query))
    return { action: next ? { action: 'search_media' as const, query: next.query, search_scope: testCase.scope,
      media_types: testCase.request.media_types, limit: 20, gap: { ...gap, kind: 'not_mentioned' as const } }
      : { action: 'finish' as const, reason: 'partial' as const, assessments: [] },
    provider: { model: 'substitute', origin: 'local_selection_control', actual_external_dispatch: false } }
  },
} : localChain ? { fingerprint: (context: unknown, images: RetrievalDecisionImage[] = []) => {
  const prepared = new RightApiRetrievalDecisionRunner(settings, async () => {
    throw new Error('Local preflight forbids external requests')
  }).preflight(context, images)
  localDecisionPreflights.push({ request_bytes: prepared.request_bytes, request_sha256: prepared.request_sha256, external_calls: 0, image_count: images.length, maximum_next_reserve_cny: (prepared.request_bytes + 4096) * 8 / 1e6 + 2000 * 28 / 1e6 })
  return prepared.request_sha256
}, decide: async (context: any) => {
  if (batchProof && context.candidates.length && !context.checked_candidate_keys.length) return {
    action: { action: 'get_segment_details_batch' as const, candidate_keys: context.candidates.slice(0, 2).map((row: any) => row.candidate_key),
      gap: { condition_ids: context.conditions.map((row: any) => row.condition_id), kind: 'details_unread' as const, checked: [],
        missing_evidence: '本地替身检查两份完整动作/位置文字；不代表真实GLM选择',
        next_step_reason: '验证概要后一次批量检查两个候选', preserves_original_goal: true as const } }, provider: { model: 'substitute' } }
  if (batchProof && context.queries.length === 1) return {
    action: { action: 'search_media' as const, query: controlledSearch.observations[0].query,
      search_scope: testCase.scope, media_types: testCase.request.media_types, limit: 20,
      gap: { condition_ids: context.conditions.map((row: any) => row.condition_id), kind: 'not_mentioned' as const,
        checked: Object.entries(context.details).map(([candidate_key, detail]: [string, any]) => ({ candidate_key, evidence_level: 'detail' as const,
          evidence_ids: detail.evidence.filter((row: any) => row.source !== 'media_metadata').map((row: any) => row.evidence_id) })),
        missing_evidence: '本地控制实验保持原文动作和关系；语义是否支持仍未验证',
        next_step_reason: '使用已冻结本地实验查询验证补搜合并边界', preserves_original_goal: true as const } }, provider: { model: 'substitute' } }
  return {
  action: !context.queries.length && testCase.scope === 'spoken'
    ? { action: 'search_media' as const, query: testCase.query, search_scope: 'spoken' as const, media_types: testCase.request.media_types, limit: 20 }
    : { action: 'finish' as const, reason: context.candidates.length ? 'insufficient_evidence' as const : 'no_results' as const,
      assessments: context.candidates.slice(0, 1).map((row: any) => ({ candidate_key: row.candidate_key,
        conditions: context.conditions.map((condition: any) => ({ condition_id: condition.condition_id,
          status: 'unknown' as const, evidence_ids: [] })) })) }, provider: { model: 'substitute' } }
} }
  : (() => {
    const runner = new RightApiRetrievalDecisionRunner(settings, request)
    return { preflight: (context: unknown, images?: RetrievalDecisionImage[]) => ({ ...runner.preflight(context, images), maximum_request_bytes: maximumDecisionBytes }), fingerprint: (context: unknown, images?: RetrievalDecisionImage[]) => {
      const prepared = runner.preflight(context, images)
      const nextReserve = (prepared.request_bytes + 4096) * 8 / 1e6 + 2000 * 28 / 1e6
      if (live && !verificationCostFits(maximumTotalCost, ledger.carried_prior_estimate_and_reserve_cny, ledger.attempts, nextReserve + (diagnosticMode ? .432 : 0)))
        throw new AgentStepExecutionError('AGENT_DECISION_PREFLIGHT_COST', '累计保守费用达到授权上限；发送前停止。')
      if (deepseek && live && !verificationCostFits(maximumDeepseekCost, 0, ledger.attempts.filter(a => a.kind.startsWith('deepseek')), nextReserve))
        throw new AgentStepExecutionError('AGENT_DECISION_PREFLIGHT_COST', '新模型累计保守费用达到授权上限；发送前停止。')
      if (authorizedBatch && prepared.request_bytes > maximumDecisionBytes)
        throw new AgentStepExecutionError('AGENT_DECISION_PREFLIGHT_BUDGET', '决策请求超过本批已授权字节上限；发送前停止。')
      return prepared.request_sha256
    }, decide: runner.decide.bind(runner) }
  })()
// 本地替身同样提交有界停止意见，不能把缺少新版字段误当成真实模型已验证。
// 真实请求不经过此装饰；外发响应必须自己提供停止依据并由正式执行器检查。
const decision = selectionControl || localChain ? { ...baseDecision, decide: async (context: any, images?: RetrievalDecisionImage[]) => {
  const response: Awaited<ReturnType<RetrievalDecisionRunner['decide']>> = await baseDecision.decide(context, images)
  if (matchedMode && response.action.action === 'finish' && !response.action.stop_basis) {
    const empty = response.action.reason === 'no_results'
    response.action.stop_basis = { kind: empty ? 'no_results' : 'no_useful_next_action',
      condition_ids: empty ? [] : context.conditions.map((row: any) => row.condition_id),
      checked: empty ? [] : Object.entries(context.matched_evidence ?? {}).slice(0, 2).map(([candidate_key, record]: [string, any]) => ({
        candidate_key, evidence_level: 'matched', evidence_ids: record.evidence.slice(0, 1).map((row: any) => row.evidence_id) })),
      search: { status: empty ? 'not_needed' : 'not_useful', reason: '本地替身未选择其他有用查询，不代表真实模型决定' },
      detail: { status: empty ? 'not_needed' : 'not_useful', reason: '本地替身结束控制实验，不代表语义已核实' } }
  }
  return response
} } : baseDecision
const selection = new RetrievalSelectionService(db, settings)
// 验收明确标记evaluation；不授予产品资格，也不直接修改已提交步骤的名单。
const evaluationSelection = { select: selection.selectForEvaluation.bind(selection) } as RetrievalSelectionService
/** 所有控制决策都是本地替身，不能写成已外发；工具/候选仍经过正式提交与恢复边界。 */
class LocalSelectionControlHandler extends RetrievalAgentHandler {
  override async prepare(input: Parameters<RetrievalAgentHandler['prepare']>[0]) {
    const prepared = await super.prepare(input)
    return { ...prepared, external: false }
  }
}
const Handler = selectionControl || localChain ? LocalSelectionControlHandler : RetrievalAgentHandler
const handler = new Handler(db, settings, legacy, searchProxy, details, decision, evaluationSelection, sceneVision ? new SceneInspectionTool(db, settings, details, new MediaThumbnailService(runFfmpegThumbnail), request) : undefined, matchedMode ? new MatchedEvidenceTool(db, details, new SceneInspectionTool(db, settings, details, new MediaThumbnailService(runFfmpegThumbnail), async () => { throw new Error('Zero-outflow matched preflight') })) : undefined)
const executor = new AgentExecutorService(db, settings, handler)
const dump = async (id: string, label: string) => {
  const value = (await getDurableAgentRun(db, id))!
  const page = await new AgentService(db, settings, handler, undefined, undefined, details).getRun(id)
  const rerankAttempts = await db.select().from(schema.agentRerankRuns).where(eq(schema.agentRerankRuns.agentRunId, id))
  const rankings = rerankAttempts.length ? await db.select().from(schema.agentRerankRankings)
    .where(inArray(schema.agentRerankRankings.rerankRunId, rerankAttempts.map(row => row.id))) : []
  const evidence = await db.select().from(schema.candidateEvidence).where(eq(schema.candidateEvidence.sourceId, id))
  const auditedEvidence = []
  for (const row of evidence) {
    // 受控相对产物保留输入/输出指纹用于复验；源路径从报告移除，不发送模型或写普通日志。
    let artifact: string | null = null
    if (row.status === 'succeeded' && row.artifactPath) {
      const bytes = await readFile(row.artifactPath)
      if (createHash('sha256').update(bytes).digest('hex') !== row.artifactSha256) throw new Error('Worker artifact changed')
      await mkdir(`${root}/audited-images`, { recursive: true })
      artifact = `audited-images/${row.id}.png`
      await writeFile(`${root}/${artifact}`, bytes)
    }
    const { artifactPath: _private, ...safe } = row
    auditedEvidence.push({ ...safe, artifact })
  }
  // 返回的任务快照本身不包含文件表或路径；仅保留有界文字证据与结构化动作，不含模型思考。
  await writeFile(`${root}/${artifactPrefix}-${label}.json`, JSON.stringify({ ...value, page,
    rerank_attempts: rerankAttempts, rankings, evidence: auditedEvidence }, null, 2))
  return value
}
/** 复用已成功的当前代 Worker 拼图；每份字节/指纹仍由产品重排服务重新校验。 */
async function attachEvidence(runId: string, keys: string[]) {
  const candidates = (await getDurableAgentRun(db, runId))!.candidates.filter(row => keys.includes(row.candidateKey))
  for (const candidate of candidates) {
    if (!candidate.sceneId) continue
    const existing = await sourceDb.select().from(schema.candidateEvidence).where(and(
      eq(schema.candidateEvidence.fileId, candidate.fileId), eq(schema.candidateEvidence.sceneId, candidate.sceneId),
      eq(schema.candidateEvidence.fileGeneration, candidate.fileGeneration), eq(schema.candidateEvidence.status, 'succeeded'),
      eq(schema.candidateEvidence.strategy, 'contact_sheet_v1')))
    // 必须沿用正式服务的 Caption→同场景indexed帧锚点规则，不能直接把Caption当帧。
    await new CandidateEvidenceService(db).createEvidence({ source: { type: 'agent_run_candidate', run_id: runId },
      candidate_key: candidate.candidateKey, strategies: ['contact_sheet_v1'] })
    const [local] = await db.select().from(schema.candidateEvidence).where(and(eq(schema.candidateEvidence.sourceId, runId),
      eq(schema.candidateEvidence.candidateKey, candidate.candidateKey), eq(schema.candidateEvidence.strategy, 'contact_sheet_v1')))
    if (!local) throw new Error('Current Worker evidence identity missing')
    const recorded = derivedSnapshot?.evidence?.find((row: any) => row.status === 'succeeded' && row.assetId === local.assetId && row.candidateKey === candidate.candidateKey && row.fileId === candidate.fileId && row.sceneId === candidate.sceneId && row.fileGeneration === candidate.fileGeneration && row.strategy === local.strategy && row.protocolVersion === local.protocolVersion && /^audited-images\/[a-f0-9-]+\.png$/.test(row.artifact ?? ''))
    // 同一冻结语料的已保存Worker产物可本地复用；实际字节/Manifest仍由正式准备器重新核对。
    const evidence = existing.find(row => row.assetId === local.assetId && row.candidateKey === candidate.candidateKey) ?? (recorded ? { ...recorded, artifactPath: resolve(root, recorded.artifact) } : undefined)
    let completed: any
    if (!evidence) {
      const generated = await buildLocalReviewEvidence(pool, { ...candidate, assetId: local.assetId, sceneId: candidate.sceneId })
      const manifest = generated.manifest
      completed = { status: 'succeeded', manifestJson: manifest, inputSha256: manifest.input_sha256, artifactSha256: manifest.artifact_sha256,
        artifactPath: resolve(root, generated.image), artifactMimeType: 'image/png', artifactWidth: manifest.width,
        artifactHeight: manifest.height, artifactByteSize: manifest.byte_size, expiresAt: null }
    } else {
      const bytes = await readFile(evidence.artifactPath!)
      if (createHash('sha256').update(bytes).digest('hex') !== evidence.artifactSha256) throw new Error('Worker artifact changed')
      completed = { status: 'succeeded', manifestJson: evidence.manifestJson, inputSha256: evidence.inputSha256,
        artifactSha256: evidence.artifactSha256, artifactPath: evidence.artifactPath, artifactMimeType: evidence.artifactMimeType,
        artifactWidth: evidence.artifactWidth, artifactHeight: evidence.artifactHeight, artifactByteSize: evidence.artifactByteSize, expiresAt: null }
    }
    // 与Worker完成提交相同：证据与Job一起落到隔离库，不能留下Job排队而证据已完成的矛盾状态。
    await db.transaction(async tx => {
      await tx.update(schema.candidateEvidence).set({ ...completed, finishedAt: new Date() }).where(eq(schema.candidateEvidence.id, local.id))
      if (local.jobId) await tx.update(schema.jobs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(schema.jobs.id, local.jobId))
    })
  }
}
let lock = false
let phase = 'preflight'
let stopped = false
try {
  try { await mkdir(`${root}/live.lock`); lock = true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Verification ledger lock busy; no dispatch'); throw error }
  ledger = await reloadVerificationLedger(lock, ledgerFile, ledger)
  maximumDeepseekCost = diagnosticApproval?.maximum_deepseek_total_cost_cny ?? matchedPositionSupplementCostLimit(positionBudgetSupplement, {
    caseId, revision, fingerprint: snapshot.fingerprint,
    deepseekAgentCalls: ledger.attempts.filter(row => row.kind === 'deepseek_agent').length,
  })
  if (diagnosticApproval && (ledger.attempts.filter(row => row.kind === 'deepseek_agent').length < diagnosticApproval.prior_deepseek_agent_calls ||
    ledger.attempts.filter(row => row.kind === 'rerank').length < diagnosticApproval.prior_product_rerank_calls)) throw new Error('Diagnostic historical ledger missing')
  // 修复后的显式新版本复验保留旧请求记录；同版本或任何未知外发均不能重放。
  if (live && !resumeConfirmed && ledger.runs.some(run => run.case_id === caseId && (run.revision ?? 1) === revision && !run.local_preparation_only)) throw new Error('Existing live revision cannot be automatically replayed')
  if (live && ledger.attempts.some(attempt => ['dispatched', 'outcome_unknown'].includes(attempt.status))) throw new Error('Unknown dispatch forbids further live calls')
  if (live && !ready())
    throw new Error('Unknown usage forbids further live calls')
  await save()
  if (snapshot.fingerprint !== await corpusFingerprint(pool)) throw new Error('Frozen index changed; no paid validation')
  if (live && (authorizedBatch || diagnosticApproval)) {
    // 结构化摘要不足以确认查询服务/向量库未变化；真实模型前重新核对原文实际候选顺序。
    const current = await realSearch.search(testCase.request)
    const identities = (rows: any[]) => rows.map(row => [row.file_id, row.asset_id, row.scene_id ?? null])
    if (JSON.stringify(identities(current.results)) !== JSON.stringify(identities(testCase.results)))
      throw new Error('Frozen index candidate order changed before live calls')
  }
  phase = 'copy_frozen_files'
  await copyFiles(testCase.results.map((item: any) => item.file_id))
  if (scenePreflight) {
    // 零模型外发准备：临时库只保存任务候选，提取可审查JPEG及无路径的来源清单。
    const run = await createDurableAgentRun(db, { prompt: testCase.query, retrievalAgent: true, allowExternalText: false, allowExternalVisual: false,
      libraryIds: testCase.request.library_ids, mediaTypes: testCase.request.media_types, searchScope: testCase.scope })
    phase = 'freeze_local_candidates'
    const candidates = await legacy.freezeCandidates(testCase.results, { library_ids: testCase.request.library_ids, media_types: testCase.request.media_types, search_scope: testCase.scope })
    phase = 'save_local_candidates'
    await db.insert(schema.agentRunCandidates).values(candidates.map(c => ({ ...c, id: randomUUID(), runId: run.id,
      sceneStartSeconds: c.sceneStartSeconds === null ? null : String(c.sceneStartSeconds), sceneEndSeconds: c.sceneEndSeconds === null ? null : String(c.sceneEndSeconds) })))
    const inspection = new SceneInspectionTool(db, settings, details, new MediaThumbnailService(runFfmpegThumbnail), async () => { throw new Error('Zero-outflow preflight') })
    const prepared = []
    const prior = reviewFramesFrom ? JSON.parse(await readFile(`${root}/${reviewFramesFrom}-enhanced.json`, 'utf8')) : null
    const priorScenes = prior ? [...prior.steps].reverse().find((step: any) => step.outputJson?.retrieval_state)?.outputJson.retrieval_state.scene_inspections ?? {} : {}
    const chosen = prior ? candidates.filter(c => priorScenes[c.candidateKey]?.status === 'observed') : candidates.slice(0, 3)
    if (chosen.length > 3 || (prior && !chosen.length)) throw new Error('No bounded confirmed scene observation for local review')
    for (const candidate of chosen) {
      phase = `prepare_scene_rank_${candidate.rank}`
      const scene = await inspection.prepare(run.id, candidate.candidateKey)
      if (prior && !inspection.matches(priorScenes[candidate.candidateKey], scene.metadata)) throw new Error('Frozen index observed frame bytes changed')
      for (const [i, data] of scene.images.entries()) await writeFile(`${root}/${artifactPrefix}-scene-${candidate.rank}-${i}.jpg`, Buffer.from(data.split(',')[1], 'base64'))
      prepared.push({ ...scene.metadata, jpeg_bytes: scene.images.map(data => Buffer.from(data.split(',')[1], 'base64').length) })
    }
    await writeFile(`${root}/${artifactPrefix}-scene-preflight.json`, JSON.stringify({ case_id: caseId, fingerprint: snapshot.fingerprint, provider: 'RightAPI', model: 'deepseek-v4-flash', candidate_count: candidates.length, maximum_candidates: 3, maximum_frames: 3, external_calls: 0, prepared }, null, 2))
    console.log(JSON.stringify({ case_id: caseId, prepared_candidates: prepared.length, prepared_frames: prepared.reduce((sum, s) => sum + s.frames.length, 0), external_calls: 0 }))
  } else if (localChain) {
    const runs = []
    for (const retrievalAgent of [false, true]) {
      const run = await createDurableAgentRun(db, { prompt: testCase.query, retrievalAgent, allowExternalText: true,
        allowExternalMediaText: true, allowExternalVisual: true, allowExternalRetrievalVisual: matchedMode, libraryIds: testCase.request.library_ids, mediaTypes: testCase.request.media_types, searchScope: testCase.scope })
      for (let i = 0; i < 16; i++) {
        await executor.runOnce()
        if (!['queued', 'extracting_intent', 'searching'].includes((await getDurableAgentRun(db, run.id))!.run.status)) break
      }
      runs.push(await dump(run.id, retrievalAgent ? 'local-enhanced' : 'local-baseline'))
    }
    const baseKeys = runs[0]!.candidates.map(row => row.candidateKey)
    const enhancedKeys = runs[1]!.candidates.map(row => row.candidateKey)
    if ((batchProof ? baseKeys.some(key => !enhancedKeys.includes(key)) : JSON.stringify(baseKeys) !== JSON.stringify(enhancedKeys)) ||
      baseKeys.length !== testCase.results.length) throw new Error('Baseline candidates differ in local control')
    const retrievalState = [...runs[1]!.steps].reverse().map(row => (row.outputJson as any)?.retrieval_state).find(Boolean)
    await writeFile(`${root}/${artifactPrefix}-local-control.json`, JSON.stringify({ case_id: caseId, query: testCase.query,
      baseline_candidate_keys: baseKeys, enhanced_candidate_keys: enhancedKeys,
      external_calls: 0, model_substitute: true, final_rerank_executed: false, fingerprint: snapshot.fingerprint,
      autonomous_glm_supplement: false, evidence_protocol: retrievalState?.evidence_protocol,
      local_batch_proof: batchProof, overview_budget: retrievalState?.overview_budget,
      detail_count: Object.keys(retrievalState?.details ?? {}).length, queries: retrievalState?.queries?.map((row: any) => row.query),
      experimental_candidate_keys: retrievalState?.experimental_candidate_keys ?? [],
      decision_preflights: localDecisionPreflights, limits: retrievalBudget(settings) }, null, 2))
    console.log(JSON.stringify({ case_id: caseId, local_control_candidates: baseKeys.length, external_calls: 0,
      decision_request_bytes: localDecisionPreflights.map(row => row.request_bytes) }))
  }
  else if (!live && !selectionControl) { console.log(JSON.stringify({ dry_preflight: true, case_id: caseId, frozen_candidates: testCase.results.length, external_calls: 0 })); }
  else {
    let enhanced: { id: string }
    if (resumeConfirmed) {
      phase = 'restore_confirmed_handoff'
      const saved = JSON.parse(await readFile(`${root}/${artifactPrefix}-enhanced.json`, 'utf8'))
      const savedState = [...saved.steps].reverse().find((step: any) => step.outputJson?.retrieval_state)?.outputJson.retrieval_state
      // 累计GLM额度用尽后仍可执行程序的纯本地tool_limit收尾。只恢复这一
      // 可证明无需模型的状态，不能把任意searching任务恢复为新的付费决策。
      const localBudgetFinish = saved.run.status === 'searching' && savedState?.tool_calls >= settings.agentMaxSteps && !savedState.pending
      if ((saved.run.status !== 'ranking' && !localBudgetFinish) || saved.steps.some((step: any) => step.status !== 'completed') ||
        !ledger.runs.some(run => run.case_id === caseId && (run.revision ?? 1) === revision && run.run_id === saved.run.id) ||
        ledger.attempts.some(attempt => attempt.kind === 'rerank' && ledger.runs.some(run =>
          run.case_id === caseId && (run.revision ?? 1) === revision && run.run_id === attempt.run_id)))
        throw new Error('Existing live revision has no safely resumable pre-dispatch handoff')
      // 只恢复已提交、已收到明确响应的步骤；绝不重跑模型。日期仅转换数据库列，不碰JSON证据。
      const dates = (row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, value && (key.endsWith('At') || key === 'leaseExpiresAt') ? new Date(value as string) : value]))
      await copyFiles(saved.candidates.map((row: any) => row.fileId))
      await db.insert(schema.agentRuns).values(dates(saved.run) as any)
      await db.insert(schema.agentRunAuthorizations).values(dates(saved.authorization) as any)
      for (const step of saved.steps) await db.insert(schema.agentRunSteps).values(dates(step) as any)
      for (const candidate of saved.candidates) await db.insert(schema.agentRunCandidates).values(dates(candidate) as any)
      if (!localBudgetFinish) await db.insert(schema.agentRerankRuns).values({ id: randomUUID(), agentRunId: saved.run.id, attemptNo: 1,
        completionStatus: 'succeeded', protocolVersion: AGENT_RERANK_POLICY.protocolVersion,
        maxCostCny: String(AGENT_RERANK_POLICY.maximumCostCny) })
      enhanced = saved.run
      if (localBudgetFinish) {
        await writeFile(`${root}/${artifactPrefix}-before-local-finish.json`, JSON.stringify(saved, null, 2))
        phase = 'resume_local_budget_finish'
        await executor.runOnce()
        await dump(enhanced.id, 'enhanced')
      }
    } else {
    enhanced = await createDurableAgentRun(db, { prompt: testCase.query, retrievalAgent: true,
      allowExternalText: true, allowExternalMediaText: true, allowExternalVisual: true, allowExternalSceneVisual: sceneVision,
      allowExternalRetrievalVisual: Boolean(matchedApproval),
      libraryIds: testCase.request.library_ids, mediaTypes: testCase.request.media_types, searchScope: testCase.scope })
    activeRunId = enhanced.id
    ledger.runs.push({ case_id: caseId, revision, run_id: enhanced.id, workflow: 'retrieval_agent', snapshot_fingerprint: snapshot.fingerprint,
      local_preparation_only: !live,
      ...(authorizedBatch ? { authorization: authorizedBatch, reused_confirmed_intent_from: reusedIntentPrefix,
        independent_model_budget: 'maximum_model_calls_per_run' in authorizedBatch ? authorizedBatch.maximum_model_calls_per_run : 0,
        ...(selectionControl ? { decision_model_substitute: true, autonomous_glm_supplement: false } : {}),
      } : {}),
      independently_authorized: { user_text: true, media_text: true, derived_images: true, scene_visual: sceneVision, matched_visual: Boolean(matchedApproval) }, ...(deepseek ? { deepseek_authorization: diagnosticApproval ?? deepseekAuthorization, matched_material_approval: matchedApproval, position_budget_supplement: positionBudgetSupplement, reused_confirmed_intent_from: reuseIntentFrom ?? null } : {}) }); await save()
    for (let i = 0; i < 30; i++) {
      // 测试协议的累计额度不等于单任务额度。额度耗尽前停止计划，避免本地预算
      // 拒绝被HTTP Runner误分类为已外发未知；已保存的动作仍可本地执行，绝不重放模型。
      const previous = (await getDurableAgentRun(db, enhanced.id))!
      const savedState = [...previous.steps].reverse().find(step => (step.outputJson as any)?.retrieval_state)?.outputJson as any
      if (!selectionControl && ledger.attempts.filter(attempt => attempt.kind === (deepseek ? 'deepseek_agent' : 'glm')).length >= (deepseek ? maximumDeepseekAgentCalls : maximumGlmCalls) &&
        (previous.run.status !== 'searching' || (savedState?.retrieval_state.baseline && !savedState.retrieval_state.pending &&
          savedState.retrieval_state.tool_calls < settings.agentMaxSteps && !localBudgetStop(savedState.retrieval_state))))
        throw new Error('Authorized GLM count exhausted before next model step')
      await executor.runOnce()
      const current = (await getDurableAgentRun(db, enhanced.id))!
      await dump(enhanced.id, 'enhanced')
      console.log(JSON.stringify({ case_id: caseId, step: i + 1, status: current.run.status, candidate_count: current.candidates.length,
        glm_dispatches: ledger.attempts.filter(attempt => attempt.kind === 'glm').length, deepseek_dispatches: ledger.attempts.filter(attempt => attempt.kind === 'deepseek_agent').length }))
      if (!['queued', 'extracting_intent', 'searching'].includes(current.run.status)) break
    }
    }
    const enhancedValue = await dump(enhanced.id, 'enhanced')
    phase = 'create_baseline'
    if (enhancedValue.run.status !== 'ranking' && !(caseId === 'empty' && enhancedValue.run.status === 'succeeded' && enhancedValue.candidates.length === 0)) throw new Error('Enhanced retrieval did not reach a known ranking handoff; stop paid validation')
    const committed = await legacy.loadCommittedIntent(enhanced.id)
    // 对照固定使用本次同一份真实意图与硬范围，不为同一意图再付费，也不让范围随机变化。
    const baselineIntent = { isReady: () => true, fingerprint: () => 'reuse-confirmed-intent', extract: async () => ({
      intent: committed.intent, conditions: committed.conditions.map(({ condition_id: _id, ...condition }) => condition), provider: committed.provider,
    }) }
    const baselineHandler = new ConfirmedIntentHandler(db, settings, baselineIntent, searchProxy)
    const baselineExecutor = new AgentExecutorService(db, settings, baselineHandler)
    const baseline = await createDurableAgentRun(db, { prompt: testCase.query, retrievalAgent: false,
      allowExternalText: true, allowExternalMediaText: false, allowExternalVisual: true,
      libraryIds: testCase.request.library_ids, mediaTypes: testCase.request.media_types, searchScope: testCase.scope })
    ledger.runs.push({ case_id: caseId, revision, run_id: baseline.id, workflow: 'legacy', reused_confirmed_intent_from: enhanced.id,
      local_preparation_only: !live,
      independently_authorized: { user_text: true, media_text: false, derived_images: true } }); await save()
    await baselineExecutor.runOnce(); await baselineExecutor.runOnce()
    const base = (await getDurableAgentRun(db, baseline.id))!
    const state = [...enhancedValue.steps].reverse().find(step => (step.outputJson as any)?.retrieval_state)?.outputJson as any
    const baselineKeys = base.candidates.map(row => row.candidateKey)
    if (JSON.stringify(state.retrieval_state.baseline?.candidate_keys ?? state.retrieval_state.queries[0]?.candidate_keys) !== JSON.stringify(baselineKeys)) throw new Error('Baseline candidates differ before rerank')
    // 空结果任务有正常的终态，不需要图片重排。仍执行相同意图的旧流程，
    // 保存双方真实空名单；不能为了满足脚本的ranking断言制造候选或外发。
    if (caseId === 'empty') {
      if (base.run.status !== 'succeeded' || base.candidates.length || enhancedValue.candidates.length) throw new Error('Baseline candidates differ for empty case')
      await dump(baseline.id, 'baseline'); await dump(enhanced.id, 'experimental')
      await writeFile(`${root}/${artifactPrefix}-comparison.json`, JSON.stringify({ baseline_run_id: baseline.id, enhanced_run_id: enhanced.id, same_rerank_input: true, experimental_candidate_keys: [], no_results: true, actual_rerank_dispatches_this_revision: 0, confirmed_baseline_result_reused_for_comparison: false, note: 'Both committed workflows returned no candidates. No image rerank request exists.' }, null, 2))
    } else {
    phase = 'prepare_baseline_images'
    await attachEvidence(baseline.id, baselineKeys)
    activeRunId = baseline.id
    // 真实产品重排：独立授权、身份/文件/图片指纹、请求大小、派发与回表均沿用正式服务。
    const rerank = new AgentRerankService(db, controlledProvider, settings, { createEvidence: async () => { throw new Error('Missing prepared Worker evidence') } } as never)
    const experimentKeys: string[] = state.retrieval_state.experimental_candidate_keys ?? baselineKeys
    if (selectionControl && JSON.stringify(experimentKeys) !== JSON.stringify(controlledSearch.selection.candidate_keys))
      throw new Error('Baseline candidates or controlled selection differ from reviewed pool')
    if (prepareHandoff) {
      // 申请新增图片调用前把两份实际请求准备好，只做本地编码/校验，绝不tick派发。
      await attachEvidence(enhanced.id, experimentKeys)
      const baselinePreflight = await rerank.preflightForAgentRun(baseline.id)
      const experimentalPreflight = await rerank.preflightForAgentRun(enhanced.id)
      const requiredCalls = baselinePreflight.request_sha256 === experimentalPreflight.request_sha256 ? 1 : 2
      await dump(baseline.id, 'baseline'); await dump(enhanced.id, 'enhanced')
      await writeFile(`${root}/${artifactPrefix}-preflight.json`, JSON.stringify({ case_id: caseId, fingerprint: snapshot.fingerprint,
        baseline: baselinePreflight, experimental: experimentalPreflight, required_rerank_calls: requiredCalls,
        maximum_estimated_cost_cny: requiredCalls * AGENT_RERANK_POLICY.maximumCostCny,
        rerank_external_calls: 0, pending_additional_authorization: !goalBatch && !diagnosticApproval }, null, 2))
      console.log(JSON.stringify({ case_id: caseId, prepared_handoff: true, required_rerank_calls: requiredCalls, rerank_external_calls: 0 }))
    } else {
    if (selectionControl) {
      // 比对先前获批的两份实际编码；授权不是任意20个场景的外发许可。
      await attachEvidence(enhanced.id, experimentKeys)
      const b = await rerank.preflightForAgentRun(baseline.id)
      const e = await rerank.preflightForAgentRun(enhanced.id)
      // 新诊断许可绑定25场景及原查询；恢复还须匹配此前零外发准备的两份确切请求。
      // 旧猫案例继续使用旧专用授权摘要，不能扩大到其他名单。
      const priorPrepared = diagnosticApproval ? JSON.parse(await readFile(`${root}/${artifactPrefix}-preflight.json`, 'utf8')) : null
      if (diagnosticApproval && (priorPrepared.case_id !== caseId || priorPrepared.fingerprint !== snapshot.fingerprint ||
        priorPrepared.rerank_external_calls !== 0)) throw new Error('Frozen index or diagnostic handoff changed; no dispatch')
      if (b.request_sha256 !== (priorPrepared?.baseline.request_sha256 ?? selectionControlAuthorization!.baseline_request_sha256) ||
        e.request_sha256 !== (priorPrepared?.experimental.request_sha256 ?? selectionControlAuthorization!.experimental_request_sha256))
        throw new Error('Frozen index or approved request changed; no dispatch')
      await writeFile(`${root}/${artifactPrefix}-approved-preflight.json`, JSON.stringify({ baseline: b, experimental: e,
        authorization: diagnosticApproval ?? selectionControlAuthorization, fingerprint: snapshot.fingerprint, external_calls: 0,
        autonomous_glm_supplement: false }, null, 2))
    }
    // 第5次仅针对已批准的冻结请求；预检先于tick，摘要不符时没有派发状态或计费。
    if (!authorizedBatch && additionalAuthorization && caseId === additionalAuthorization.case_id) {
      const prepared = await rerank.preflightForAgentRun(baseline.id)
      if (prepared.request_sha256 !== additionalAuthorization.request_sha256 || prepared.query !== additionalAuthorization.query)
        throw new Error('Frozen index or approved request changed; no additional dispatch')
      await writeFile(`${root}/${artifactPrefix}-approved-preflight.json`, JSON.stringify({ ...prepared,
        authorization: additionalAuthorization, fingerprint: snapshot.fingerprint }, null, 2))
    }
    // 先确认完成整对照所需的次数和最坏费用，避免在标为外发后才发现本地预算拒绝。
    // 同输入只需要一次；不同输入需要两次，不能先消耗基线费用再假装另一份已验证。
    await attachEvidence(enhanced.id, experimentKeys)
    const basePreflight = await rerank.preflightForAgentRun(baseline.id)
    const enhancedPreflight = await rerank.preflightForAgentRun(enhanced.id)
    const needed = basePreflight.request_sha256 === enhancedPreflight.request_sha256 ? 1 : 2
    if (ledger.attempts.filter(row => row.kind === 'rerank').length + needed > maximumRerankCalls ||
      !verificationCostFits(maximumTotalCost, ledger.carried_prior_estimate_and_reserve_cny, ledger.attempts,
        needed * AGENT_RERANK_POLICY.maximumCostCny))
      throw new Error('Authorized rerank pair budget exhausted before dispatch')
    phase = 'baseline_rerank'
    await rerank.tick(baseline.id); await dump(baseline.id, 'baseline')
    if ((await getDurableAgentRun(db, baseline.id))!.run.status !== 'succeeded') throw new Error('Baseline rerank failed or unknown; no replay')
    if (JSON.stringify(experimentKeys) === JSON.stringify(baselineKeys)) {
      await attachEvidence(enhanced.id, experimentKeys)
      // 同字节输入的已确认响应只在隔离验收副本复用，用于核对增强链末端和页面顺序。
      // 这不是新的真实请求；外发次数以本协议 ledger 为准，不能把副本的步骤计数当账单。
      const reuseProvider: AgentRerankProvider = { available: true, rerank: async input => {
        if (!confirmedRerank || inputHash(input) !== confirmedRerank.input_sha256) throw new Error('Confirmed rerank input differs; no replay')
        return confirmedRerank.result
      } }
      await new AgentRerankService(db, reuseProvider, settings, { createEvidence: async () => { throw new Error('Missing prepared Worker evidence') } } as never).tick(enhanced.id)
      const completed = await dump(enhanced.id, 'experimental')
      if (completed.run.status !== 'succeeded') throw new Error('Confirmed response reuse did not finish local enhanced chain')
      await writeFile(`${root}/${artifactPrefix}-comparison.json`, JSON.stringify({ baseline_run_id: baseline.id, enhanced_run_id: enhanced.id,
        same_rerank_input: true, confirmed_baseline_result_reused_for_comparison: true, ...(reuseReceived ? { historical_received_response_reused: true, reused_from: reuseReceived, actual_rerank_dispatches_this_revision: 0, source_request_sha256: cachedLedger!.request_sha256 } : {}), experimental_candidate_keys: experimentKeys,
        note: 'No extra rerank needed for identical input. This does not validate unseen supplemental candidates.' }, null, 2))
    } else {
      // 隔离任务已经通过同一选择入口冻结实验子集；正式缺少质量资格时仍采用baseline。
      await attachEvidence(enhanced.id, experimentKeys); activeRunId = enhanced.id
      await rerank.tick(enhanced.id); await dump(enhanced.id, 'experimental')
      if ((await getDurableAgentRun(db, enhanced.id))!.run.status !== 'succeeded') throw new Error('Experimental rerank failed or unknown; no replay')
      await writeFile(`${root}/${artifactPrefix}-comparison.json`, JSON.stringify({ baseline_run_id: baseline.id,
        enhanced_run_id: enhanced.id, same_rerank_input: false, confirmed_baseline_result_reused_for_comparison: false,
        ...(selectionControl ? { decision_model_substitute: true, source: 'local_selection_control', autonomous_glm_supplement: false } : {}),
        experimental_candidate_keys: experimentKeys }, null, 2))
    }
    }
    }
  }
} catch (error) {
  const safeReasons = ['Existing live', 'Enhanced retrieval', 'Baseline candidates', 'Baseline rerank', 'Current Worker', 'Worker artifact', 'Unknown dispatch', 'Unknown usage', 'Authorized', 'Frozen index', 'Intent narrowed', 'Local Worker review preparation failed:', 'Verification ledger']
  const reason = error instanceof Error && safeReasons.some(prefix => error.message.startsWith(prefix)) ? error.message : 'local_or_provider_validation_failed'
  console.log(JSON.stringify({ case_id: caseId, acceptance_stopped: true, phase, reason, error_type: error instanceof Error ? error.constructor.name : null, error_code: error instanceof AgentStepExecutionError ? error.code : typeof (error as any)?.cause?.code === 'string' ? (error as any).cause.code : null }))
  stopped = true
} finally {
  if (snapshot.fingerprint !== await corpusFingerprint(pool)) {
    console.log(JSON.stringify({ index_changed: true, quality_accepted: false })); stopped = true
  }
  if (lock) await save()
  await isolated.close(); await pool.end()
  if (lock) await rm(`${root}/live.lock`, { recursive: true })
  // PGlite/WASM关闭可能更新进程退出状态；必须在清理之后恢复验收失败码，批处理才能停止。
  process.exitCode = stopped ? 1 : 0
}
