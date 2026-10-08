/** RightAPI 文本 Agent 的 Chat Completions 协议边界；不读取凭证、不决定工具权限。
 * 内部保留现有单工具描述，统一转换请求及响应，业务 Runner 仍负责严格 Schema 校验。
 */
export function chatCompletionsUrl(base: string) {
  const root = base.replace(/\/+$/, '').replace(/\/v1\/(messages|chat\/completions)$/, '')
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/chat/completions`
}

/** 决策 union 放进 object 字段，避免渠道拒绝根节点 anyOf；只允许一个工具调用。 */
export function chatRequest(body: any) {
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    // GLM-5.3 官方只支持启用推理；low 控制成本，不能沿用旧模型的 disabled。
    thinking: body.thinking,
    reasoning_effort: 'low',
    stream: false,
    parallel_tool_calls: false,
    messages: [{ role: 'system', content: body.system }, ...body.messages],
    tools: body.tools.map((tool: any) => ({
      type: 'function',
      function: {
        name: tool.name,
        strict: true,
        description: tool.description,
        parameters:
          tool.name === 'next_retrieval_action'
            ? {
                type: 'object',
                properties: { decision: tool.input_schema },
                required: ['decision'],
                additionalProperties: false,
              }
            : tool.input_schema,
      },
    })),
    tool_choice: { type: 'function', function: { name: body.tool_choice.name } },
  }
}

/** 固定协议分类便于排错；message 不含 Provider 返回值，可安全转成诊断 reason。 */
export class ChatResponseProtocolError extends Error {
  constructor(readonly reason: 'invalid_completion' | 'invalid_tool_count' | 'invalid_arguments_json' | 'invalid_decision_wrapper') {
    super(reason)
    this.name = 'ChatResponseProtocolError'
  }
}

/** 仅提取工具参数；伴随文字可能含推理，绝不展示、持久化或用于决策。
 * 不接受多 choice、多工具、截断结果或非 JSON 参数；调用方转为脱敏协议错误。
 */
export function chatResponse(raw: any) {
  if (raw?.choices?.length !== 1 || !['tool_calls', 'stop'].includes(raw.choices[0]?.finish_reason))
    throw new ChatResponseProtocolError('invalid_completion')
  // RightAPI 实测可能以 stop 结束合法工具响应；仍要求完整且唯一的 function call。
  const calls = raw.choices[0].message?.tool_calls
  if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.type !== 'function') throw new ChatResponseProtocolError('invalid_tool_count')
  const call = calls[0]
  let args: any
  try {
    if (typeof call.function?.arguments !== 'string') throw new Error('arguments')
    args = JSON.parse(call.function.arguments)
  } catch {
    // JSON.parse 的原始错误可能引用返回内容，因此只向上交付固定分类。
    throw new ChatResponseProtocolError('invalid_arguments_json')
  }
  if (
    call.function.name === 'next_retrieval_action' &&
    (!args || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'decision'))
  )
    throw new ChatResponseProtocolError('invalid_decision_wrapper')
  return {
    id: raw.id,
    model: raw.model,
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: call.function.name === 'next_retrieval_action' ? args.decision : args,
      },
    ],
    usage: { input_tokens: raw.usage?.prompt_tokens, output_tokens: raw.usage?.completion_tokens },
  }
}
