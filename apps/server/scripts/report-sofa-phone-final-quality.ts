/** 消费已确认真实响应和用户标签，按页面最终顺序比较两份名单。
 * 只读生产素材版本；不调用模型、不修改标签、不授予产品质量资格。
 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { compareRetrievalQuality, validateHumanReviewLabels } from '../src/agent/retrieval-quality.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
import { sofaPhoneDiagnosticSnapshot } from './retrieval-sofa-phone-authorization.js'
loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const read = async (file: string) => JSON.parse(await readFile(`${root}/${file}.json`, 'utf8'))
const frozen = await read('sofa-phone/frozen')
sofaPhoneDiagnosticSnapshot(frozen)
const human = await read('sofa-phone/human-labels')
const keys: string[] = frozen.candidates.map((row: any) => row.candidateKey)
if (human.freeze_sha256 !== frozen.freeze_sha256 || human.query !== frozen.query || human.corpus_fingerprint !== frozen.corpus_fingerprint)
  throw new Error('Human review freeze mismatch')
const labels = validateHumanReviewLabels({ ...human, fingerprint: human.freeze_sha256 }, frozen.freeze_sha256,
  [{ id: frozen.case_id, candidate_keys: keys }])
if (labels.length !== 25 || labels.some(row => row.relevance === null || !human.labels.some((label: any) =>
  label.candidate_key === row.candidate_key && label.review_status !== 'not_reviewed' &&
  label.file_generation === frozen.candidates.find((candidate: any) => candidate.candidateKey === row.candidate_key)?.fileGeneration)))
  throw new Error('Human labels incomplete or stale')
const baseline = await read('sofa-phone-r49-baseline'), experimental = await read('sofa-phone-r49-experimental')
const autonomous = await read('sofa-phone-r48-enhanced'), comparison = await read('sofa-phone-r49-comparison')
const preflight = await read('sofa-phone-r49-preflight'), ledger = await read('live-ledger')
const judgments = Object.fromEntries(labels.map(row => [row.candidate_key, row.relevance]))
/** 对照实际接口返回顺序与已提交重排名次；步骤成功本身不代表质量达标。 */
const finalKeys = (dump: any, expected: string) => {
  if (dump.run.status !== 'succeeded' || dump.run.prompt !== frozen.query || dump.page.status !== 'succeeded')
    throw new Error('Final result not completed')
  const ranking = dump.rankings.filter((row: any) => row.rerankRank !== null)
    .sort((a: any, b: any) => a.rerankRank - b.rerankRank).map((row: any) => row.candidateKey)
  const page = dump.page.candidates.map((row: any) => row.candidate_key)
  const attempt = dump.rerank_attempts.find((row: any) => row.status === 'succeeded' && row.externalCallStatus === 'completed')
  const received = ledger.attempts.find((row: any) => row.run_id === dump.run.id && row.kind === 'rerank' && row.status === 'received')
  if (JSON.stringify(page) !== JSON.stringify(ranking.slice(0, 10)) || page.length !== 10 ||
    !attempt?.totalTokens || !received?.usage?.total_tokens || received.request_sha256 !== preflight[expected].request_sha256 ||
    received.candidate_keys.some((key: string) => !keys.includes(key))) throw new Error('Final order or confirmed request mismatch')
  return page as string[]
}
const pool = new Pool({ connectionString: createSettings(process.env).databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
try {
  if (await corpusFingerprint(pool) !== frozen.corpus_fingerprint) throw new Error('Corpus changed')
  const files = (await pool.query('select id,index_generation from media_files where deleted_at is null')).rows
  if (frozen.candidates.some((candidate: any) => !files.some(row => row.id === candidate.fileId && row.index_generation === candidate.fileGeneration)))
    throw new Error('File generation changed')
  if (comparison.source !== 'local_selection_control' || !comparison.decision_model_substitute || comparison.same_rerank_input ||
    autonomous.page.retrieval.queries.length !== 1) throw new Error('Unexpected experiment provenance')
  const b = finalKeys(baseline, 'baseline'), e = finalKeys(experimental, 'experimental')
  const quality = compareRetrievalQuality({ baseline: b, enhanced: e, pool: keys, judgments, target: null })
  const attempts = ledger.attempts.filter((row: any) => [baseline.run.id, experimental.run.id, autonomous.run.id].includes(row.run_id))
  if (attempts.length !== 4 || attempts.some((row: any) => row.status !== 'received' || !row.usage?.total_tokens || row.estimated_cost_cny === null))
    throw new Error('Batch usage incomplete')
  // 历史未知用量继续用正数预留，绝不能按零汇总；金额是本地估算，账单仍未知。
  const held = (rows: any[]) => rows.reduce((sum, row) => sum + (row.estimated_cost_cny ?? row.reserve_cny), 0)
  const report = { case_id: frozen.case_id, query: frozen.query, freeze_sha256: frozen.freeze_sha256,
    corpus_fingerprint: frozen.corpus_fingerprint, human_label_count: labels.length,
    grades: { fully_matching: labels.filter(row => row.relevance === 2).length, partly_related: labels.filter(row => row.relevance === 1).length,
      unrelated: labels.filter(row => row.relevance === 0).length },
    model_autonomous_supplement_executed: false, real_model_stop_reason: autonomous.page.retrieval.stop_reason,
    model_candidate_count: autonomous.page.retrieval.queries[0].candidate_keys.length,
    final_comparison_origin: 'independent_local_selection_control_not_autonomous_agent', quality,
    final_page_order_verified: true, baseline_final_keys: b, experimental_final_keys: e,
    rerank_inputs: { baseline: preflight.baseline.candidate_keys, experimental: preflight.experimental.candidate_keys,
      added: preflight.experimental.candidate_keys.filter((key: string) => !preflight.baseline.candidate_keys.includes(key)),
      lost: preflight.baseline.candidate_keys.filter((key: string) => !preflight.experimental.candidate_keys.includes(key)) },
    full_condition_precision_at_5: { baseline: b.slice(0, 5).filter(key => judgments[key] === 2).length / 5,
      experimental: e.slice(0, 5).filter(key => judgments[key] === 2).length / 5 },
    metric_rules: { precision_relevance_threshold: 1, fixed_precision_denominator: 5, ndcg_cutoff: 10, ideal_pool_size: 25,
      hit_at_10: 'not_applicable_no_predefined_target', recall: 'not_measured_incomplete_corpus_labels', acceptance: 'every_applicable_metric_non_decreasing_per_query' },
    usage: { new_deepseek_calls: 2, new_product_rerank_calls: 2, new_glm_calls: 0,
      known_total_tokens: attempts.reduce((sum: number, row: any) => sum + row.usage.total_tokens, 0),
      http_latency_ms: attempts.reduce((sum: number, row: any) => sum + row.latency_ms, 0),
      estimated_batch_cost_cny: held(attempts), billed_batch_cost_cny: null,
      cumulative_deepseek_estimate_and_unknown_reserve_cny: held(ledger.attempts.filter((row: any) => row.kind.startsWith('deepseek'))),
      cumulative_historical_estimate_and_unknown_reserve_cny: ledger.carried_prior_estimate_and_reserve_cny + held(ledger.attempts),
      cumulative_call_counts: Object.fromEntries(['glm', 'deepseek_agent', 'deepseek_probe', 'rerank'].map(kind => [kind, ledger.attempts.filter((row: any) => row.kind === kind).length])),
      unknown_usage_attempts: ledger.attempts.filter((row: any) => !row.usage).length },
    frozen_six_query_suite_changed: false, enhanced_quality_accepted: false, formal_result_mode: 'baseline',
    qualification_reason: 'Single local-control diagnostic cannot qualify complete autonomous enhanced agent or existing six-query suite' }
  await writeFile(`${root}/sofa-phone/final-quality-report-r49.json`, JSON.stringify(report, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ quality, usage: report.usage, fully_matching: report.grades.fully_matching, formal_result_mode: report.formal_result_mode }))
} finally { await pool.end() }
