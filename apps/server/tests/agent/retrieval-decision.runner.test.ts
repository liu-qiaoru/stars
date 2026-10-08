import { responseDiagnostics } from '../../src/agent/retrieval-decision.diagnostics.js'
import { describe, expect, test, vi } from 'vitest'
import { retrievalActionSchema } from '@local-media-agent/shared/schemas'
import { createSettings } from '../../src/config/settings.js'
import { RightApiRetrievalDecisionRunner } from '../../src/agent/retrieval-decision.runner.js'
import { AgentRuntimeConfigService } from '../../src/agent/agent-runtime-config.service.js'

const config = (enabled = true) =>
  createSettings({
    DATABASE_URL: 'postgres://test:test@localhost/test',
    QDRANT_URL: 'http://localhost:6333',
    ALLOW_EXTERNAL_LLM: String(enabled),
    RIGHT_CODE_BASE_URL: 'https://right.test/v1',
    RIGHT_CODE_API_KEY: 'test-only-secret',
  })
const action = {
  action: 'search_media',
  query: '车',
  search_scope: 'visual',
  media_types: ['video'],
  limit: 5,
}
const response = (model = 'glm-5.3', input: unknown = action) =>
  new Response(
    JSON.stringify({
      id: 'r',
      model,
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'next_retrieval_action',
                  arguments: JSON.stringify({ decision: input }),
                },
              },
            ],
          },
        },
      ],
    }),
  )

