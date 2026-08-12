import { describe, expect, test, vi } from 'vitest'
import type { Settings } from '../../src/config/settings.js'
import {
  AGENT_INTENT_MAX_RESPONSE_BYTES,
  AGENT_INTENT_PROMPT_VERSION,
  AgentIntentRunnerError,
  QwenAgentIntentRunner,
} from '../../src/agent/qwen-agent-intent.runner.js'

function settings(): Settings {
  return {
    serverHost: '127.0.0.1',
    serverPort: 4000,
    databaseUrl: 'postgres://test:test@localhost/test',
    qdrantUrl: 'http://localhost:6333',
    modelServiceUrl: 'http://localhost:4020',
    modelServiceTimeoutMs: 10_000,
    allowExternalLlm: true,
    anthropicApiKey: undefined,
    agentModel: 'disabled',
    agentMaxSteps: 4,
    agentToolTimeoutMs: 10_000,
    rightCodeBaseUrl: 'https://right.example.test/v1',
    rightCodeApiKey: 'right-secret-key',
    agentExecutorEnabled: true,
    agentExecutorIntervalMs: 2_000,
    agentLeaseDurationMs: 130_000,
    agentActivityTimeoutMs: 120_000,
    agentWaitingTtlSeconds: 604_800,
    jobCoordinatorEnabled: false,
    jobCoordinatorIntervalMs: 5_000,
    jobCoordinatorEmbeddingLimit: 100,
    queryExpansionProvider: 'none',
    queryExpansionTimeoutMs: 10_000,
    queryExpansionMaxVariants: 3,
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekApiKey: undefined,
    deepseekModel: 'deepseek-v4-flash',
    captionIndexingEnabled: false,
    captionSearchEnabled: false,
    localVlmEnabled: false,
    localVlmServiceUrl: 'http://localhost:4030',
    searchRerankMode: 'off',
    searchRerankTopK: 10,
    searchRerankTimeoutMs: 30_000,
    frameCacheEnabled: false,
    frameCacheMaxBytes: 1_073_741_824,
    frameCacheImageMaxWidth: 512,
  }
}

function successfulResponse(input: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'qwen3.7-plus',
      content: [
        {
          type: 'tool_use',
          id: 'tool_test',
          name: 'extract_agent_intent',
          input,
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 123, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function validIntent(overrides: Record<string, unknown> = {}) {
  return {
    goal: 'search',
    search_scope: 'visual',
    media_types: ['video'],
    library_references: [],
    conditions: [],
    needs_clarification: false,
    clarification_reason: null,
    requested_effect: null,
    ...overrides,
  }
}

function runnerReturning(response: Response) {
  return new QwenAgentIntentRunner(
    settings(),
    vi.fn(async () => response),
  )
}

async function expectRunnerError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code } satisfies Partial<AgentIntentRunnerError>)
}

