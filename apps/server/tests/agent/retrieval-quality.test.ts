import { expect, test } from 'vitest'
import { compareRetrievalQuality, summarizeRetrievalQualityAcceptance, validateHumanReviewLabels } from '../../src/agent/retrieval-quality.js'

test('同输入复用只能通过基线保护验收，不能证明新增候选选择已验收', () => {
  const preserved = summarizeRetrievalQualityAcceptance([
    { accepted: true, changed_rerank_input: false, supplemental_candidates: 0 },
    { accepted: true, changed_rerank_input: null, supplemental_candidates: 0 },
  ])
  expect(preserved.frozen_suite_accepted).toBe(true)
  expect(preserved.enhanced_selection_quality_accepted).toBe(false)
  expect(preserved.unverified_reason).toBe('supplemental_selection_not_exercised')
  const regression = summarizeRetrievalQualityAcceptance([
    { accepted: false, changed_rerank_input: true, supplemental_candidates: 1 },
  ])
  expect(regression.frozen_suite_accepted).toBe(false)
  expect(regression.enhanced_selection_quality_accepted).toBe(false)
  // 仅改变同一批候选的输入顺序也没有检验新增席位。
  expect(summarizeRetrievalQualityAcceptance([
    { accepted: true, changed_rerank_input: true, supplemental_candidates: 0 },
  ]).enhanced_selection_quality_accepted).toBe(false)
})

test('人工补标只能引用同一冻结版本和查询内候选，不能接受伪造身份、非法等级或重复覆盖', () => {
  const cases = [{ id: 'cat', candidate_keys: ['a'] }, { id: 'action', candidate_keys: ['b'] }]
  const file = { fingerprint: 'frozen', source: 'human_review', labels: [{ case_id: 'cat', candidate_key: 'a', relevance: 2 }] }
  expect(validateHumanReviewLabels(file, 'frozen', cases)).toEqual(file.labels)
  expect(() => validateHumanReviewLabels(file, 'changed', cases)).toThrow()
  for (const invalid of [
    { case_id: 'cat', candidate_key: 'b', relevance: 2 },
    { case_id: 'unknown', candidate_key: 'a', relevance: 2 },
    { case_id: 'cat', candidate_key: 'a', relevance: 3 },
  ]) expect(() => validateHumanReviewLabels({ ...file, labels: [invalid] }, 'frozen', cases)).toThrow()
  expect(() => validateHumanReviewLabels({ ...file, labels: [...file.labels, { ...file.labels[0], relevance: 0 }] }, 'frozen', cases)).toThrow()
})

test('前五条准确率固定分母5，结果不足不能以实际返回数美化', () => {
  const report = compareRetrievalQuality({ baseline: ['a', 'b'], enhanced: ['a'], pool: ['a', 'b'],
    judgments: { a: 2, b: 0 }, target: null })
  expect(report.baseline?.precisionAt5).toBe(0.2)
  expect(report.enhanced?.precisionAt5).toBe(0.2)
})
test('缺失人工标签保持未验收，不能把模型相关分当成人工真值', () => {
  const report = compareRetrievalQuality({ baseline: ['a'], enhanced: ['b'], pool: ['a', 'b'], judgments: { a: 2 }, target: null })
  expect(report.status).toBe('unjudged')
  expect(report.enhanced).toBeNull()
  expect(report.missing_labels).toEqual(['b'])
})
test('目标丢失或排名退化必须逐查询失败，整体平均不能覆盖', () => {
  const report = compareRetrievalQuality({ baseline: ['a', 'b'], enhanced: ['b'], pool: ['a', 'b'],
    judgments: { a: 2, b: 0 }, target: 'a' })
  expect(report.status).toBe('regressed')
  expect(report.baseline?.hitAt10).toBe(1)
  expect(report.enhanced?.hitAt10).toBe(0)
  expect(report.lost).toEqual(['a'])
  expect(report.rank_changes).toContainEqual({ candidate_key: 'b', baseline_rank: 2, enhanced_rank: 1 })
})
test('完整空结果可单独通过，不能据此验收其他未标注查询', () => {
  const report = compareRetrievalQuality({ baseline: [], enhanced: [], pool: [], judgments: {}, target: null })
  expect(report.status).toBe('non_decreasing')
  expect(report.baseline?.precisionAt5).toBe(0)
})

test('新增候选补标池只接受冻结查询范围、真实来源与当前文件版本，不覆盖已有标签', async () => {
  const { extendRetrievalReviewPool } = await import('../../src/agent/retrieval-review-pool.js')
  const scopes = [{ id: 'cat', query: '小猫趴在猫爬架上', scope: 'visual', media_types: ['video'], library_ids: ['lib'],
    candidate_keys: ['video:base'] }]
  const extension = { fingerprint: 'frozen', cases: [{ id: 'cat', original_query: scopes[0]!.query,
    candidates: [{ candidate_key: 'video:new', file_id: 'file', file_generation: 1, media_type: 'video', library_id: 'lib',
      source_step_id: 'local-search-1', source_query: '小猫趴卧在猫爬架平台上', rank: 1, origin: 'local_search_preflight' }] }] }
  expect(extendRetrievalReviewPool(scopes, extension, 'frozen', new Map([['file', 1]])))
    .toEqual([{ id: 'cat', candidate_keys: ['video:base', 'video:new'] }])
  for (const changed of [{ file_generation: 0 }, { library_id: 'foreign' }, { media_type: 'audio' },
    { source_query: '' }, { origin: 'model_label' }]) {
    expect(() => extendRetrievalReviewPool(scopes, { ...extension, cases: [{ ...extension.cases[0],
      candidates: [{ ...extension.cases[0]!.candidates[0], ...changed }] }] }, 'frozen', new Map([['file', 1]]))).toThrow()
  }
  expect(() => extendRetrievalReviewPool(scopes, extension, 'changed', new Map([['file', 1]]))).toThrow()
  const pool = extendRetrievalReviewPool(scopes, extension, 'frozen', new Map([['file', 1]]))
  expect(validateHumanReviewLabels({ fingerprint: 'frozen', source: 'human_review', labels: [
    { case_id: 'cat', candidate_key: 'video:new', relevance: 2 }] }, 'frozen', pool)).toHaveLength(1)
})
