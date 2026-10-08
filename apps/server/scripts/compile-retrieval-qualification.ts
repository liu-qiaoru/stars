/** 从完整冻结对照和人工标签编译本地资格；缺任何真实来源则只写待验收清单，不生成可启用文件。 */
import { readFile, writeFile } from 'node:fs/promises'
import { retrievalQualityQualificationSchema } from '@local-media-agent/shared/schemas'
import { selectRetrievalCandidatePlan } from '../src/agent/retrieval-selection.policy.js'
import { RETRIEVAL_FROZEN_QUERIES } from '../src/agent/retrieval-selection.service.js'

const root = '../../.scratch/retrieval-quality'
const suiteRevision = Number(process.argv.find(arg => arg.startsWith('--suite-revision='))?.split('=')[1] ?? 0)
if (suiteRevision && (!Number.isInteger(suiteRevision) || suiteRevision < 7)) throw new Error('Invalid suite revision')
const caseRevisions = Object.fromEntries((process.argv.find(arg => arg.startsWith('--case-revisions='))?.split('=')[1] ?? '').split(',').filter(Boolean).map(value => {
  const [id, version] = value.split(':'); const number = Number(version)
  if (!['cat','action','position','exclusion','multi','empty'].includes(id) || !Number.isInteger(number) || number < 7) throw new Error('Invalid case revision override')
  return [id, number]
}))
const revision = Number(process.argv.find(arg => arg.startsWith('--cat-revision='))?.split('=')[1] ?? 3)
if (!Number.isInteger(revision) || revision < 3) throw new Error('Invalid reviewed revision')
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const ledger = JSON.parse(await readFile(`${root}/live-ledger.json`, 'utf8'))
let quality: any
try { quality = JSON.parse(await readFile(`${root}/${suiteRevision ? `quality-report-suite-r${suiteRevision}` : `quality-report-cat-r${revision}`}.json`, 'utf8')) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; quality = { fingerprint: null, cases: [] } }
const readOptional = async (name: string) => {
  try { return JSON.parse(await readFile(`${root}/${name}`, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
const key = (row: any) => row.scene_id ? `video:${row.scene_id}` : `image:${row.asset_id}`
const blockers: string[] = []
const artifacts: any[] = []
if (quality.fingerprint !== frozen.fingerprint || quality.cases.length !== frozen.cases.length) blockers.push('frozen_report_mismatch')
for (const testCase of frozen.cases) {
  const prefix = suiteRevision ? `${testCase.id}-r${caseRevisions[testCase.id] ?? suiteRevision}` : testCase.id === 'cat' ? `cat-r${revision}` : testCase.id
  const baseline = await readOptional(`${prefix}-baseline.json`)
  const enhanced = await readOptional(`${prefix}-experimental.json`)
  const comparison = await readOptional(`${prefix}-comparison.json`)
  if (testCase.id === 'empty') {
    artifacts.push({ id: testCase.id, query: testCase.query, scope: { search_scope: testCase.scope,
      media_types: testCase.request.media_types, library_ids: testCase.request.library_ids },
      baseline_candidate_keys: [], selected_candidate_keys: [], baseline_final: [], enhanced_final: [], target: null,
      judgments: [], baseline_request: null, enhanced_request: null })
    if (quality.cases.find((row: any) => row.id === 'empty')?.accepted !== true) blockers.push('empty_unaccepted')
    continue
  }
  if (!baseline || !enhanced || !comparison || baseline.run.status !== 'succeeded' || enhanced.run.status !== 'succeeded') {
    blockers.push(`${testCase.id}:final_pair_missing`); continue
  }
  // 对照来源必须保真。替身产生的真实图片排名只能验候选选择风险，不能授予GLM协议资格。
  if (comparison.decision_model_substitute === true || !ledger.attempts.some((row: any) =>
    row.kind === 'glm' && row.run_id === enhanced.run.id && row.status === 'received')) {
    blockers.push(`${testCase.id}:autonomous_decision_provenance_missing`)
    continue
  }
  const state = [...enhanced.steps].reverse().find((step: any) => step.outputJson?.retrieval_state)?.outputJson.retrieval_state
  const baseAttempt = ledger.attempts.find((row: any) => row.kind === 'rerank' && row.run_id === baseline.run.id && row.status === 'received')
  const enhancedAttempt = comparison.same_rerank_input ? baseAttempt
    : ledger.attempts.find((row: any) => row.kind === 'rerank' && row.run_id === enhanced.run.id && row.status === 'received')
  if (!baseAttempt?.request_sha256 || !enhancedAttempt?.request_sha256 || !state?.selection?.configuration_fingerprint) {
    blockers.push(`${testCase.id}:request_or_configuration_provenance_missing`); continue
  }
  artifacts.push({ id: testCase.id, query: testCase.query, scope: { search_scope: testCase.scope,
    media_types: testCase.request.media_types, library_ids: testCase.request.library_ids },
    baseline_candidate_keys: testCase.results.map(key), selected_candidate_keys: state.selection.candidate_keys,
    baseline_final: baseline.page.candidates.map((row: any) => row.candidate_key),
    enhanced_final: enhanced.page.candidates.map((row: any) => row.candidate_key), target: testCase.target,
    configuration: state.selection.configuration_fingerprint, queries: state.queries, baseline_run_id: baseline.run.id, enhanced_run_id: enhanced.run.id,
    baseline_request: { status: 'received', model: 'qwen3-vl-rerank', request_sha256: baseAttempt.request_sha256 },
    enhanced_request: { status: 'received', model: 'qwen3-vl-rerank', request_sha256: enhancedAttempt.request_sha256 } })
}
// 使用只读报告已核对generation、素材指纹和人工来源后的标签，不重新挑选历史等级。
for (const artifact of artifacts) {
  const verdict = quality.cases.find((row: any) => row.id === artifact.id)
  if (artifact.id !== 'empty' && (verdict?.comparison_baseline_run_id !== artifact.baseline_run_id ||
    verdict?.comparison_enhanced_run_id !== artifact.enhanced_run_id)) blockers.push(`${artifact.id}:report_pair_mismatch`)
  const pool = [...new Set<string>([...artifact.baseline_candidate_keys, ...artifact.selected_candidate_keys])]
  artifact.judgments = pool.filter(key => [0, 1, 2].includes(verdict?.judgments?.[key]))
    .map(candidate_key => ({ candidate_key, relevance: verdict.judgments[candidate_key] }))
}
const configurations = new Set(artifacts.filter(row => row.configuration).map(row => row.configuration))
if (configurations.size !== 1) blockers.push('configuration_versions_incomplete')
const qualification = { protocol: 'retrieval-selection-qualification-v1', policy_version: 'evidence-selection-v2',
  report_id: `frozen-human-${suiteRevision ? `suite-r${suiteRevision}` : `cat-r${revision}`}`, label_source: 'human_review', fingerprint: frozen.fingerprint,
  configuration_fingerprint: [...configurations][0] ?? '',
  cases: artifacts.map(({ configuration, queries, baseline_run_id, enhanced_run_id, ...row }) => row) }
const first = artifacts.find(row => row.queries)
const parsed = retrievalQualityQualificationSchema.safeParse(qualification)
if (!parsed.success || !first || selectRetrievalCandidatePlan({ query: first.query, scope: first.scope,
  baseline: first.baseline_candidate_keys, queries: first.queries, fingerprint: frozen.fingerprint,
  configuration_fingerprint: qualification.configuration_fingerprint, stop_reason: 'partial', required_queries: RETRIEVAL_FROZEN_QUERIES },
  { qualification }).result_mode !== 'enhanced') blockers.push('quality_gate_unaccepted')
if (blockers.length) {
  await writeFile(`${root}/qualification-pending.json`, JSON.stringify({ accepted: false, blockers: [...new Set(blockers)],
    external_calls: 0, formal_result_mode: 'baseline', note: 'No qualified file created; missing provenance cannot be fabricated' }, null, 2))
} else {
  // 仅编译，不修改.env、不部署；正式装配仍会重新核对当前素材指纹与配置。
  await writeFile(`${root}/qualified-report.json`, JSON.stringify(parsed.success ? parsed.data : qualification, null, 2))
}
console.log(JSON.stringify({ qualification_accepted: !blockers.length, blockers: [...new Set(blockers)], external_calls: 0 }))
