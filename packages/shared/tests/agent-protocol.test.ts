import { describe, expect, test } from 'vitest'
import {
  agentExportSelectionInputSchema,
  agentIntentSchema,
  agentRunStatusSchema,
  confirmAgentExportInputSchema,
  createAgentRunInputSchema,
  resumeAgentRunInputSchema,
} from '../schemas/index.js'

describe('Agent V1 协议', () => {
  test('AgentIntent 只接受冻结的枚举和完整字段', () => {
    const intent = {
      goal: 'search',
      search_scope: 'visual',
      media_types: ['video'],
      library_references: [],
      conditions: [
        {
          source_text: '红色汽车',
          kind: 'must_have',
          evidence_type: 'visual',
        },
      ],
      needs_clarification: false,
      clarification_reason: null,
      requested_effect: null,
    }

    expect(agentIntentSchema.parse(intent)).toEqual(intent)
    expect(() => agentIntentSchema.parse({ ...intent, query: '红色汽车' })).toThrow()
    expect(() => agentIntentSchema.parse({ ...intent, goal: 'autonomous_loop' })).toThrow()
  })

  test('run 状态只允许冻结状态机中的值', () => {
    expect(agentRunStatusSchema.parse('outcome_unknown')).toBe('outcome_unknown')
    expect(agentRunStatusSchema.parse('waiting_for_user_input')).toBe('waiting_for_user_input')
    expect(() => agentRunStatusSchema.parse('model_is_thinking')).toThrow()
  })

  test('创建 run 必须单独保存文本授权，且 prompt 按 Unicode 字符限制为 4000', () => {
    const parsed = createAgentRunInputSchema.parse({
      prompt: '帮我找红色汽车的视频',
      allow_external_text: true,
      allow_external_visual: false,
      library_ids: [],
      media_types: ['video'],
    })

    expect(parsed.allow_external_text).toBe(true)
    expect(parsed.allow_external_visual).toBe(false)
    expect(() =>
      createAgentRunInputSchema.parse({
        prompt: '🚀'.repeat(4001),
        allow_external_text: true,
      }),
    ).toThrow('prompt must contain at most 4000 Unicode characters')
    expect(() =>
      createAgentRunInputSchema.parse({ prompt: '找视频', allow_external_vlm: true }),
    ).toThrow()
  })

  test('恢复请求保存真实补充文本，未传素材授权不新增授权', () => {
    const input = {
      waiting_step_id: '11111111-1111-4111-8111-111111111111',
      client_request_id: 'resume-001',
      response: 'continue_as_read_only_search_with_resolved_scope',
    }

    expect(resumeAgentRunInputSchema.parse(input)).toEqual(input)
    expect(resumeAgentRunInputSchema.parse({ ...input, response: '只在家庭视频中搜索' }).response).toBe('只在家庭视频中搜索')
  })

  test('导出选择只接受正向场景时间范围，确认必须携带等待步骤和幂等键', () => {
    expect(
      agentExportSelectionInputSchema.parse({
        candidate_key: 'video:scene-1',
        start_time_seconds: 12,
        end_time_seconds: 18,
      }),
    ).toEqual({
      candidate_key: 'video:scene-1',
      start_time_seconds: 12,
      end_time_seconds: 18,
      output_format: 'mp4',
    })
    expect(() =>
      agentExportSelectionInputSchema.parse({
        candidate_key: 'video:scene-1',
        start_time_seconds: 18,
        end_time_seconds: 12,
      }),
    ).toThrow('end_time_seconds must be greater')

    const confirmation = {
      waiting_step_id: '11111111-1111-4111-8111-111111111111',
      tool_call_id: 'export-1',
      client_request_id: 'confirm-1',
    }
    expect(confirmAgentExportInputSchema.parse(confirmation)).toEqual(confirmation)
    expect(() =>
      confirmAgentExportInputSchema.parse({ ...confirmation, arbitrary_env: 'x' }),
    ).toThrow()
  })
})
