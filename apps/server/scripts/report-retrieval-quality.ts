import { extendRetrievalReviewPool } from '../src/agent/retrieval-review-pool.js'
/**
 * 零模型调用的质量报告。只复用用户确认过的人工标签，逐文件核对 generation；
 * 冲突与缺失保持null。初始候选策略与真实最终重排分开，不能用前者冒充后者验收。
 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { compareRetrievalQuality, summarizeRetrievalQualityAcceptance, validateHumanReviewLabels } from '../src/agent/retrieval-quality.js'
import { calculateRankingMetrics } from '../src/ranking/metrics.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const suiteRevision = Number(process.argv.find(arg => arg.startsWith('--suite-revision='))?.split('=')[1] ?? 0)
if (suiteRevision && (!Number.isInteger(suiteRevision) || suiteRevision < 7)) throw new Error('Invalid suite revision')
const caseRevisions = Object.fromEntries((process.argv.find(arg => arg.startsWith('--case-revisions='))?.split('=')[1] ?? '').split(',').filter(Boolean).map(value => {
  const [id, version] = value.split(':'); const number = Number(version)
  if (!['cat','action','position','exclusion','multi','empty'].includes(id) || !Number.isInteger(number) || number < 7) throw new Error('Invalid case revision override')
  return [id, number]
}))
const catRevision = Number(process.argv.find(arg => arg.startsWith('--cat-revision='))?.split('=')[1] ?? 2)
if (!Number.isInteger(catRevision) || catRevision < 2) throw new Error('Invalid comparison revision')
const snapshot = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const ledger = JSON.parse(await readFile(`${root}/live-ledger.json`, 'utf8'))
const pool = new Pool({ connectionString: createSettings(process.env).databaseUrl, options: '-c default_transaction_read_only=on' })
const optional = async (path: string) => {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
try {
  const human = await optional(`${root}/human-labels.json`)
  // 标签文件的指纹正确仍不足以证明当前素材没变；报告前后均重新读取冻结摘要。
  if (snapshot.fingerprint !== await corpusFingerprint(pool)) throw new Error('Frozen index changed; no quality report')
  const generations = new Map<string, number>((await pool.query('select id,index_generation from media_files where deleted_at is null')).rows.map(row => [row.id, row.index_generation]))
  const definitions = snapshot.cases.map((row: any) => ({ id: row.id, query: row.query, scope: row.scope,
    media_types: row.request.media_types, library_ids: row.request.library_ids,
    candidate_keys: row.results.map((result: any) => result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`) }))
  const extension = await optional(`${root}/review-extension.json`)
  const reviewPool = extension ? extendRetrievalReviewPool(definitions, extension, snapshot.fingerprint, generations) : definitions
  const humanLabels = human ? validateHumanReviewLabels(human, snapshot.fingerprint, reviewPool) : []
  const extraHuman = await optional(`${root}/human-labels-supplemental.json`)
  const supplementalLabels = extraHuman ? validateHumanReviewLabels(extraHuman, snapshot.fingerprint, reviewPool) : []
  // 补标文件不能悄悄覆盖已确认的人工标签；相同等级可复用，冲突直接停止报告。
  for (const label of supplementalLabels) {
    const prior = humanLabels.find(row => row.case_id === label.case_id && row.candidate_key === label.candidate_key)
    if (prior && prior.relevance !== label.relevance) throw new Error('Conflicting supplemental human label')
    if (!prior) humanLabels.push(label)
  }
  const cases = []
  for (const testCase of snapshot.cases) {
    const keys: string[] = testCase.results.map((result: any) => result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`)
    const judgments: Record<string, 0 | 1 | 2 | null> = {}
    const conflicts: string[] = []
    for (const result of testCase.results) {
      const key = result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`
      const labels = testCase.reusable_labels.filter((label: any) => label.file_id === result.file_id &&
        label.file_generation === generations.get(result.file_id) &&
        (result.scene_id ? label.scene_id === result.scene_id : label.candidate_key === result.asset_id))
      const values = [...new Set(labels.map((label: any) => label.relevance))]
      judgments[key] = values.length === 1 ? values[0] as 0 | 1 | 2 : null
      if (values.length > 1) conflicts.push(key)
    }
    for (const label of humanLabels) if (label.case_id === testCase.id) {
      judgments[label.candidate_key] = label.relevance
    }
    const control = await optional(`${root}/${suiteRevision ? `${testCase.id}-r${caseRevisions[testCase.id] ?? suiteRevision}` : testCase.id}-local-control.json`)
    if (control && control.fingerprint !== snapshot.fingerprint) throw new Error('Local control fingerprint mismatch')
    const initial = control ? compareRetrievalQuality({ baseline: control.baseline_candidate_keys.slice(0, 10),
      enhanced: control.enhanced_candidate_keys.slice(0, 10), pool: keys, judgments, target: testCase.target }) : null
    const prefix = suiteRevision ? `${testCase.id}-r${caseRevisions[testCase.id] ?? suiteRevision}` : testCase.id === 'cat' ? `cat-r${catRevision}` : testCase.id
    const baseline = await optional(`${root}/${prefix}-baseline.json`)
    const executed = await optional(`${root}/${prefix}-enhanced.json`)
    const lastState = [...(executed?.steps ?? [])].reverse().find((step: any) => step.outputJson?.retrieval_state)?.outputJson.retrieval_state
    const runRecord = ledger.runs.find((row: any) => row.run_id === executed?.run.id)
    const decisionConfiguration = lastState ? { model: lastState.model_configuration, budget: lastState.budget?.limits, evidence_protocol: lastState.evidence_protocol, maximum_retries: runRecord?.deepseek_authorization?.maximum_retries_per_run ?? null } : null
    const experiment = await optional(`${root}/${prefix}-experimental.json`)
    const comparison = await optional(`${root}/${prefix}-comparison.json`)
    const realFinal = baseline?.run.status === 'succeeded' && comparison
      ? compareRetrievalQuality({ baseline: baseline.page.candidates.map((row: any) => row.candidate_key),
        enhanced: comparison.same_rerank_input ? baseline.page.candidates.map((row: any) => row.candidate_key)
          : experiment?.page.candidates.map((row: any) => row.candidate_key) ?? [],
        // 与正式资格重算完全相同：本轮基线与实际选中名单的并集。
        // 已补标却未选入的预检候选不改变本轮nDCG理想排序分母。
        pool: [...keys, ...(comparison.experimental_candidate_keys ?? [])], judgments, target: testCase.target }) : null
    // 已指定的人类目标的Hit不依赖其他候选标签；独立诊断不能替代缺失的P/nDCG验收。
    const targetHit = testCase.target === null ? null : { initial: calculateRankingMetrics(keys, new Map(), { knownTargetKey: testCase.target }).hitAt10,
      real_final: baseline?.run.status === 'succeeded' ? calculateRankingMetrics(baseline.page.candidates.map((row: any) => row.candidate_key),
        new Map(), { knownTargetKey: testCase.target }).hitAt10 : null }
    cases.push({ id: testCase.id, artifact_revision: suiteRevision ? caseRevisions[testCase.id] ?? suiteRevision : testCase.id === 'cat' ? catRevision : 1, query: testCase.query, initial_count: keys.length, review_pool_count: reviewPool.find((row: any) => row.id === testCase.id)!.candidate_keys.length, human_label_count: reviewPool.find((row: any) => row.id === testCase.id)!.candidate_keys.filter((key: string) => judgments[key] !== null && judgments[key] !== undefined).length,
      decision_configuration: decisionConfiguration, qualification_configuration_fingerprint: lastState?.selection?.configuration_fingerprint ?? null, actual_agent_status_before_rerank: executed?.run.status ?? null, actual_agent_stop_reason: lastState?.stop_reason ?? null, actual_scene_observation_count: Object.values(lastState?.scene_inspections ?? {}).filter((row: any) => row.status === 'observed').length, judgments, label_conflicts: conflicts, comparison_baseline_run_id: comparison?.baseline_run_id ?? null,
      actual_matched_image_requests: ledger.attempts.filter((a: any) => a.run_id === executed?.run.id && a.evidence_protocol === 'matched-multimodal-v1' && a.image_count > 0).length,
      actual_matched_images_sent: ledger.attempts.filter((a: any) => a.run_id === executed?.run.id && a.evidence_protocol === 'matched-multimodal-v1').reduce((sum: number, a: any) => sum + (a.image_count ?? 0), 0),
      actual_supplementary_queries: lastState?.queries?.slice(1).map((q: any) => ({ query: q.query, candidate_count: q.candidate_keys.length })) ?? [],
      comparison_enhanced_run_id: comparison?.enhanced_run_id ?? null, target_hit_diagnostic_only: targetHit, initial_baseline_policy_only: initial, real_final_comparison: realFinal,
      evidence: comparison ? { same_rerank_input: comparison.same_rerank_input,
        supplemental_candidates: (comparison.experimental_candidate_keys ?? []).filter((key: string) => !keys.includes(key)).length,
        // 受控名单真实重排可以验选择策略，但不能被汇总成GLM自主补搜已通过。
        decision_model_substitute: comparison.decision_model_substitute === true,
        experiment_source: comparison.source ?? 'agent_run',
        response_reused: comparison.confirmed_baseline_result_reused_for_comparison, historical_response_reused: comparison.historical_received_response_reused === true, actual_rerank_dispatches_this_revision: comparison.actual_rerank_dispatches_this_revision ?? null, source_request_sha256: comparison.source_request_sha256 ?? null } : null,
      accepted: realFinal?.status === 'non_decreasing' || (testCase.id === 'empty' && initial?.status === 'non_decreasing') })
  }
  const known = ledger.attempts.reduce((sum: number, attempt: any) => sum + (attempt.estimated_cost_cny ?? 0), 0)
  const unknown = ledger.attempts.filter((attempt: any) => attempt.estimated_cost_cny === null)
  const acceptance = summarizeRetrievalQualityAcceptance(cases.map(row => ({ accepted: row.accepted,
    supplemental_candidates: row.evidence?.supplemental_candidates ?? 0,
    changed_rerank_input: row.evidence === null ? null : !row.evidence.same_rerank_input })))
  const report = { suite_revision: suiteRevision || null, case_revisions: caseRevisions, protocol: snapshot.protocol, fingerprint: snapshot.fingerprint, human_label_provenance: '26 existing labels confirmed by user; 74 missing labels manually selected by user in human-review.html and transcribed without model grading on 2026-10-05',
    // 补标来自用户页面实际选择；与原始100条来源分开记录，不能冒充模型真值。
    supplemental_human_label_count: supplementalLabels.length,
    supplemental_label_provenance: supplementalLabels.length ? 'User-selected labels from human-review-supplemental.html; copied without model grading' : null,
    ...acceptance,
    final_rerank_requests_verified_against_received_source: cases.filter(row => row.id !== 'empty').every(row => row.evidence?.historical_response_reused === true),
    retrieval_decision_configuration_frozen_across_cases: cases.every(row => row.decision_configuration) && new Set(cases.map(row => JSON.stringify(row.decision_configuration))).size === 1 && new Set(cases.map(row => row.qualification_configuration_fingerprint).filter(Boolean)).size === 1,
    // 配置相同不表示每条视觉查询都真正外发：费用门可在准备后停止。
    current_protocol_all_visual_cases_dispatched: cases.filter(row => row.id !== 'empty').every(row => row.actual_matched_image_requests > 0),
    // 当前报告用于已实际返回名单的基线保护，不能生成混合版本增强推广资格。
    validation_model: cases.some(row => row.decision_configuration?.evidence_protocol === 'matched-multimodal-v1') ? 'deepseek-v4-flash_unified_matched_evidence_decision' : suiteRevision >= 30 ? (cases.some(row => row.actual_scene_observation_count > 0) ? 'deepseek-v4-flash_with_sampled_scene_observation' : 'deepseek-v4-flash_text_only') : 'glm-5.3',
    validation_scope: suiteRevision >= 30 ? 'recorded_baseline_protection_with_configuration_audit_and_received_rerank_reuse' : cases.some(row => row.evidence?.decision_model_substitute)
      ? 'historical_baseline_protection_plus_local_selection_control' : 'recorded_agent_runs',
    autonomous_agent_supplement_verified: cases.some(row => row.evidence && !row.evidence.decision_model_substitute &&
      row.evidence.supplemental_candidates > 0 && row.evidence.same_rerank_input === false && row.accepted),
    // 历史字段名只描述GLM；DeepSeek自主动作另见上面通用字段，不能冒充GLM实测。
    autonomous_glm_supplement_verified: cases.some(row => row.decision_configuration?.model?.model === 'glm-5.3' && row.evidence && !row.evidence.decision_model_substitute && row.evidence.supplemental_candidates > 0 && row.evidence.same_rerank_input === false && row.accepted),
    // 兼容旧字段：quality_accepted只代表本冻结集。产品选择资格必须另看上面的增强字段。
    quality_accepted: cases.every(row => row.accepted), formal_result_mode: 'baseline', cases,
    usage: { glm_dispatches: ledger.attempts.filter((row: any) => row.kind === 'glm').length,
      deepseek_probe_dispatches: ledger.attempts.filter((row: any) => row.kind === 'deepseek_probe').length,
      deepseek_agent_dispatches: ledger.attempts.filter((row: any) => row.kind === 'deepseek_agent').length,
      deepseek_total_estimate_and_reserve_cny: ledger.attempts.filter((row: any) => row.kind?.startsWith('deepseek')).reduce((sum: number, row: any) => sum + (row.estimated_cost_cny ?? row.reserve_cny), 0),
      rerank_dispatches: ledger.attempts.filter((row: any) => row.kind === 'rerank').length,
      known_estimated_cost_cny: known, unknown_estimate_attempts: unknown.length,
      conservative_total_with_prior_reserve_cny: ledger.carried_prior_estimate_and_reserve_cny + known + unknown.reduce((sum: number, row: any) => sum + row.reserve_cny, 0),
      billed_cost_cny: null, unknown_billed_attempts: ledger.attempts.length,
      total_latency_ms: ledger.attempts.reduce((sum: number, row: any) => sum + row.latency_ms, 0) },
    limits: ['No complete recall claim', 'Initial policy equality does not validate enhanced semantic quality',
      'Reused confirmed response is not an independent new model measurement', 'Finite samples do not guarantee future non-regression',
      'Local selection-control decisions do not prove autonomous Agent search or current-protocol quality qualification',
      'Equal configuration does not prove every visual case dispatched a current-protocol decision',
      'Unknown labels never become zero; missing final pairs remain unaccepted', 'Actual provider bills unavailable'] }
  if (snapshot.fingerprint !== await corpusFingerprint(pool)) throw new Error('Index changed during report; no accepted report')
  await writeFile(`${root}/${suiteRevision ? `quality-report-suite-r${suiteRevision}` : catRevision === 2 ? 'quality-report' : `quality-report-cat-r${catRevision}`}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ accepted: report.quality_accepted,
    frozen_suite_accepted: report.frozen_suite_accepted,
    enhanced_selection_quality_accepted: report.enhanced_selection_quality_accepted,
    formal_result_mode: report.formal_result_mode,
    cases: cases.map(row => ({ id: row.id, human_labels: row.human_label_count,
    initial: row.initial_baseline_policy_only?.status ?? 'not_run', final: row.real_final_comparison?.status ?? 'not_run' })), usage: report.usage }))
} finally { await pool.end() }
