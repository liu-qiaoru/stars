import { expect, test } from 'vitest'
import { retrievalActionSchema, type RetrievalAction } from '@local-media-agent/shared/schemas'
import { validateMatchedStopBasis } from '../../src/agent/retrieval-stop.policy.js'

const conditionId = '11111111-1111-4111-8111-111111111111'
/** 固定“图片无法确认手持手机”案例；没有任何网络或模型自己的真值标签。 */
const input = () => ({
  action: retrievalActionSchema.parse({ action: 'finish', reason: 'partial', assessments: [{ candidate_key: 'image:one',
    conditions: [{ condition_id: conditionId, status: 'unknown', basis: 'not_mentioned', evidence_ids: ['frame:one'] }] }],
    stop_basis: { kind: 'no_useful_next_action', condition_ids: [conditionId],
      checked: [{ candidate_key: 'image:one', evidence_level: 'matched', evidence_ids: ['frame:one'] }],
      search: { status: 'not_useful', reason: '原查询已包含全部约束，没有新的忠实表达可尝试' },
      detail: { status: 'not_useful', reason: '已有完整文字不能补充手中物体的像素信息' } } }) as Extract<RetrievalAction, { action: 'finish' }>,
  conditions: [{ condition_id: conditionId, kind: 'must_have' }],
  matched: { 'image:one': { candidate_key: 'image:one', level: 'matched' as const, file_generation: 0, status: 'available' as const,
    truncated: false, continuous_action_verified: false as const, evidence: [{ evidence_id: 'frame:one', source: 'matched_visual_frame' as const,
      text: 'frame identity', start_seconds: null, end_seconds: null, crosses_scene_boundary: false, truncated: false }] } },
  details: {}, candidateKeys: ['image:one'], remaining: { tools: 3, searches: 2, details: 6, models: 5 },
})

test('没有有用新动作时允许结束，不为了多轮强制补搜；停止意见不代表语义已验证', () => {
  expect(validateMatchedStopBasis(input()).kind).toBe('no_useful_next_action')
})

test.each(['condition', 'candidate', 'evidence', 'identity_only', 'search_budget', 'detail_budget', 'not_needed', 'false_found'])(
  '停止依据拒绝伪造%s', kind => {
    const data = input(), basis = data.action.stop_basis!
    if (kind === 'condition') basis.condition_ids = ['22222222-2222-4222-8222-222222222222']
    if (kind === 'candidate') basis.checked[0]!.candidate_key = 'image:other'
    if (kind === 'evidence') basis.checked[0]!.evidence_ids = ['frame:other']
    if (kind === 'identity_only') basis.checked[0]!.evidence_ids = []
    if (kind === 'search_budget') basis.search.status = 'exhausted'
    if (kind === 'detail_budget') basis.detail.status = 'exhausted'
    if (kind === 'not_needed') basis.search.status = 'not_needed'
    if (kind === 'false_found') { data.action.reason = 'found'; basis.kind = 'sufficient_evidence' }
    expect(() => validateMatchedStopBasis(data)).toThrow(expect.objectContaining({ code: 'AGENT_STOP_BASIS_INVALID' }))
  })

test('仅搜索预算耗尽仍需说明详情价值，不能误认为所有工具都耗尽', () => {
  const data = input()
  data.remaining.searches = 0
  data.action.stop_basis!.search.status = 'exhausted'
  expect(validateMatchedStopBasis(data).detail.status).toBe('not_useful')
  data.action.stop_basis!.detail.status = 'exhausted'
  expect(() => validateMatchedStopBasis(data)).toThrow()
})

test('只有已提供证据状态失效时才能以空引用停止，不能把有效来源伪装为失效', () => {
  const data = input()
  data.action.stop_basis!.checked[0]!.evidence_ids = []
  const stale = { ...data, matched: { 'image:one': { ...data.matched['image:one'], status: 'stale' as const, evidence: [] } } }
  expect(validateMatchedStopBasis(stale).checked[0]?.read_status).toBe('stale')
  expect(() => validateMatchedStopBasis(data)).toThrow()
})
