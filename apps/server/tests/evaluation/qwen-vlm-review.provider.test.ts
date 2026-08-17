import { describe, expect, test, vi } from 'vitest'
import {
  buildQwenVlmReviewRequestBody,
  QwenVlmReviewProvider,
} from '../../src/evaluation/qwen-vlm-review.provider.js'

const request = {
  protocol_version: 'vlm-review-v1' as const,
  model: 'qwen3.7-plus' as const,
  original_query: '有人在桥下走路',
  candidate_key: 'video:scene-1',
  conditions: [{ condition_id: 'must-1', kind: 'must_have' as const, source_text: '有人走路' }],
  evidence_frames: [{ frame_id: '11111111-1111-4111-8111-111111111111', image_base64: 'ZmFrZQ==' }],
}

describe('qwen3.7-plus VLM review Provider', () => {
  test('builds non-thinking Anthropic Base64 input with one forced tool and no forbidden metadata', () => {
    const body = buildQwenVlmReviewRequestBody(request)
    const serialized = JSON.stringify(body)

    expect(body).toMatchObject({
      model: 'qwen3.7-plus',
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'submit_candidate_review' },
    })
    expect(serialized).toContain('ZmFrZQ==')
    for (const forbidden of ['caption', 'transcript', 'file_path', 'library_path']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden)
    }
  })

  test('accepts exactly one forced tool call and returns only safe audit metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'req-safe-id',
          model: 'qwen3.7-plus',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'submit_candidate_review',
              input: {
                candidate_key: request.candidate_key,
                conditions: [
                  {
                    condition_id: 'must-1',
                    verdict: 'yes',
                    evidence_frame_ids: [request.evidence_frames[0].frame_id],
                  },
                ],
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200 },
      ),
    )
    const provider = new QwenVlmReviewProvider(settings(), fetcher)

    const result = await provider.review(request)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(result.audit).toMatchObject({
      provider_request_id: 'req-safe-id',
      response_model: 'qwen3.7-plus',
      total_tokens: 12,
      billed_cost_cny: null,
    })
    expect(JSON.stringify(result.audit)).not.toContain('ZmFrZQ==')
  })

  test('rejects free text, extra calls, or the wrong tool instead of guessing JSON', async () => {
    const provider = new QwenVlmReviewProvider(
      settings(),
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'req-invalid',
            model: 'qwen3.7-plus',
            stop_reason: 'tool_use',
            content: [{ type: 'text', text: '```json\n{}\n```' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(provider.review(request)).rejects.toMatchObject({
      code: 'VLM_REVIEW_TOOL_CALL_INVALID',
      outcomeUnknown: false,
      responseReceived: true,
    })
  })
})

function settings() {
  return {
    rightCodeBaseUrl: 'https://provider.example/v1',
    rightCodeApiKey: 'secret',
  } as never
}
