import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { VlmBlindCandidateReviewWorkspace } from '../components/vlm-blind-candidate-review-workspace'
import type {
  VlmBlindCandidateReviewPacket,
  VlmBlindDataset,
  VlmBlindLabelingState,
  VlmBlindRealPreflight,
} from '../lib/api-client'

const packet = {
  schema_version: 'phase-f-vlm-candidate-review-v1',
  proposals: [],
} as unknown as VlmBlindCandidateReviewPacket

const dataset: VlmBlindDataset = {
  id: 'dataset-1',
  name: 'Phase F 候选审核',
  schema_version: 'phase-f-vlm-candidate-review-v1',
  status: 'candidate_review',
  proposal_fingerprint: 'abc',
  frozen_fingerprint: null,
  summary: {
    pending: 1,
    accepted: 0,
    rejected: 0,
    historical_rejected: 0,
    historical_accepted: 0,
  },
  cases: [
    {
      id: 'case-1',
      replaces_case_id: null,
      is_active: true,
      proposal_id: 'phase-f-exact-01',
      source_evaluation_run_id: 'run-1',
      source_candidate_id: 'candidate-1',
      query_text: '有人在海边走路',
      candidate_key: 'video:scene-1',
      file_id: '11111111-1111-4111-8111-111111111111',
      scene_id: '22222222-2222-4222-8222-222222222222',
      start_time_seconds: 3,
      end_time_seconds: 9,
      proposed_group: 'exact_match',
      reviewed_group: null,
      review_status: 'pending',
      selection_basis: 'RRF 名次 1；需人工播放后确认。',
      review_notes: null,
      conditions: [{ condition_id: 'must-1', kind: 'must_have', source_text: '画面中有人' }],
      human_labels: [],
    },
  ],
}

const labelingState: VlmBlindLabelingState = {
  dataset_id: 'dataset-1',
  candidate_status: 'frozen',
  session_id: null,
  labels_status: 'evidence_pending',
  labels_fingerprint: null,
  labels_frozen_at: null,
  evidence_summary: { total: 1, missing: 1, queued: 0, running: 0, succeeded: 0, failed: 0 },
  label_progress: {
    total: 1,
    first: 0,
    second: 0,
    adjudication_required: 0,
    final: 0,
    resolved: 0,
  },
  cases: [
    {
      id: 'case-1',
      proposal_id: 'phase-f-exact-01',
      source_evaluation_run_id: 'run-1',
      source_candidate_id: 'candidate-1',
      query_text: '有人在海边走路',
      candidate_key: 'video:scene-1',
      file_id: '11111111-1111-4111-8111-111111111111',
      scene_id: '22222222-2222-4222-8222-222222222222',
      start_time_seconds: 3,
      end_time_seconds: 9,
      evidence: null,
      conditions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          condition_id: 'must-1',
          kind: 'must_have',
          source_text: '画面中有人',
          first: null,
          second: null,
          final: null,
          needs_adjudication: false,
          resolved: null,
        },
      ],
    },
  ],
  fake_report: null,
}

