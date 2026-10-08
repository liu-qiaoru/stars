/** 消费用户在新查询页面亲自完成的标签，生成零外发的本地选择诊断。
 * 验证冻结摘要、完整标签池及当前素材版本，复用产品质量指标计算。
 * 搜索初始顺序不能替代最终图片重排，任何本地不下降都不会开启增强资格。
 */
import { loadEnvFile } from 'node:process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
import { compareRetrievalQuality, validateHumanReviewLabels } from '../src/agent/retrieval-quality.js'
import { selectExperimentalCandidates } from '../src/agent/retrieval-candidates.policy.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'
loadEnvFile('../../.env')
const folder = '../../.scratch/retrieval-quality/sofa-phone'
const frozen = JSON.parse(await readFile(`${folder}/frozen.json`, 'utf8'))
const input = JSON.parse(await readFile(`${folder}/human-labels.json`, 'utf8'))
const { freeze_sha256, ...content } = frozen
if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== freeze_sha256 ||
  input.freeze_sha256 !== freeze_sha256 || input.corpus_fingerprint !== frozen.corpus_fingerprint ||
  input.case_id !== frozen.case_id || input.query !== frozen.query) throw new Error('Human labels query or freeze mismatch')
const keys: string[] = frozen.candidates.map((row: any) => row.candidateKey)
// 公共标签校验复用现有实现；本页的freeze_sha256比单一语料摘要更严格地绑定查询和池。
const labels = validateHumanReviewLabels({ ...input, fingerprint: input.freeze_sha256 }, freeze_sha256,
  [{ id: frozen.case_id, candidate_keys: keys }])
if (labels.length !== keys.length || labels.some(row => !input.labels.find((label: any) => label.candidate_key === row.candidate_key &&
  label.review_status !== 'not_reviewed' && label.file_generation === frozen.candidates.find((candidate: any) => candidate.candidateKey === row.candidate_key)?.fileGeneration)))
  throw new Error('Human review incomplete or wrong generation')
const pool = new Pool({ connectionString: createSettings(process.env).databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
try {
  if (await corpusFingerprint(pool) !== frozen.corpus_fingerprint) throw new Error('Reviewed corpus changed')
  const currentFiles = (await pool.query('select id,index_generation from media_files where deleted_at is null')).rows
  for (const candidate of frozen.candidates) if (!currentFiles.some(row => row.id === candidate.fileId && row.index_generation === candidate.fileGeneration))
    throw new Error('Reviewed file generation changed')
  const judgments = Object.fromEntries(labels.map(row => [row.candidate_key, row.relevance]))
  const baseline: string[] = frozen.baseline_candidate_keys
  const probe: string[] = frozen.queries[1].candidate_keys
  const selection = selectExperimentalCandidates(baseline, frozen.queries)
  const compare = (enhanced: string[]) => compareRetrievalQuality({ baseline: baseline.slice(0, 10), enhanced: enhanced.slice(0, 10),
    pool: keys, judgments, target: null })
  const stats = (list: string[]) => ({ total: list.length, fully_matching: list.filter(key => judgments[key] === 2).length,
    partly_related: list.filter(key => judgments[key] === 1).length, unrelated: list.filter(key => judgments[key] === 0).length,
    unknown: list.filter(key => judgments[key] === null).length,
    full_condition_precision_at_5_diagnostic: list.slice(0, 5).filter(key => judgments[key] === 2).length / 5 })
  const added = probe.filter(key => !baseline.includes(key))
  const report = { case_id: frozen.case_id, query: frozen.query, freeze_sha256, corpus_fingerprint: frozen.corpus_fingerprint,
    human_label_provenance: 'User completed 25/25 in the local review page and confirmed completion in chat; grades captured without model grading',
    statistics: { pool: stats(keys), baseline: stats(baseline), manual_probe: stats(probe), local_strategy: stats(selection), local_added: stats(added) },
    local_probe_comparison: compare(probe), local_strategy_comparison: compare(selection),
    full_list_changes: { manual_probe: { added, lost: baseline.filter(key => !probe.includes(key)) },
      strategy: { added: selection.filter(key => !baseline.includes(key)), lost: baseline.filter(key => !selection.includes(key)) } },
    metric_rules: { relevance_threshold_for_precision: 1, precision_denominator: 5, ndcg_cutoff: 10,
      ideal_denominator_pool: keys, hit_at_10: 'not_applicable_no_predefined_target',
      full_condition_precision_diagnostic_only: 'grade 2, fixed denominator 5; supplements the shared metric, does not change its definition' },
    model_autonomous_supplement_executed: false, final_image_rerank_executed: false,
    enhanced_quality_accepted: false, formal_result_mode: 'baseline', external_calls: 0 }
  if (await corpusFingerprint(pool) !== frozen.corpus_fingerprint) throw new Error('Reviewed corpus changed during reporting')
  await writeFile(`${folder}/local-quality-report.json`, JSON.stringify(report, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ label_count: labels.length, statistics: report.statistics,
    probe: { status: report.local_probe_comparison.status, baseline: report.local_probe_comparison.baseline, changed: report.local_probe_comparison.enhanced },
    strategy: { status: report.local_strategy_comparison.status, baseline: report.local_strategy_comparison.baseline, changed: report.local_strategy_comparison.enhanced },
    enhanced_quality_accepted: false, final_rerank_executed: false, external_calls: 0 }))
} finally { await pool.end() }
