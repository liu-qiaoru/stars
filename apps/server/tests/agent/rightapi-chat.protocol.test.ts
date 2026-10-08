import { describe, expect, test } from 'vitest'
import {
  chatCompletionsUrl,
  chatRequest,
  chatResponse,
} from '../../src/agent/rightapi-chat.protocol.js'

/** 固定真实响应中“文字伴随工具调用”的形状；文字不进入持久化或前端。 */
const response = () => ({
  id: 'response',
  model: 'glm-5.3',
  usage: { prompt_tokens: 161, completion_tokens: 37 },
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: 'private reasoning must be discarded',
        tool_calls: [
          {
            id: 'call',
            type: 'function',
            function: {
              name: 'next_retrieval_action',
              arguments: JSON.stringify({
                decision: { action: 'clarify', question: '需要什么素材？' },
              }),
            },
          },
        ],
      },
    },
  ],
})
describe('RightAPI Chat Completions 兼容边界', () => {
  test.each([
    'https://right.test/flash',
    'https://right.test/flash/v1',
    'https://right.test/flash/v1/chat/completions',
    'https://right.test/flash/v1/messages',
  ])('规范化 %s，不重复版本或端点', (base) => {
    expect(chatCompletionsUrl(base)).toBe('https://right.test/flash/v1/chat/completions')
  })
  test('决策使用 object 包装，禁止并行工具，保留 system 安全规则', () => {
    const body = chatRequest({
      model: 'glm-5.3',
      system: 'untrusted',
      messages: [],
      tools: [{ name: 'next_retrieval_action', input_schema: { anyOf: [] } }],
      tool_choice: { name: 'next_retrieval_action' },
    })
    expect(body.tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { decision: { anyOf: [] } },
      required: ['decision'],
      additionalProperties: false,
    })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'untrusted' })
    expect(body.parallel_tool_calls).toBe(false)
  })
  test('返回工具证据及实际用量，丢弃伴随推理文字', () => {
    const result = chatResponse(response())
    expect(result.content[0].input).toEqual({ action: 'clarify', question: '需要什么素材？' })
    expect(result.usage).toEqual({ input_tokens: 161, output_tokens: 37 })
    expect(JSON.stringify(result)).not.toContain('private reasoning')
  })
  test('兼容渠道以 stop 结束的完整工具响应，不把普通文本当工具', () => {
    const raw = response()
    raw.choices[0].finish_reason = 'stop'
    expect(chatResponse(raw).content[0].name).toBe('next_retrieval_action')
    raw.choices[0].message.tool_calls = []
    expect(() => chatResponse(raw)).toThrow()
  })
  test.each(['duplicate', 'truncated', 'invalid-json', 'extra-field'])(
    '拒绝 %s，不选择其中一部分执行',
    (scenario) => {
      const raw = response()
      if (scenario === 'duplicate')
        raw.choices[0].message.tool_calls.push(raw.choices[0].message.tool_calls[0])
      if (scenario === 'truncated') raw.choices[0].finish_reason = 'length'
      if (scenario === 'invalid-json') raw.choices[0].message.tool_calls[0].function.arguments = '{'
      if (scenario === 'extra-field')
        raw.choices[0].message.tool_calls[0].function.arguments = '{"decision":{},"path":"/secret"}'
      expect(() => chatResponse(raw)).toThrow()
    },
  )
})
