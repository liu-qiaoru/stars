import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvaluationReportsWorkspace } from '../components/evaluation-reports-workspace'
import type { EvaluationRankingMetrics, EvaluationRunSummary } from '../lib/api-client'

afterEach(() => vi.unstubAllGlobals())

describe('evaluation reports workspace', () => {
  test('shows a saved report and candidate rank changes without inventing shadow rerank results', async () => {
    const runId = 'df91d354-46e6-44e7-82bb-f0b16a92aea1'
    const initialRuns: EvaluationRunSummary[] = [
      {
        id: runId,
        version_id: '7e60333f-28f2-4aae-a518-91a774ec7c01',
        set_id: '9c7fbf21-9bd8-47cb-8d29-8c68bb8d3b3f',
        set_name: '人物动作基线',
        version: 1,
        status: 'reported',
        query_count: 1,
        candidate_count: 2,
        required_candidate_count: 2,
        judged_required_candidate_count: 2,
        judged_candidate_count: 2,
        report: {
          generated_at: '2026-08-05T12:00:00.000Z',
          queries: [
            {
              query_id: 'query-1',
              current: metrics({ precisionAt5: 0.5, ndcgAt10: 0.6 }),
              rrf: metrics({ precisionAt5: 1, ndcgAt10: 0.9 }),
            },
          ],
        },
        error_code: null,
        error_message: null,
        created_at: '2026-08-05T11:00:00.000Z',
        finished_at: '2026-08-05T12:00:00.000Z',
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: string | URL | Request) => {
        const url = String(request)
        // 使用浏览器原生 Response 作为测试替身，确保同时覆盖 text()/json()
        // 的真实 Fetch 契约；影子接口的 JSON null 与 HTTP 空正文是两个不同状态。
        return new Response(
          JSON.stringify(
            url.endsWith('/shadow-rerank')
              ? null
              : {
                  id: runId,
                  version_id: initialRuns[0]!.version_id,
                  status: 'reported',
                  config: {},
                  report: initialRuns[0]!.report,
                  error_code: null,
                  error_message: null,
                  candidates: [
                    {
                      id: 'candidate-1',
                      query_id: 'query-1',
                      query_text: '有人在草地上放风筝',
                      candidate_key: 'scene-1',
                      file_id: '11111111-1111-4111-8111-111111111111',
                      scene_id: '22222222-2222-4222-8222-222222222222',
                      media_type: 'video',
                      start_time_seconds: 3,
                      end_time_seconds: 9,
                      requires_judgment: true,
                      current_rank: 4,
                      rrf_rank: 1,
                      judgment: { relevance: 2, unjudgeable: false },
                    },
                  ],
                },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    render(<EvaluationReportsWorkspace initialRuns={initialRuns} total={1} />)
    fireEvent.click(screen.getByRole('button', { name: '查看报告' }))

    expect((await screen.findAllByText('有人在草地上放风筝')).length).toBeGreaterThan(0)
    expect(screen.getByRole('cell', { name: '60.0%' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '90.0%' })).toBeInTheDocument()
    expect(screen.getByText('4 → 1')).toBeInTheDocument()
    expect(await screen.findByText(/尚未运行；历史页面不会自动调用 Provider/)).toBeInTheDocument()
  })
})

function metrics(overrides: Partial<EvaluationRankingMetrics> = {}) {
  return { ...emptyMetrics(), ...overrides }
}

function emptyMetrics(): EvaluationRankingMetrics {
  return {
    precisionAt5: null,
    precisionAt10: null,
    ndcgAt10: null,
    ndcgAt20: null,
    hitAt5: null,
    hitAt10: null,
    hitAt20: null,
    reciprocalRank: null,
    unjudgeableCount: 0,
  }
}
