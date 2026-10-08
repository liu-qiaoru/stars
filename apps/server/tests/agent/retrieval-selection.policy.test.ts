import { expect, test } from 'vitest'
import { selectRetrievalCandidatePlan } from '../../src/agent/retrieval-selection.policy.js'

const scope = { search_scope: 'visual' as const, media_types: ['video' as const], library_ids: [] }
const baseline = ['video:base']
const queries = [{ step_id: 'base', query: '小猫趴在猫爬架上', candidate_keys: baseline },
  { step_id: 'supp', query: '猫趴卧在猫爬架平台上', candidate_keys: ['video:new'] }]
const qualification = () => ({ protocol: 'retrieval-selection-qualification-v1', policy_version: 'evidence-selection-v2',
  report_id: 'human-report-1', fingerprint: 'a'.repeat(64), configuration_fingerprint: 'b'.repeat(64),
  label_source: 'human_review', cases: [{ id: 'cat', query: '小猫趴在猫爬架上', scope,
    baseline_candidate_keys: baseline, selected_candidate_keys: ['video:base', 'video:new'],
    baseline_final: baseline, enhanced_final: ['video:base', 'video:new'], target: null,
    judgments: [{ candidate_key: 'video:base', relevance: 2 }, { candidate_key: 'video:new', relevance: 0 }],
    baseline_request: { status: 'received', model: 'qwen3-vl-rerank', request_sha256: 'c'.repeat(64) },
    enhanced_request: { status: 'received', model: 'qwen3-vl-rerank', request_sha256: 'd'.repeat(64) } }] })
const input = () => ({ query: queries[0]!.query, scope, baseline, queries,
  fingerprint: 'a'.repeat(64), configuration_fingerprint: 'b'.repeat(64), stop_reason: 'partial' })

test('未验收只返回基线；隔离评测通过同一个选择入口取得新名单', () => {
  expect(selectRetrievalCandidatePlan(input()).candidate_keys).toEqual(baseline)
  expect(selectRetrievalCandidatePlan(input(), { evaluation: true })).toMatchObject({ result_mode: 'evaluation',
    candidate_keys: ['video:base', 'video:new'], policy_version: 'evidence-selection-v2' })
})
test('完整人工真实对照通过才启用同版本、同查询范围与相同名单', () => {
  // 视觉未核实是文字工具能力边界；独立人工质量资格仍必须完整通过。
  expect(selectRetrievalCandidatePlan({ ...input(), stop_reason: 'visual_evidence_unverified' }, { qualification: qualification() })).toMatchObject({
    result_mode: 'enhanced', qualification_id: 'human-report-1' })
  expect(selectRetrievalCandidatePlan({ ...input(), stop_reason: 'visual_evidence_unverified' }).result_mode).toBe('baseline')
  expect(selectRetrievalCandidatePlan(input(), { qualification: qualification() })).toMatchObject({
    result_mode: 'enhanced', qualification_id: 'human-report-1', candidate_keys: ['video:base', 'video:new'] })
  for (const changed of [{ fingerprint: 'e'.repeat(64) }, { configuration_fingerprint: 'e'.repeat(64) },
    { query: '猫' }, { scope: { ...scope, library_ids: ['00000000-0000-4000-8000-000000000001'] } },
    { stop_reason: 'tool_limit' }, { required_queries: { cat: queries[0]!.query, action: '缺失的冻结查询' } }]) {
    expect(selectRetrievalCandidatePlan({ ...input(), ...changed }, { qualification: qualification() }).result_mode).toBe('baseline')
  }
})
test('布尔成功、相同输入复用、缺标、逐查询退化或未知外发都不能授予质量资格', () => {
  const unknown = qualification(); unknown.cases[0]!.enhanced_request.status = 'outcome_unknown'
  const same = qualification(); same.cases[0]!.enhanced_request.request_sha256 = 'c'.repeat(64)
  const missing = qualification(); missing.cases[0]!.judgments.pop()
  const regression = qualification(); regression.cases[0]!.enhanced_final = ['video:new']
  for (const report of [{ quality_accepted: true }, unknown, same, missing, regression]) {
    expect(selectRetrievalCandidatePlan(input(), { qualification: report }).result_mode).toBe('baseline')
  }
})
