import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ShadowRerankPanel } from '../components/shadow-rerank-panel'
import type { ShadowRerankRun } from '../lib/api-client'

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

describe('Phase E shadow rerank panel', () => {
  test('shows not-run state and uses an accessible explicit start action', async () => {
    const api = client(null)
    render(<ShadowRerankPanel evaluationRunId="run-1" canStart apiClient={api} />)

    expect(await screen.findByText(/尚未运行；历史页面不会自动调用 Provider/)).toBeInTheDocument()
    const start = screen.getByRole('button', { name: '运行影子重排' })
    start.focus()
    expect(start).toHaveFocus()
    fireEvent.click(start)
    await waitFor(() =>
      expect(api.startEvaluationShadowRerank).toHaveBeenCalledWith(
        'run-1',
        expect.any(AbortSignal),
      ),
    )
  })

  test('starts polling after an explicit run changes the persisted state to pending', async () => {
    vi.useFakeTimers()
    const api = client(null)
    render(<ShadowRerankPanel evaluationRunId="run-1" canStart apiClient={api} />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: '运行影子重排' }))
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(2_001))

    expect(api.startEvaluationShadowRerank).toHaveBeenCalledTimes(1)
    expect(api.getEvaluationShadowRerank.mock.calls.length).toBeGreaterThan(1)
  })

  test.each([
    ['pending', '未运行'],
    ['running', '运行中'],
    ['succeeded', '成功'],
    ['completed_with_errors', '部分失败'],
    ['failed', '失败'],
    ['not_applicable', '不适用'],
  ] as const)(
    'renders the %s state with a live status and no VLM conclusion',
    async (status, label) => {
      const api = client(run(status))
      render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)

      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)
      expect(screen.getByText(/尚未执行 VLM 审核/)).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: /审核通过|审核拒绝/ })).not.toBeInTheDocument()
    },
  )

  test('compares RRF and shadow ranks and explains score metadata and structured errors', async () => {
    const api = client(run('completed_with_errors'))
    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)

    expect(
      await screen.findByRole('table', { name: '冻结候选的 RRF 与影子重排名次对比' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('qwen3-vl-rerank').length).toBeGreaterThan(0)
    expect(screen.getByText('qwen3-vl-rerank-top20-v1')).toBeInTheDocument()
    expect(screen.getByText('SHADOW_EVIDENCE_INCOMPLETE')).toBeInTheDocument()
    expect(screen.getByText(/relevance_score 不是概率/)).toBeInTheDocument()
    expect(screen.getAllByText(/查询指纹/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('RRF MRR').length).toBeGreaterThan(0)
    expect(screen.getAllByText('影子 MRR').length).toBeGreaterThan(0)
    expect(screen.getByText(/完整产品样本/)).toBeInTheDocument()
  })

  test('surfaces a malformed API response instead of presenting it as not run', async () => {
    const api = client(null)
    api.getEvaluationShadowRerank.mockResolvedValue({ protocol_version: 'wrong', attempts: [] })

    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Phase E 协议/)
    expect(screen.queryByText(/尚未运行；历史页面/)).not.toBeInTheDocument()
  })

  test('rejects malformed nested metric data instead of trusting a shallow run shape', async () => {
    const api = client(null)
    const malformed = run('succeeded')
    malformed.metric_summary.successful_samples.shadow = {
      ...knownTargetMetrics(1),
      reciprocalRank: Number.NaN,
    }
    api.getEvaluationShadowRerank.mockResolvedValue(malformed)

    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Phase E 协议/)
  })

  test('rejects a malformed nested ranking before rendering numeric formatting', async () => {
    const api = client(null)
    const malformed = run('succeeded')
    malformed.attempts[0]!.rankings[0]!.relevance_score = 'bad' as unknown as number
    api.getEvaluationShadowRerank.mockResolvedValue(malformed)

    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Phase E 协议/)
  })

  test('retries when the first GET fails before an active state has been confirmed', async () => {
    vi.useFakeTimers()
    const api = client(null)
    api.getEvaluationShadowRerank
      .mockRejectedValueOnce(new Error('首次临时断线'))
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('succeeded'))

    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(4_002))

    expect(api.getEvaluationShadowRerank).toHaveBeenCalledTimes(3)
    expect(screen.getAllByText('成功').length).toBeGreaterThan(0)
  })

  test('keeps polling after a transient GET failure while the last confirmed state is active', async () => {
    vi.useFakeTimers()
    const api = client(run('running'))
    api.getEvaluationShadowRerank
      .mockResolvedValueOnce(run('running'))
      .mockRejectedValueOnce(new Error('临时断线'))
      .mockResolvedValueOnce(run('succeeded'))

    render(<ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />)
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(4_002))

    expect(api.getEvaluationShadowRerank).toHaveBeenCalledTimes(3)
    expect(screen.getAllByText('成功').length).toBeGreaterThan(0)
  })

  test('aborts an in-flight POST when the panel unmounts', async () => {
    const api = client(null)
    api.startEvaluationShadowRerank.mockImplementation(() => new Promise(() => undefined))
    const view = render(<ShadowRerankPanel evaluationRunId="run-1" canStart apiClient={api} />)
    await screen.findByText(/尚未运行；历史页面/)

    fireEvent.click(screen.getByRole('button', { name: '运行影子重排' }))
    await act(async () => {})
    const signal = api.startEvaluationShadowRerank.mock.calls[0]?.[1]
    view.unmount()

    expect(signal?.aborted).toBe(true)
  })

  test('pauses polling while hidden, refreshes immediately when visible, and aborts on unmount', async () => {
    vi.useFakeTimers()
    let visibility = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    const api = client(run('running'))
    const view = render(
      <ShadowRerankPanel evaluationRunId="run-1" canStart={false} apiClient={api} />,
    )
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(api.getEvaluationShadowRerank).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(api.getEvaluationShadowRerank).toHaveBeenCalledTimes(2)
    const signal = api.getEvaluationShadowRerank.mock.calls.at(-1)?.[1]
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})

