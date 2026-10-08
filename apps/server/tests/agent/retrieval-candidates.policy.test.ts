import { expect, test } from 'vitest'
import { retrievalQuerySignature, selectExperimentalCandidates } from '../../src/agent/retrieval-candidates.policy.js'

test('二十条基线保留独立快照，新增候选有有限席位，后发现的高名次候选可以参与', () => {
  const baseline = Array.from({ length: 20 }, (_, i) => `base:${i}`)
  const queries = [{ step_id: 'base', query: '原文', candidate_keys: baseline },
    { step_id: 'early', query: '补搜一', candidate_keys: ['new:a', 'new:b', 'new:c', 'new:d', 'new:e'] },
    { step_id: 'late', query: '补搜二', candidate_keys: ['new:e', 'new:z'] }]
  const selected = selectExperimentalCandidates(baseline, queries)
  expect(selected).toHaveLength(20)
  expect(selected.filter(key => key.startsWith('new:'))).toHaveLength(4)
  expect(selected).toContain('new:e')
  expect(baseline).toHaveLength(20)
  expect(new Set(selected).size).toBe(20)
})
test('无新增候选时实验名单保留全部基线，跨轮分数不作为接口输入', () => {
  expect(selectExperimentalCandidates(['a', 'b'], [{ step_id: 'one', query: '原文', candidate_keys: ['a', 'b'] }])).toEqual(['a', 'b'])
})
test('改变 limit、解释或媒体类型顺序不能绕过重复查询停止', () => {
  expect(retrievalQuerySignature('  小猫   猫爬架 ', 'visual', ['video', 'image']))
    .toBe(retrievalQuerySignature('小猫 猫爬架', 'visual', ['image', 'video']))
  expect(retrievalQuerySignature('小猫 猫爬架', 'spoken', ['video']))
    .not.toBe(retrievalQuerySignature('小猫 猫爬架', 'visual', ['video']))
})

test('去重后的列表位置不能代替搜索原始名次，跨轮融合使用已保存rank', () => {
  const selected = selectExperimentalCandidates([], [
    { step_id: 'one', query: '原文', candidate_keys: ['a:late'],
      ranks: [{ candidate_key: 'a:late', rank: 20, sources: ['vector_match'] }] },
    { step_id: 'two', query: '补搜', candidate_keys: ['z:early'],
      ranks: [{ candidate_key: 'z:early', rank: 1, sources: ['caption_match'] }] },
  ])
  expect(selected).toEqual(['z:early', 'a:late'])
})

test('候选选择入口拒绝超过20的容量，不能用参数绕过产品上限', () => {
  expect(() => selectExperimentalCandidates([], [], 21)).toThrow()
  expect(() => selectExperimentalCandidates([], [], 1.5)).toThrow()
})