describe('RightAPI 单步检索决策传输协议（仅 HTTP 替身）', () => {
  test('20图输入不要求20份输出：新协议仅提交最多两个关键判断，避免2000token截断', async () => {
    const settings = { ...config(), agentRetrievalModel: 'deepseek-v4-flash' as const, agentRetrievalEvidenceMode: 'matched_multimodal' as const }
    const finish = { action: 'finish', reason: 'partial', assessments: Array.from({ length: 3 }, (_, i) => ({ candidate_key: `image:${i}`, conditions: [] })) }
    const request = vi.fn().mockResolvedValue(response('deepseek-v4-flash', finish))
    await expect(new RightApiRetrievalDecisionRunner(settings, request).decide({ candidates: Array.from({ length: 20 }, (_, i) => ({ candidate_key: `image:${i}` })) })).rejects.toMatchObject({ code: 'AGENT_DECISION_INVALID' })
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body.max_tokens).toBe(2000)
    expect(JSON.stringify(body.tools)).toContain('"maxItems":2')
    expect(body.messages.find((m: any) => m.role === 'system').content).toContain('at most TWO')
    // 新输出限制不重写旧协议和历史任务。
    expect((await new RightApiRetrievalDecisionRunner(config(), vi.fn().mockResolvedValue(response('glm-5.3', finish))).decide({})).action).toEqual(finish)
  })
  test('命中图片的数量、重复身份、字节和格式硬限制在外发前拒绝', async () => {
    const settings = { ...config(), agentRetrievalModel: 'deepseek-v4-flash' as const, agentRetrievalEvidenceMode: 'matched_multimodal' as const }
    const image = { candidate_key: 'image:one', evidence_id: 'frame:one', data_url: 'data:image/jpeg;base64,/9j/2Q==' }
    const request = vi.fn()
    const runner = new RightApiRetrievalDecisionRunner(settings, request)
    for (const images of [Array.from({ length: 21 }, (_, i) => ({ ...image, candidate_key: `image:${i}` })),
      [image, image], [{ ...image, data_url: `data:image/jpeg;base64,${Buffer.alloc(20001).toString('base64')}` }],
      [{ ...image, data_url: 'file:///private/test.jpg' }]]) {
      await expect(runner.decide({}, images)).rejects.toMatchObject({ code: 'AGENT_CONTEXT_LIMIT' })
    }
    await expect(runner.decide({ oversized: 'x'.repeat(750001) }, [image])).rejects.toMatchObject({ code: 'AGENT_CONTEXT_LIMIT' })
    await expect(new RightApiRetrievalDecisionRunner(config(), request).decide({}, [image])).rejects.toMatchObject({ code: 'AGENT_SCENE_UNAVAILABLE' })
    expect(request).not.toHaveBeenCalled()
  })
  test('同一DeepSeek决策请求包含20个候选的命中图，并直接返回补搜动作', async () => {
    const settings = { ...config(), agentRetrievalModel: 'deepseek-v4-flash' as const, agentRetrievalEvidenceMode: 'matched_multimodal' as const }
    const images = Array.from({ length: 20 }, (_, i) => ({ candidate_key: `video:${i}`, evidence_id: `frame:${i}`, data_url: 'data:image/jpeg;base64,/9j/2Q==' }))
    const request = vi.fn().mockResolvedValue(response('deepseek-v4-1-flash-260910'))
    const runner = new RightApiRetrievalDecisionRunner(settings, request)
    const result = await runner.decide({ original_goal: '小猫趴在猫爬架上', candidates: images.map(({ candidate_key }) => ({ candidate_key })) }, images)
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body.model).toBe('deepseek-v4-flash')
    const content = body.messages.find((message: any) => message.role === 'user').content
    expect(content.filter((block: any) => block.type === 'image_url')).toHaveLength(20)
    expect(content[0].text).toContain('小猫趴在猫爬架上')
    expect(content.some((block: any) => block.text?.includes('frame:19'))).toBe(true)
    expect(result.action).toEqual(action)
    expect(request).toHaveBeenCalledTimes(1)
  })
  test('显式选择DeepSeek时只请求该模型并接受渠道报告的版本名，不影响GLM默认值', async () => {
    const settings = createSettings({ DATABASE_URL: 'postgres://test:test@localhost/test', QDRANT_URL: 'http://localhost:6333',
      ALLOW_EXTERNAL_LLM: 'true', RIGHT_CODE_BASE_URL: 'https://right.test/v1', RIGHT_CODE_API_KEY: 'fake',
      AGENT_RETRIEVAL_MODEL: 'deepseek-v4-flash' })
    const request = vi.fn().mockResolvedValue(response('deepseek-v4-1-flash-260910'))
    expect((await new RightApiRetrievalDecisionRunner(settings, request).decide({ original_goal: '车' })).action).toEqual(action)
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' } })
    expect(config().agentRetrievalModel).toBe('glm-5.3')
  })
  test('证据缺口只接受原条件身份、明确类别和有界检查记录', () => {
    const gap = { condition_ids: ['11111111-1111-4111-8111-111111111111'],
      kind: 'details_unread', checked: [], missing_evidence: '尚未读取该场景',
      next_step_reason: '读取现有描述以检查位置关系', preserves_original_goal: true }
    expect(retrievalActionSchema.safeParse({ action: 'get_segment_details', candidate_key: 'video:one', gap }).success).toBe(true)
    expect(retrievalActionSchema.safeParse({ action: 'get_segment_details', candidate_key: 'video:one', gap: { ...gap, condition_ids: ['invented'] } }).success).toBe(false)
    expect(retrievalActionSchema.safeParse({ ...action, gap: { ...gap, preserves_original_goal: false } }).success).toBe(false)
  })
  test('一次可提出最多3个不同候选的详情读取，重复、超额与额外路径字段被拒绝', () => {
    const batch = { action: 'get_segment_details_batch', candidate_keys: ['video:one', 'video:two'] }
    expect(retrievalActionSchema.safeParse(batch).success).toBe(true)
    expect(retrievalActionSchema.safeParse({ ...batch, candidate_keys: [] }).success).toBe(false)
    expect(retrievalActionSchema.safeParse({ ...batch, candidate_keys: ['video:one', 'video:one'] }).success).toBe(false)
    expect(retrievalActionSchema.safeParse({ ...batch, candidate_keys: ['a', 'b', 'c', 'd'] }).success).toBe(false)
    expect(retrievalActionSchema.safeParse({ ...batch, path: '/private/source' }).success).toBe(false)
  })
  test('模型默认等待 60 秒，不使用本地工具的 10 秒时限', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await new RightApiRetrievalDecisionRunner(config(), vi.fn().mockResolvedValue(response())).decide({})
      expect(timeout).toHaveBeenCalledWith(60_000)
    } finally { timeout.mockRestore() }
  })
  test('运行配置覆盖模型时限，旧页面保存其他参数不会重置模型时限', async () => {
    const runtime = new AgentRuntimeConfigService(config())
    runtime.update({ ...runtime.values(), model_timeout_ms: 80_000 })
    const { model_timeout_ms: _omitted, ...oldPageInput } = runtime.values()
    runtime.update(oldPageInput)
    expect(runtime.values().model_timeout_ms).toBe(80_000)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const runner = new RightApiRetrievalDecisionRunner(config(), vi.fn().mockResolvedValue(response('glm-5.3', { ...action, limit: 21 })), runtime)
      await expect(runner.decide({})).rejects.toMatchObject({
        diagnostics: { timeout_ms: 80_000 },
      })
      expect(timeout).toHaveBeenCalledWith(80_000)
    } finally { timeout.mockRestore() }
    expect(() => runtime.update({ ...runtime.values(), activity_timeout_ms: 20_000, tool_timeout_ms: 10_000, lease_duration_ms: 84_999 })).toThrow()
  })
  test('只请求 glm-5.3 并校验结构化输出，素材文字作为不可信数据', async () => {
    const request = vi.fn().mockResolvedValue(response())
    const runner = new RightApiRetrievalDecisionRunner(config(), request)
    expect((await runner.decide({ original_goal: '车' })).action).toEqual(action)
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body.model).toBe('glm-5.3')
    expect(body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
    expect(request.mock.calls[0]![1].headers).toMatchObject({
      Authorization: 'Bearer test-only-secret',
    })
    expect(body.tools[0].function.strict).toBe(true)
    expect(body.messages[0].content).toContain('UNTRUSTED DATA')
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: '{"original_goal":"车"}' }])
    expect(request.mock.calls[0]![0]).toBe('https://right.test/v1/chat/completions')
  })
  test('默认部署关闭时凭证存在也不外发', async () => {
    const request = vi.fn()
    await expect(
      new RightApiRetrievalDecisionRunner(config(false), request).decide({}),
    ).rejects.toMatchObject({ code: 'AGENT_PROVIDER_DISABLED' })
    expect(request).not.toHaveBeenCalled()
  })
  test.each([
    ['forbidden model', 'qwen3.7-plus', action],
    [
      'path',
      'glm-5.3',
      { action: 'get_segment_details', candidate_key: 'candidate', path: '/secret' },
    ],
    ['library', 'glm-5.3', { ...action, library_ids: ['other'] }],
    ['limit', 'glm-5.3', { ...action, limit: 21 }],
  ])('拒绝 %s', async (_label, model, input) => {
    const request = vi.fn().mockResolvedValue(response(model as string, input))
    await expect(
      new RightApiRetrievalDecisionRunner(config(), request).decide({}),
    ).rejects.toMatchObject({ code: 'AGENT_DECISION_INVALID' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  test('网络中断和 5xx 是未知结果，不能自动改模型或重试', async () => {
    for (const request of [
      vi.fn().mockRejectedValue(new Error('network')),
      vi.fn().mockResolvedValue(new Response('', { status: 503 })),
    ]) {
      await expect(
        new RightApiRetrievalDecisionRunner(config(), request).decide({}),
      ).rejects.toMatchObject({ outcomeUnknown: true })
      expect(request).toHaveBeenCalledTimes(1)
    }
  })
  test('字段校验失败保留安全位置和请求信息，不保存模型正文或错误值', async () => {
    const raw = await response('glm-5.3', { ...action, limit: 21 }).json()
    raw.id = 'request-invalid-limit'
    raw.choices[0].message.content = 'PRIVATE_MODEL_REASONING'
    raw.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
      decision: { ...action, limit: 21, secret: 'PRIVATE_MEDIA_TEXT' },
    })
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)))
    let error: any
    try {
      await new RightApiRetrievalDecisionRunner(config(), request).decide({
        original_goal: 'PRIVATE_USER_PROMPT',
      })
    } catch (caught) { error = caught }
    expect(error).toMatchObject({
      code: 'AGENT_DECISION_INVALID',
      diagnostics: {
        stage: 'action_schema',
        http_status: 200,
        request_id: 'request-invalid-limit',
        finish_reason: 'tool_calls',
        tool_call_count: 1,
        issues: expect.arrayContaining([{ code: 'too_big', path: ['limit'] }]),
      },
    })
    expect(error.diagnostics.request_bytes).toBeGreaterThan(0)
    expect(error.diagnostics.response_bytes).toBeGreaterThan(0)
    expect(error.diagnostics.elapsed_ms).toBeGreaterThanOrEqual(0)
    const stored = JSON.stringify(error.diagnostics)
    for (const secret of ['PRIVATE_MODEL_REASONING', 'PRIVATE_MEDIA_TEXT', 'PRIVATE_USER_PROMPT', 'test-only-secret'])
      expect(stored).not.toContain(secret)
    expect(request).toHaveBeenCalledTimes(1)
  })
  test('缺口格式纠正能够定位合法字段和缺失类型，未知键和错误值仍不外泄', async () => {
    // 模拟已收到的格式错误；不是对历史失败响应的重放或语义真值。
    const request = vi.fn().mockResolvedValue(response('glm-5.3', {
      ...action, gap: { condition_ids: ['11111111-1111-4111-8111-111111111111'],
        kind: 'not_mentioned', checked: [], missing_evidence: 'PRIVATE_MEDIA_TEXT',
        preserves_original_goal: true, PRIVATE_INVENTED_KEY: 'PRIVATE_REASONING' },
    }))
    let error: any
    try { await new RightApiRetrievalDecisionRunner(config(), request).decide({}) }
    catch (caught) { error = caught }
    expect(error.diagnostics.issues).toEqual([
      { code: 'invalid_type', path: ['gap', 'next_step_reason'], expected_type: 'string', received_type: 'undefined' },
      { code: 'unrecognized_keys', path: ['gap'], unrecognized_key_count: 1 },
    ])
    expect(JSON.stringify(error.diagnostics)).not.toContain('PRIVATE_')
    expect(request).toHaveBeenCalledTimes(1)
  })
  test.each([
    ['invalid_response_json', 'response_json'],
    ['truncated', 'response_protocol'],
    ['missing_wrapper', 'response_protocol'],
    ['invalid_arguments', 'response_protocol'],
    ['wrong_model', 'model_identity'],
    ['multiple_tools', 'response_protocol'],
  ])('区分 %s 的失败位置，并从响应头保留请求编号', async (scenario, stage) => {
    const raw = await response().json()
    delete raw.id
    if (scenario === 'truncated') raw.choices[0].finish_reason = 'length'
    if (scenario === 'missing_wrapper') raw.choices[0].message.tool_calls[0].function.arguments = JSON.stringify(action)
    if (scenario === 'invalid_arguments') raw.choices[0].message.tool_calls[0].function.arguments = '{'
    if (scenario === 'wrong_model') raw.model = 'PRIVATE_MODEL_NAME'
    if (scenario === 'multiple_tools') raw.choices[0].message.tool_calls.push(raw.choices[0].message.tool_calls[0])
    const request = vi.fn().mockResolvedValue(new Response(
      scenario === 'invalid_response_json' ? '{' : JSON.stringify(raw),
      { headers: { 'x-request-id': 'header-request' } },
    ))
    await expect(new RightApiRetrievalDecisionRunner(config(), request).decide({})).rejects.toMatchObject({
      code: 'AGENT_DECISION_INVALID',
      diagnostics: { stage, request_id: 'header-request' },
    })
  })
  test('未知元数据被归类或丢弃，错误列表限长且不复制自造键名', async () => {
    const raw = await response('PRIVATE_MODEL_NAME').json()
    raw.id = '/private/SECRET_PATH\nBearer SECRET_KEY'
    raw.choices[0].finish_reason = 'PRIVATE_FINISH_REASON'
    raw.usage = { prompt_tokens: 'PRIVATE_USAGE', completion_tokens: -1 }
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)))
    let error: any
    try { await new RightApiRetrievalDecisionRunner(config(), request).decide({}) }
    catch (caught) { error = caught }
    expect(error.diagnostics).toMatchObject({
      response_model: 'unexpected', finish_reason: 'other', request_id: null,
      input_tokens: null, output_tokens: null,
    })
    expect(JSON.stringify(error.diagnostics)).not.toMatch(/PRIVATE_|SECRET_/)
  })
  test('响应流读取失败保留请求编号，结果未知且不重试', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_READ_ERROR')) } })
    const request = vi.fn().mockResolvedValue(new Response(body, { headers: { 'x-request-id': 'read-request' } }))
    await expect(new RightApiRetrievalDecisionRunner(config(), request).decide({})).rejects.toMatchObject({
      code: 'AGENT_EXTERNAL_OUTCOME_UNKNOWN', outcomeUnknown: true,
      diagnostics: { stage: 'response_read', request_id: 'read-request', http_status: 200, response_bytes: null },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  test('大量字段错误只保存前 20 个位置，并保存上下文计数而非内容', async () => {
    const input = {
      action: 'finish', reason: 'partial',
      assessments: Array.from({ length: 25 }, () => ({
        candidate_key: 'candidate', conditions: [{ condition_id: 'PRIVATE_CONDITION', status: 'PRIVATE_STATUS' }],
      })),
    }
    const request = vi.fn().mockResolvedValue(response('glm-5.3', input))
    let error: any
    try {
      await new RightApiRetrievalDecisionRunner(config(), request).decide({
        candidates: [{ text: 'PRIVATE_CANDIDATE' }], details: { 'PRIVATE_KEY': {} }, queries: [],
      })
    } catch (caught) { error = caught }
    expect(error.diagnostics.issues).toHaveLength(20)
    expect(error.diagnostics.omitted_issue_count).toBeGreaterThan(0)
    expect(error.diagnostics.context_counts).toEqual({ candidates: 1, details: 1, queries: 0 })
    expect(JSON.stringify(error.diagnostics)).not.toContain('PRIVATE_')
  })
  test('上下文超限在发送前拒绝，白名单拒绝任意新工具', async () => {
    const request = vi.fn()
    await expect(
      new RightApiRetrievalDecisionRunner(config(), request).decide({ text: 'x'.repeat(100000) }),
    ).rejects.toMatchObject({ code: 'AGENT_CONTEXT_LIMIT' })
    expect(request).not.toHaveBeenCalled()
    expect(retrievalActionSchema.safeParse({ action: 'read_file', path: '/secret' }).success).toBe(
      false,
    )
  })
})

test('决策只读预检与真实派发使用相同请求摘要和字节数，预算审查不调用模型', async () => {
  const request = vi.fn().mockResolvedValue(response())
  const runner = new RightApiRetrievalDecisionRunner(config(), request)
  const prepared = runner.preflight({ original_goal: '小猫趴在猫爬架上', candidates: [] })
  expect(request).not.toHaveBeenCalled()
  expect(prepared).toMatchObject({ model: 'glm-5.3', max_output_tokens: 2000, external_calls: 0 })
  expect(prepared.request_sha256).toBe(runner.fingerprint({ original_goal: '小猫趴在猫爬架上', candidates: [] }))
  await runner.decide({ original_goal: '小猫趴在猫爬架上', candidates: [] })
  expect(prepared.request_bytes).toBe(Buffer.byteLength(String(request.mock.calls[0]![1].body)))
})

// 诊断只保存已知模型名；渠道别名不能被误报为意外模型，陌生文本不能进入日志。
test('已接受的DeepSeek渠道别名在诊断中归一，陌生模型值仍隐藏', () => {
  expect(responseDiagnostics({ model: 'deepseek-v4-1-flash-260910' }).response_model).toBe('deepseek-v4-flash')
  expect(responseDiagnostics({ model: '/private/untrusted-model' }).response_model).toBe('unexpected')
})