function client(initial: ShadowRerankRun | null) {
  return {
    getEvaluationShadowRerank: vi.fn().mockResolvedValue(initial),
    startEvaluationShadowRerank: vi.fn().mockResolvedValue(run('pending')),
  } as unknown as ReturnType<(typeof import('../lib/api-client'))['createApiClient']> & {
    getEvaluationShadowRerank: ReturnType<typeof vi.fn>
    startEvaluationShadowRerank: ReturnType<typeof vi.fn>
  }
}

function run(status: ShadowRerankRun['status']): ShadowRerankRun {
  return {
    id: 'shadow-1',
    evaluation_run_id: 'run-1',
    status,
    provider: 'dashscope',
    requested_model: 'qwen3-vl-rerank',
    response_model: 'qwen3-vl-rerank',
    model_snapshot: 'snapshot-1',
    region: 'cn-beijing',
    protocol_version: 'qwen3-vl-rerank-top20-v1',
    query_count: 2,
    succeeded_count: status === 'succeeded' ? 2 : 1,
    failed_count: status === 'completed_with_errors' || status === 'failed' ? 1 : 0,
    not_applicable_count: status === 'not_applicable' ? 2 : 0,
    actual_sample_count: 1,
    request_bytes: 2048,
    input_tokens: 200,
    output_tokens: 10,
    total_tokens: 210,
    latency_ms: 1234,
    billed_cost_cny: 0.01,
    review_status: 'not_run',
    metric_summary: {
      successful_samples: { n: 1, rrf: knownTargetMetrics(0.25), shadow: knownTargetMetrics(1) },
      full_product_samples: {
        n: 2,
        rrf: knownTargetMetrics(0.25),
        shadow_with_rrf_fallback: knownTargetMetrics(0.5),
      },
    },
    error:
      status === 'completed_with_errors'
        ? { code: 'SHADOW_RERANK_ATTEMPTS_FAILED', message: '1 个尝试失败', details: null }
        : null,
    attempts: [
      {
        id: 'attempt-1',
        query_id: 'query-1',
        query_text: '红色汽车',
        status: status === 'running' || status === 'pending' ? status : 'succeeded',
        external_call_status: status === 'running' ? 'dispatched' : 'completed',
        provider_request_id: 'request-1',
        response_model: 'qwen3-vl-rerank',
        model_snapshot: 'snapshot-1',
        region: 'cn-beijing',
        query_fingerprint: 'a'.repeat(64),
        evidence_fingerprint: 'b'.repeat(64),
        response_fingerprint: 'c'.repeat(64),
        request_bytes: 2048,
        input_tokens: 200,
        output_tokens: 10,
        total_tokens: 210,
        latency_ms: 1234,
        billed_cost_cny: 0.01,
        actual_candidate_count: 20,
        actual_result_count: 10,
        applicability_reason: null,
        metrics: {
          rrf: {
            precisionAt5: null,
            precisionAt10: null,
            ndcgAt10: null,
            ndcgAt20: null,
            hitAt5: 1,
            hitAt10: 1,
            hitAt20: 1,
            reciprocalRank: 0.25,
            unjudgeableCount: 0,
          },
          shadow: {
            precisionAt5: null,
            precisionAt10: null,
            ndcgAt10: null,
            ndcgAt20: null,
            hitAt5: 1,
            hitAt10: 1,
            hitAt20: 1,
            reciprocalRank: 1,
            unjudgeableCount: 0,
          },
        },
        error: null,
        rankings: [
          {
            candidate_id: 'candidate-1',
            candidate_key: 'video:scene-1',
            rrf_rank: 4,
            shadow_rank: 1,
            relevance_score: 0.87,
          },
        ],
      },
      ...(status === 'completed_with_errors' || status === 'failed'
        ? [
            {
              id: 'attempt-2',
              query_id: 'query-2',
              query_text: '桥下汽车',
              status: 'failed' as const,
              external_call_status: 'not_dispatched' as const,
              provider_request_id: null,
              response_model: null,
              model_snapshot: null,
              region: null,
              query_fingerprint: null,
              evidence_fingerprint: null,
              response_fingerprint: null,
              request_bytes: null,
              input_tokens: null,
              output_tokens: null,
              total_tokens: null,
              latency_ms: null,
              billed_cost_cny: null,
              actual_candidate_count: 19,
              actual_result_count: 0,
              metrics: null,
              applicability_reason: null,
              error: {
                code: 'SHADOW_EVIDENCE_INCOMPLETE',
                message: '缺少证据',
                details: { actual: 19 },
              },
              rankings: [],
            },
          ]
        : []),
    ],
    created_at: '2026-08-12T00:00:00.000Z',
    finished_at: status === 'running' || status === 'pending' ? null : '2026-08-12T00:01:00.000Z',
  }
}

function knownTargetMetrics(reciprocalRank: number) {
  return {
    precisionAt5: null,
    precisionAt10: null,
    ndcgAt10: null,
    ndcgAt20: null,
    hitAt5: reciprocalRank >= 0.2 ? 1 : 0,
    hitAt10: reciprocalRank >= 0.1 ? 1 : 0,
    hitAt20: reciprocalRank >= 0.05 ? 1 : 0,
    reciprocalRank,
    unjudgeableCount: 0,
  }
}