describe('Phase F candidate review workspace', () => {
  test('shows a local-only real VLM preflight and keeps fake metrics separate from real history', async () => {
    const preflight: VlmBlindRealPreflight = {
      dataset_id: 'dataset-1',
      dataset_fingerprint: 'a'.repeat(64),
      labels_fingerprint: 'b'.repeat(64),
      evidence_fingerprint: 'c'.repeat(64),
      preflight_fingerprint: 'd'.repeat(64),
      provider_configured: true,
      provider_enabled: false,
      external_llm_enabled: true,
      provider_available: false,
      visual_authorization_exists: false,
      authorization_id: null,
      candidate_count: 60,
      normal_call_count: 60,
      stability_case_count: 12,
      stability_extra_call_count: 24,
      maximum_call_count: 84,
      total_image_count: 420,
      total_request_bytes: 20 * 1024 * 1024,
      items: [],
      budget: { max_calls: 84, max_cost_cny: 5 },
      stop_conditions: ['outcome_unknown'],
      external_call_count: 0,
    }
    const preflightVlmBlindReal = vi.fn().mockResolvedValue(preflight)
    const listVlmBlindRealRuns = vi.fn().mockResolvedValue({ items: [] })
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={{ ...dataset, status: 'frozen', frozen_fingerprint: 'a'.repeat(64) }}
        initialLabeling={{
          ...labelingState,
          labels_status: 'labels_frozen',
          labels_fingerprint: 'b'.repeat(64),
          labels_frozen_at: new Date().toISOString(),
        }}
        apiClient={
          {
            preflightVlmBlindReal,
            listVlmBlindRealRuns,
            getVlmBlindRealRun: vi.fn(),
            mediaContentUrl: vi.fn(),
          } as never
        }
      />,
    )

    expect(screen.getByText('真实 VLM：尚未执行。fake 指标不会填入这里。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '运行本地只读 preflight' }))

    await waitFor(() => expect(preflightVlmBlindReal).toHaveBeenCalledWith('dataset-1'))
    expect(screen.getByText('Provider 部署开关')).toBeInTheDocument()
    expect(screen.getByText('disabled')).toBeInTheDocument()
    expect(screen.getByText(/60 条各一次/)).toBeInTheDocument()
    expect(screen.getAllByText(/真实外部调用：0/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '保存本次独立视觉授权' })).toBeDisabled()
  })

  test('moves a frozen candidate pool into evidence preparation and first-pass labeling', async () => {
    const firstPass = {
      ...labelingState,
      session_id: 'session-1',
      labels_status: 'first_pass' as const,
      evidence_summary: {
        ...labelingState.evidence_summary,
        missing: 0,
        succeeded: 1,
      },
      cases: [
        {
          ...labelingState.cases[0]!,
          evidence: {
            id: 'evidence-1',
            status: 'succeeded' as const,
            frame_count: 3,
            error: null,
          },
        },
      ],
    }
    const prepareVlmBlindEvidence = vi.fn().mockResolvedValue(firstPass)
    const saveVlmBlindConditionLabel = vi.fn().mockResolvedValue({
      ...firstPass,
      label_progress: { ...firstPass.label_progress, first: 1 },
      cases: [
        {
          ...firstPass.cases[0]!,
          conditions: [{ ...firstPass.cases[0]!.conditions[0]!, first: 'yes' }],
        },
      ],
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      prepareVlmBlindEvidence,
      saveVlmBlindConditionLabel,
      getVlmBlindLabeling: vi.fn(),
    }
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={{
          ...dataset,
          status: 'frozen',
          frozen_fingerprint: 'a'.repeat(64),
        }}
        initialLabeling={labelingState}
        apiClient={apiClient as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '准备 60 条独立索引帧证据' }))
    await waitFor(() => expect(prepareVlmBlindEvidence).toHaveBeenCalledWith('dataset-1'))
    expect(await screen.findByText('待第一轮标注')).toBeInTheDocument()
    expect(screen.getByText(/独立索引帧 3 张/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '是' }))
    await waitFor(() =>
      expect(saveVlmBlindConditionLabel).toHaveBeenCalledWith(
        'dataset-1',
        'case-1',
        '33333333-3333-4333-8333-333333333333',
        'first',
        { verdict: 'yes' },
      ),
    )
    expect(await screen.findByText('第一轮已保存：是')).toBeInTheDocument()
    expect(screen.queryByText('fake 协议演练只读报告')).not.toBeInTheDocument()
  })

  test('shows playable candidates, proposal caveat and persists human review', async () => {
    const reviewVlmBlindCandidate = vi.fn().mockResolvedValue({
      ...dataset,
      summary: {
        pending: 0,
        accepted: 1,
        rejected: 0,
        historical_rejected: 0,
        historical_accepted: 0,
      },
      cases: [{ ...dataset.cases[0]!, review_status: 'accepted', reviewed_group: 'exact_match' }],
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      importVlmBlindCandidateReviewPacket: vi.fn(),
      reviewVlmBlindCandidate,
    }

    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={dataset}
        apiClient={apiClient as never}
      />,
    )

    expect(screen.getByRole('navigation', { name: '面包屑' })).toHaveTextContent('Phase F 候选审核')
    expect(screen.getByText(/候选分组只是抽样建议，不是人工真值/)).toBeInTheDocument()
    expect(screen.getByText(/真实 VLM 调用：0/)).toBeInTheDocument()
    expect(screen.getByLabelText('播放候选视频：有人在海边走路')).toHaveAttribute(
      'src',
      expect.stringContaining('/media/11111111-1111-4111-8111-111111111111/content#t=3,9'),
    )
    fireEvent.click(screen.getByRole('button', { name: '接受这对候选' }))

    await waitFor(() =>
      expect(reviewVlmBlindCandidate).toHaveBeenCalledWith('dataset-1', 'case-1', {
        decision: 'accepted',
        reviewed_group: 'exact_match',
      }),
    )
    expect(await screen.findByText('已接受 1')).toBeInTheDocument()
    // 进度和全局消息位于长页面顶部；用户在候选卡片底部操作时也必须在原位
    // 看到结果，才能确认点击已经保存而不需要向上滚动查找反馈。
    expect(screen.getByText('审核结果：已接受 · 完全符合')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已接受' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('shows rejected feedback on the operated card without requiring a scroll to the page top', async () => {
    const reviewVlmBlindCandidate = vi.fn().mockResolvedValue({
      ...dataset,
      summary: {
        pending: 0,
        accepted: 0,
        rejected: 1,
        historical_rejected: 0,
        historical_accepted: 0,
      },
      cases: [{ ...dataset.cases[0]!, review_status: 'rejected' }],
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      importVlmBlindCandidateReviewPacket: vi.fn(),
      reviewVlmBlindCandidate,
    }
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={dataset}
        apiClient={apiClient as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '拒绝，需替换' }))

    expect(await screen.findByText('审核结果：已拒绝 · 需要替换')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已拒绝，需替换' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('generates replacements and hides superseded rejected cards while preserving history count', async () => {
    const rejected = {
      ...dataset.cases[0]!,
      review_status: 'rejected' as const,
    }
    const rejectedDataset = {
      ...dataset,
      summary: {
        pending: 0,
        accepted: 0,
        rejected: 1,
        historical_rejected: 0,
        historical_accepted: 0,
      },
      cases: [rejected],
    }
    const replacement = {
      ...dataset.cases[0]!,
      id: 'case-2',
      proposal_id: 'phase-f-exact-01-replacement-1',
      source_candidate_id: 'candidate-2',
      replaces_case_id: 'case-1',
    }
    const generateVlmBlindCandidateReplacements = vi.fn().mockResolvedValue({
      ...dataset,
      summary: {
        pending: 1,
        accepted: 0,
        rejected: 0,
        historical_rejected: 1,
        historical_accepted: 0,
      },
      cases: [{ ...rejected, is_active: false }, replacement],
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      importVlmBlindCandidateReviewPacket: vi.fn(),
      reviewVlmBlindCandidate: vi.fn(),
      generateVlmBlindCandidateReplacements,
    }
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={rejectedDataset}
        apiClient={apiClient as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '丢弃查询并生成替代候选' }))

    await waitFor(() =>
      expect(generateVlmBlindCandidateReplacements).toHaveBeenCalledWith('dataset-1'),
    )
    expect(screen.getByText('历史拒绝 1')).toBeInTheDocument()
    expect(screen.getByText('phase-f-exact-01-replacement-1')).toBeInTheDocument()
    expect(screen.getAllByLabelText('播放候选视频：有人在海边走路')).toHaveLength(1)
  })

  test('offers quota rebalance after all accepted groups drift and keeps accepted history visible', async () => {
    const acceptedCases = Array.from({ length: 60 }, (_, index) => ({
      ...dataset.cases[0]!,
      id: `case-${index + 1}`,
      source_candidate_id: `candidate-${index + 1}`,
      proposal_id: `proposal-${index + 1}`,
      review_status: 'accepted' as const,
      reviewed_group: index < 28 ? ('missing_must_have' as const) : ('exact_match' as const),
    }))
    const acceptedDataset: VlmBlindDataset = {
      ...dataset,
      summary: {
        pending: 0,
        accepted: 60,
        rejected: 0,
        historical_rejected: 29,
        historical_accepted: 0,
      },
      cases: acceptedCases,
    }
    const rebalanceVlmBlindCandidateGroups = vi.fn().mockResolvedValue({
      ...acceptedDataset,
      summary: {
        pending: 16,
        accepted: 44,
        rejected: 0,
        historical_rejected: 29,
        historical_accepted: 16,
      },
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      importVlmBlindCandidateReviewPacket: vi.fn(),
      reviewVlmBlindCandidate: vi.fn(),
      rebalanceVlmBlindCandidateGroups,
    }
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={acceptedDataset}
        apiClient={apiClient as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '按人工分组生成替代候选' }))

    await waitFor(() => expect(rebalanceVlmBlindCandidateGroups).toHaveBeenCalledWith('dataset-1'))
    expect(screen.getByText('历史接受 16')).toBeInTheDocument()
    expect(screen.getByText('已生成 16 条待审核配额替代候选。')).toBeInTheDocument()
  })

  test('freezes a balanced accepted batch and exposes the immutable audit state', async () => {
    const balancedCases = Array.from({ length: 60 }, (_, index) => {
      const reviewedGroup = [
        'exact_match',
        'missing_must_have',
        'exclusion_hit',
        'partial_relevance',
        'insufficient_evidence',
      ][Math.floor(index / 12)] as VlmBlindDataset['cases'][number]['proposed_group']
      return {
        ...dataset.cases[0]!,
        id: `case-${index + 1}`,
        source_candidate_id: `candidate-${index + 1}`,
        proposal_id: `proposal-${index + 1}`,
        proposed_group: reviewedGroup,
        reviewed_group: reviewedGroup,
        review_status: 'accepted' as const,
      }
    })
    const acceptedDataset: VlmBlindDataset = {
      ...dataset,
      summary: {
        pending: 0,
        accepted: 60,
        rejected: 0,
        historical_rejected: 52,
        historical_accepted: 47,
      },
      cases: balancedCases,
    }
    const freezeVlmBlindCandidateReview = vi.fn().mockResolvedValue({
      ...acceptedDataset,
      status: 'frozen',
      frozen_fingerprint: 'a'.repeat(64),
    })
    const apiClient = {
      mediaContentUrl: (id: string) => `http://api.test/media/${id}/content#t=3,9`,
      importVlmBlindCandidateReviewPacket: vi.fn(),
      reviewVlmBlindCandidate: vi.fn(),
      freezeVlmBlindCandidateReview,
    }
    render(
      <VlmBlindCandidateReviewWorkspace
        packet={packet}
        initialDataset={acceptedDataset}
        apiClient={apiClient as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '冻结盲测候选' }))

    await waitFor(() => expect(freezeVlmBlindCandidateReview).toHaveBeenCalledWith('dataset-1'))
    expect(screen.getByText('候选已冻结')).toBeInTheDocument()
    expect(screen.getByText(/冻结指纹 aaaaaaaa/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '冻结盲测候选' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '已接受' })).not.toBeInTheDocument()
  })
})
