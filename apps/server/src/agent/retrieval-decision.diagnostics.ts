import { retrievalResponseModelMatches } from './retrieval-model.policy.js'
import type { ZodIssue } from 'zod'
import { retrievalActionJsonSchema } from '@local-media-agent/shared/schemas'

/** 类型名称只描述结构，不复制字段值；用于让一次有限纠正知道缺什么。 */
type SafeValueType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'undefined' | 'null'
export interface RetrievalValidationIssue {
  code: ZodIssue['code']
  path: Array<string | number>
  expected_type?: SafeValueType
  received_type?: SafeValueType
  unrecognized_key_count?: number
}

/**
 * 决策失败的安全摘要：由 HTTP Runner 生成，执行器写入步骤表与终端日志。
 * 只保留固定分类、计数与字段位置；绝不复制响应正文、参数值、素材或异常 message。
 */
export interface RetrievalDecisionDiagnostics {
  stage:
    | 'request' | 'transport' | 'http' | 'response_read'
    | 'response_json' | 'response_protocol' | 'model_identity' | 'action_schema'
  reason:
    | 'context_limit' | 'request_failed_or_timed_out' | 'rate_limited' | 'http_error'
    | 'response_read_failed' | 'response_too_large' | 'invalid_response_json'
    | 'invalid_completion' | 'invalid_tool_count' | 'invalid_arguments_json'
    | 'invalid_decision_wrapper' | 'invalid_response_shape'
    | 'unexpected_model_or_tool' | 'invalid_action_fields'
  requested_model: 'glm-5.3' | 'deepseek-v4-flash'
  response_model: 'glm-5.3' | 'deepseek-v4-flash' | 'unexpected' | null
  request_id: string | null
  http_status: number | null
  finish_reason: 'tool_calls' | 'stop' | 'length' | 'content_filter' | 'other' | null
  tool_call_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  /** 字节数是 UTF-8 编码长度；耗时/超时的单位为毫秒，缺失用量保持 null。 */
  request_bytes: number
  timeout_ms: number
  max_output_tokens: 2000
  reasoning_effort: 'low'
  context_counts: { candidates: number | null; details: number | null; queries: number | null }
  response_bytes: number | null
  elapsed_ms: number
  issues: RetrievalValidationIssue[]
  omitted_issue_count: number
}

/** 请求编号只接受短标识；带空白、路径或过长字符串时丢弃，防止日志注入。 */
export function safeProviderRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null
}

/** 只读取约定的响应元数据，不保存模型随响应返回的任意文字。 */
export function responseDiagnostics(raw: any): Pick<
  RetrievalDecisionDiagnostics,
  'response_model' | 'finish_reason' | 'tool_call_count' | 'input_tokens' | 'output_tokens'
> {
  const choice = Array.isArray(raw?.choices) ? raw.choices[0] : undefined
  const finish = choice?.finish_reason
  return {
    response_model: raw?.model === 'glm-5.3' ? 'glm-5.3' : retrievalResponseModelMatches('deepseek-v4-flash', raw?.model) ? 'deepseek-v4-flash' : raw?.model == null ? null : 'unexpected',
    finish_reason: finish == null ? null : ['tool_calls', 'stop', 'length', 'content_filter'].includes(finish) ? finish : 'other',
    tool_call_count: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.length : null,
    input_tokens: Number.isSafeInteger(raw?.usage?.prompt_tokens) && raw.usage.prompt_tokens >= 0 ? raw.usage.prompt_tokens : null,
    output_tokens: Number.isSafeInteger(raw?.usage?.completion_tokens) && raw.usage.completion_tokens >= 0 ? raw.usage.completion_tokens : null,
  }
}

// 字段白名单从共享权威约束取得，新增gap等字段不再因维护遗漏而被隐藏。
// 仅遍历受信任的程序Schema，绝不从模型输入收集任意键名。
const actionFields = new Set<string>()
function collectSchemaFields(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const object = node as Record<string, unknown>
  if (object.properties && typeof object.properties === 'object')
    Object.keys(object.properties).forEach(key => actionFields.add(key))
  Object.values(object).forEach(value => {
    if (Array.isArray(value)) value.forEach(collectSchemaFields)
    else collectSchemaFields(value)
  })
}
collectSchemaFields(retrievalActionJsonSchema)
const safeTypes = new Set<string>(['string', 'number', 'boolean', 'array', 'object', 'undefined', 'null'])

/** 最多保存20个位置和固定类型；unknown键只数数量，不保存message、键名或值。 */
export function safeValidationIssues(issues: ZodIssue[]): Pick<RetrievalDecisionDiagnostics, 'issues' | 'omitted_issue_count'> {
  return {
    issues: issues.slice(0, 20).map((issue) => ({
      code: issue.code,
      path: issue.path.slice(0, 12).map((part) =>
        typeof part === 'number' ? part : actionFields.has(part) ? part : '[unexpected_field]',
      ),
      ...(issue.code === 'invalid_type' ? {
        ...(safeTypes.has(issue.expected) ? { expected_type: issue.expected as SafeValueType } : {}),
        ...(safeTypes.has(issue.received) ? { received_type: issue.received as SafeValueType } : {}),
      } : {}),
      ...(issue.code === 'unrecognized_keys' ? { unrecognized_key_count: issue.keys.length } : {}),
    })),
    omitted_issue_count: Math.max(0, issues.length - 20),
  }
}
