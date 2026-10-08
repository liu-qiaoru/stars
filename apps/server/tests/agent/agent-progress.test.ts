import { describe, expect, test } from 'vitest'
import { buildAgentProgress } from '../../src/agent/agent-progress.js'

const time = new Date('2026-10-02T00:00:00Z')
const run = {
  status: 'searching',
  createdAt: time,
  updatedAt: time,
  finishedAt: null,
  enforcedScopeJson: { retrieval_agent: true },
}
const step = (id: string, output: unknown = null, status = 'completed') => ({
  stepAttemptId: id,
  stepKind: 'searching',
  status,
  outputJson: output,
  startedAt: time,
  finishedAt: status === 'running' ? null : time,
})
const trace = {
  spanId: 'rrf-1',
  operation: 'rrf',
  status: 'running',
  startedAt: time,
  finishedAt: null,
  attributesJson: { step_attempt_id: 'search' },
}

describe('任务执行时间线', () => {
  test('区分模型决策、执行工具、补搜；运行中的工具也可见，不虚构重排', () => {
    const progress = buildAgentProgress(
      run,
      [
        step('decision', { retrieval_state: { pending: { action: 'search_media' } } }),
        step('search', { tool_status: 'succeeded', retrieval_state: { pending: null } }),
        step('decision-2', { retrieval_state: { pending: { action: 'get_segment_details' } } }),
        step('details', { tool_status: 'succeeded', retrieval_state: { pending: null } }),
        step('decision-3', { retrieval_state: { pending: { action: 'search_media' } } }),
        step('search-2', null, 'running'),
      ],
      [],
    )
    expect(progress.map((item) => item.label)).toEqual([
      '创建任务',
      '根据结果决定下一步',
      '执行检索',
      '根据结果决定下一步',
      '读取片段详情',
      '根据结果决定下一步',
      '补充检索（第 2 次）',
    ])
    expect(progress.at(-1)?.status).toBe('running')
  })
  test('仅真实轨迹显示 RRF，租约过期或取消后不再显示进行中', () => {
    expect(
      buildAgentProgress(run, [step('search', null, 'running')], [trace]).find(
        (item) => item.id === 'rrf-1',
      )?.status,
    ).toBe('running')
    expect(
      buildAgentProgress(run, [step('search', null, 'lease_expired')], [trace]).find(
        (item) => item.id === 'rrf-1',
      )?.status,
    ).toBe('interrupted')
    expect(
      buildAgentProgress({ ...run, status: 'cancelled', finishedAt: time }, [], [trace]).find(
        (item) => item.id === 'rrf-1',
      )?.status,
    ).toBe('interrupted')
  })
  test('空搜索是成功步骤，失败与外部未知结果保留差别', () => {
    const progress = buildAgentProgress(
      run,
      [
        step('empty', { tool_status: 'succeeded' }),
        step('error', { tool_status: 'failed' }),
        step('unknown', null, 'outcome_unknown'),
      ],
      [],
    )
    expect(progress.slice(1).map((item) => item.status)).toEqual([
      'succeeded',
      'failed',
      'outcome_unknown',
    ])
  })
  test('旧流程准备证据与实际外部重排分开显示', () => {
    const legacy = { ...run, status: 'ranking', enforcedScopeJson: {} }
    expect(
      buildAgentProgress(
        legacy,
        [],
        [],
        [
          {
            id: 'r',
            status: 'preparing_evidence',
            createdAt: time,
            dispatchedAt: null,
            finishedAt: null,
          },
        ],
      ).at(-1)?.label,
    ).toBe('准备重排证据')
    expect(
      buildAgentProgress(legacy, [], [{ ...trace, operation: 'rerank_candidates' }]).at(-1)?.label,
    ).toBe('Rerank 候选重排')
  })
})

test('场景取帧与模型观察分开显示，不把本地准备说成已看图', () => {
  const progress = buildAgentProgress(run, [
    step('decision', { retrieval_state: { pending: { action: 'inspect_segment_frames' } } }),
    step('frames', { evidence_preparation: 'scene_frames', retrieval_state: { pending: { action: 'inspect_segment_frames' } } }),
    step('observation', { tool_status: 'succeeded', retrieval_state: { pending: null } }),
  ], [])
  expect(progress.find(p => p.id === 'frames')?.label).toBe('准备场景采样画面')
  expect(progress.find(p => p.id === 'observation')?.label).toBe('模型检查采样画面')
})