describe('QwenAgentIntentRunner', () => {
  test('合法响应通过唯一强制 Tool Call 返回可追溯的 AgentIntent', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      successfulResponse({
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
      }),
    )
    const runner = new QwenAgentIntentRunner(settings(), request)

    const result = await runner.extract({
      userPrompt: '帮我找红色汽车的视频',
      capabilityBoundary: {
        allowedMediaTypes: ['video'],
        hasEnforcedLibraryScope: true,
      },
    })

    expect(result.intent).toMatchObject({
      goal: 'search',
      search_scope: 'visual',
      media_types: ['video'],
    })
    expect(result.provider).toMatchObject({
      prompt_version: 'agent-intent-v1',
      schema_version: 'agent-intent-schema-v1',
    })
    expect(result.conditions).toEqual([
      expect.objectContaining({
        source_text: '红色汽车',
        normalized_source_text: '红色汽车',
      }),
    ])
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('https://right.example.test/v1/messages')
    expect(init?.headers).toMatchObject({
      'x-api-key': 'right-secret-key',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'qwen3.7-plus',
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'extract_agent_intent' },
    })
    expect(String(body.system)).toContain(AGENT_INTENT_PROMPT_VERSION)
    expect(String(body.system)).toMatch(
      /visual means|spoken means|broadest safe scope|needs_clarification/,
    )
    expect(body.tools).toEqual([
      expect.objectContaining({ name: 'extract_agent_intent', input_schema: expect.any(Object) }),
    ])
    const serialized = JSON.stringify(body)
    expect(serialized).toContain('帮我找红色汽车的视频')
    expect(serialized).not.toMatch(/caption|transcript|file_name|absolute_path|candidate_frame/i)
  })

  test('工具名错误时明确失败，不接受相似工具', async () => {
    const response = successfulResponse(validIntent())
    const body = (await response.json()) as { content: Array<Record<string, unknown>> }
    body.content[0]!.name = 'extract_intent'

    await expectRunnerError(
      runnerReturning(new Response(JSON.stringify(body), { status: 200 })).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_TOOL_CALL_INVALID',
    )
  })

  test('没有 Tool Call 时明确失败，不从自由文本提取 JSON', async () => {
    const response = new Response(
      JSON.stringify({
        id: 'msg_text',
        model: 'qwen3.7-plus',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(validIntent()) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200 },
    )

    await expectRunnerError(
      runnerReturning(response).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_RESPONSE_INVALID',
    )
  })

  test('重复 Tool Call 时明确失败，不选择其中一个继续', async () => {
    const response = successfulResponse(validIntent())
    const body = (await response.json()) as { content: Array<Record<string, unknown>> }
    body.content.push({ ...body.content[0], id: 'tool_duplicate' })

    await expectRunnerError(
      runnerReturning(new Response(JSON.stringify(body), { status: 200 })).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_TOOL_CALL_INVALID',
    )
  })

  test.each([
    ['未知枚举', validIntent({ search_scope: 'nearby' })],
    [
      '缺少字段',
      (() => {
        const intent: Record<string, unknown> = validIntent()
        delete intent.requested_effect
        return intent
      })(),
    ],
    ['额外字段', validIntent({ query: '模型改写后的查询' })],
  ])('%s 不符合严格 AgentIntent Schema 时明确失败', async (_name, intent) => {
    await expectRunnerError(
      runnerReturning(successfulResponse(intent)).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_SCHEMA_INVALID',
    )
  })

  test('prompt 超过 4000 个 Unicode 字符时在发请求前拒绝', async () => {
    const request = vi.fn<typeof fetch>(async () => successfulResponse(validIntent()))
    const runner = new QwenAgentIntentRunner(settings(), request)

    await expectRunnerError(
      runner.extract({
        userPrompt: '影'.repeat(4001),
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_PROMPT_INVALID',
    )
    expect(request).not.toHaveBeenCalled()
  })

  test('Provider 报告输出超过 2000 tokens 时明确失败', async () => {
    const response = successfulResponse(validIntent())
    const body = (await response.json()) as { usage: { output_tokens: number } }
    body.usage.output_tokens = 2001

    await expectRunnerError(
      runnerReturning(new Response(JSON.stringify(body), { status: 200 })).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_RESPONSE_INVALID',
    )
  })

  test('Provider 返回其他模型时明确失败，不能把兼容接口误当成固定模型', async () => {
    const response = successfulResponse(validIntent())
    const body = (await response.json()) as { model: string }
    body.model = 'qwen-other'

    await expectRunnerError(
      runnerReturning(new Response(JSON.stringify(body), { status: 200 })).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_RESPONSE_INVALID',
    )
  })

  test('Provider 网络超时进入 outcome_unknown，错误不包含请求数据或密钥', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('timeout right-secret-key /Users/test/private caption hidden-thinking')
    })
    const runner = new QwenAgentIntentRunner(settings(), request)

    const error = await runner
      .extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'AGENT_INTENT_OUTCOME_UNKNOWN', outcomeUnknown: true })
    expect(String(error)).not.toMatch(/right-secret-key|\/Users\/test|caption|hidden-thinking/i)
  })

  test('已收到响应头但正文读取中断时仍进入 outcome_unknown', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('body stream aborted'))
        },
      }),
      { status: 200 },
    )

    await expect(
      runnerReturning(response).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_INTENT_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    })
  })

  test('Provider 即使自报低 token，原始响应超过字节上限也明确失败', async () => {
    const response = successfulResponse(validIntent())
    const body = (await response.json()) as Record<string, unknown>
    body.padding = 'x'.repeat(AGENT_INTENT_MAX_RESPONSE_BYTES)

    await expectRunnerError(
      runnerReturning(new Response(JSON.stringify(body), { status: 200 })).extract({
        userPrompt: '找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_RESPONSE_TOO_LARGE',
    )
  })

  test('source_text 不是原文连续子串时明确失败，不做模糊匹配', async () => {
    await expectRunnerError(
      runnerReturning(
        successfulResponse(
          validIntent({
            conditions: [{ source_text: '红色的汽车', kind: 'must_have', evidence_type: 'visual' }],
          }),
        ),
      ).extract({
        userPrompt: '帮我找红色汽车的视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_SOURCE_TEXT_INVALID',
    )
  })

  test('全空白 source_text 在 trim 后明确失败，不能利用空子串通过校验', async () => {
    await expectRunnerError(
      runnerReturning(
        successfulResponse(
          validIntent({
            conditions: [{ source_text: '   ', kind: 'must_have', evidence_type: 'visual' }],
          }),
        ),
      ).extract({
        userPrompt: '帮我找视频',
        capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
      }),
      'AGENT_INTENT_SOURCE_TEXT_INVALID',
    )
  })

  test('原文引用只允许 NFC、CRLF→LF 和 source_text 两端空白归一化', async () => {
    const runner = runnerReturning(
      successfulResponse(
        validIntent({
          conditions: [
            {
              // 模型返回 NFD 形式的 e + 组合音标，并在两端带空白；原文使用 NFC é。
              source_text: '  cafe\u0301\r\n夜景  ',
              kind: 'must_have',
              evidence_type: 'visual',
            },
          ],
        }),
      ),
    )

    const result = await runner.extract({
      userPrompt: '查找 café\r\n夜景视频',
      capabilityBoundary: { allowedMediaTypes: ['video'], hasEnforcedLibraryScope: false },
    })

    expect(result.conditions).toEqual([
      expect.objectContaining({
        source_text: '  cafe\u0301\r\n夜景  ',
        normalized_source_text: 'café\n夜景',
      }),
    ])
  })
})
