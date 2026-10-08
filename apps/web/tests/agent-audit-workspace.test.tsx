import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AgentAuditWorkspace } from '../components/agent-audit-workspace'

describe('AgentAuditWorkspace', () => {
  test('RRF 与 Rerank 对照显示紧凑的视频场景帧和图片预览', async () => {
    const summary = {
      id: 'run-1',
      query: '找海边日落',
      status: 'succeeded',
      attempt_count: 1,
      error_code: null,
      created_at: '2026-08-24T10:00:00.000Z',
      updated_at: '2026-08-24T10:00:01.000Z',
      finished_at: '2026-08-24T10:00:01.000Z',
    }
    const apiClient = {
      listAgentAuditRuns: vi.fn().mockResolvedValue({ runs: [summary] }),
      getAgentAuditRun: vi.fn().mockResolvedValue({
        run: { ...summary, next_step: 'completed', enforced_scope: {}, error: null },
        authorizations: [],
        agent_behavior: { steps: [], events: [], tool_calls: [] },
        trace: [],
        rrf_results: [
          {
            candidate_id: 'candidate-video',
            candidate_key: 'video:scene-1',
            file_id: 'file-video',
            file_generation: 1,
            asset_id: 'asset-video',
            scene_id: 'scene-1',
            scene_start_seconds: 10,
            scene_end_seconds: 30,
            rrf_rank: 1,
            retrieval: {},
          },
          {
            candidate_id: 'candidate-image',
            candidate_key: 'image:asset-2',
            file_id: 'file-image',
            file_generation: 1,
            asset_id: 'asset-image',
            scene_id: null,
            scene_start_seconds: null,
            scene_end_seconds: null,
            rrf_rank: 2,
            retrieval: {},
          },
        ],
        rerank_attempts: [{
          id: 'rerank-1',
          attempt_no: 1,
          status: 'succeeded',
          external_call_status: 'completed',
          provider_request_id: 'request-1',
          request_bytes: 100,
          total_tokens: 10,
          estimated_cost_cny: 0.01,
          latency_ms: 100,
          error: null,
          rankings: [
            { candidate_id: 'candidate-video', candidate_key: 'video:scene-1', rrf_rank: 1, rerank_rank: 2, relevance_score: 0.8 },
            { candidate_id: 'candidate-image', candidate_key: 'image:asset-2', rrf_rank: 2, rerank_rank: 1, relevance_score: 0.9 },
          ],
        }],
      }),
      mediaContentUrl: vi.fn((id: string, range: { startTimeSeconds?: number | null; endTimeSeconds?: number | null } = {}) => (
        `http://media.test/${id}${range.startTimeSeconds === null || range.startTimeSeconds === undefined ? '' : `#t=${range.startTimeSeconds},${range.endTimeSeconds}`}`
      )),
      mediaThumbnailUrl: vi.fn((id: string, seconds: number) => `http://media.test/${id}/thumbnail?time=${seconds}`),
    }

    render(<AgentAuditWorkspace apiClient={apiClient} />)
    fireEvent.click(await screen.findByRole('button', { name: /找海边日落/i }))

    const videoPreview = await screen.findByAltText('视频候选 1 预览')
    const imagePreview = screen.getByAltText('图片候选 2 预览')
    expect(videoPreview).toHaveAttribute('src', 'http://media.test/file-video/thumbnail?time=10')
    expect(imagePreview).toHaveAttribute('src', 'http://media.test/file-image')
    expect(screen.getByRole('link', { name: '打开视频候选 1' })).toHaveAttribute(
      'href',
      'http://media.test/file-video#t=10,30',
    )
    expect(apiClient.mediaThumbnailUrl).toHaveBeenCalledTimes(1)
    expect(screen.getByText('10 至 30 秒')).toBeInTheDocument()
  })
})
