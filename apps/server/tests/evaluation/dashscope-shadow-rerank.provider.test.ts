import { describe, expect, test, vi } from 'vitest'
import {
  createShadowRerankProvider,
  DashScopeShadowRerankProvider,
} from '../../src/evaluation/dashscope-shadow-rerank.provider.js'
import type { ShadowRerankRequest } from '../../src/evaluation/shadow-rerank.provider.js'
import { ShadowRerankProviderResponseError } from '../../src/evaluation/shadow-rerank.provider.js'

const request: ShadowRerankRequest = {
  model: 'qwen3-vl-rerank',
  query: '穿红色外套的人走过雪地',
  top_n: 10,
  documents: Array.from({ length: 20 }, (_, index) => ({
    index,
    candidate_key: `private-candidate-${index}`,
    evidence_sha256: `${index.toString(16).padStart(2, '0')}${'a'.repeat(62)}`,
    image_base64: Buffer.from(`png-${index}`).toString('base64'),
  })),
}

describe('DashScopeShadowRerankProvider', () => {
  test('只有显式选择 DashScope 才返回可调用 Provider', () => {
    expect(
      createShadowRerankProvider({
        shadowRerankProvider: 'disabled',
        dashscopeWorkspaceId: 'ws-present',
        dashscopeApiKey: 'key-present',
      }).available,
    ).toBe(false)

    expect(
      createShadowRerankProvider({
        shadowRerankProvider: 'dashscope',
        dashscopeWorkspaceId: 'ws-test',
        dashscopeApiKey: 'key-test',
      }).available,
    ).toBe(true)
  })

  test('imageMime 参数决定 data URL 前缀，缺省保持 image/png 协议冻结', async () => {
    // 产品 Rerank 传 image/jpeg 以缩小请求体；评测路径不传，继续发 PNG，
    // 与 2026-08 之前的历史评测记录保持同一输入条件。
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output: {
              results: Array.from({ length: 10 }, (_, index) => ({
                index,
                relevance_score: 1 - index / 10,
              })),
            },
            usage: { total_tokens: 1 },
            request_id: 'dashscope-jpeg-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const provider = new DashScopeShadowRerankProvider(
      { workspaceId: 'ws-test', apiKey: 'secret-test-key', imageMime: 'image/jpeg' },
      fetchFn,
    )
    await provider.rerank(request, new AbortController().signal)
    const [, init] = fetchFn.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(body.input.documents[0].image).toMatch(/^data:image\/jpeg;base64,/)
    expect(provider.requestBytes(request)).toBe(Buffer.byteLength(String(init?.body), 'utf8'))
  })

  test('把冻结 Top-20 映射为官方北京专属接口且不外发本地审计身份', async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output: {
              results: Array.from({ length: 10 }, (_, index) => ({
                index,
                relevance_score: 1 - index / 10,
              })),
            },
            usage: { total_tokens: 321 },
            request_id: 'dashscope-request-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const provider = new DashScopeShadowRerankProvider(
      {
        workspaceId: 'ws-test',
        apiKey: 'secret-test-key',
      },
      fetchFn,
    )

    const result = await provider.rerank(request, new AbortController().signal)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(
      'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
    )
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-test-key',
        'content-type': 'application/json',
      },
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      model: 'qwen3-vl-rerank',
      input: {
        query: { text: request.query },
        documents: request.documents.map((document) => ({
          image: `data:image/png;base64,${document.image_base64}`,
        })),
      },
      parameters: { return_documents: false, top_n: 10 },
    })
    expect(JSON.stringify(body)).not.toContain('private-candidate')
    expect(JSON.stringify(body)).not.toContain('evidence_sha256')
    expect(provider.requestBytes(request)).toBe(Buffer.byteLength(String(init?.body), 'utf8'))
    expect(result).toEqual({
      response: {
        results: Array.from({ length: 10 }, (_, index) => ({
          index,
          relevance_score: 1 - index / 10,
        })),
      },
      providerRequestId: 'dashscope-request-1',
      responseModel: null,
      modelSnapshot: null,
      region: 'cn-beijing',
      inputTokens: null,
      outputTokens: null,
      totalTokens: 321,
      billedCostCny: null,
    })
  })

  test('忽略供应商新增的无害字段并只提取冻结的排名与用量事实', async () => {
    const provider = new DashScopeShadowRerankProvider(
      { workspaceId: 'ws-test', apiKey: 'secret-test-key' },
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: {
                results: Array.from({ length: 10 }, (_, index) => ({
                  index,
                  relevance_score: 1 - index / 10,
                  // DashScope 扩展字段不能改变 index/score 的冻结含义，也不能进入内部响应。
                  document: { image: 'must-not-enter-the-result' },
                })),
                provider_trace: 'ignored-output-field',
              },
              usage: { total_tokens: 25_640, image_tokens: 24_440, text_tokens: 1_200 },
              request_id: 'dashscope-extended-1',
              code: '',
              message: '',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    await expect(provider.rerank(request, new AbortController().signal)).resolves.toEqual({
      response: {
        results: Array.from({ length: 10 }, (_, index) => ({
          index,
          relevance_score: 1 - index / 10,
        })),
      },
      providerRequestId: 'dashscope-extended-1',
      responseModel: null,
      modelSnapshot: null,
      region: 'cn-beijing',
      inputTokens: null,
      outputTokens: null,
      totalTokens: 25_640,
      billedCostCny: null,
    })
  })

  test('排名核心合法但 Provider 用量缺失时保留 Top-10 并把 totalTokens 记为未知', async () => {
    const provider = new DashScopeShadowRerankProvider(
      { workspaceId: 'ws-test', apiKey: 'secret-test-key' },
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: {
                results: Array.from({ length: 10 }, (_, index) => ({
                  index,
                  relevance_score: 1 - index / 10,
                })),
              },
              request_id: 'dashscope-usage-missing-1',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const result = await provider.rerank(request, new AbortController().signal)

    expect(result.response).toEqual({
      results: Array.from({ length: 10 }, (_, index) => ({
        index,
        relevance_score: 1 - index / 10,
      })),
    })
    expect(result.totalTokens).toBeNull()
  })

  test('把明确的 HTTP 拒绝标记为已收到响应而不是网络结果未知', async () => {
    const provider = new DashScopeShadowRerankProvider(
      { workspaceId: 'ws-test', apiKey: 'secret-test-key' },
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'Arrearage',
              message: 'sensitive provider detail must never enter API logs',
              request_id: 'dashscope-rejected-1',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const caught = await provider
      .rerank(request, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(ShadowRerankProviderResponseError)
    expect(caught).toMatchObject({
      code: 'SHADOW_PROVIDER_HTTP_ERROR',
      httpStatus: 400,
      providerCode: 'Arrearage',
      providerRequestId: 'dashscope-rejected-1',
      region: 'cn-beijing',
    })
    expect((caught as Error).message).not.toContain('sensitive provider detail')
  })

  test('把 HTTP 200 的畸形协议标记为明确失败并保留请求 ID', async () => {
    const provider = new DashScopeShadowRerankProvider(
      { workspaceId: 'ws-test', apiKey: 'secret-test-key' },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ output: {}, request_id: 'dashscope-malformed-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    const caught = await provider
      .rerank(request, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(caught).toMatchObject({
      code: 'SHADOW_PROVIDER_RESPONSE_INVALID',
      httpStatus: 200,
      providerCode: null,
      providerRequestId: 'dashscope-malformed-1',
      region: 'cn-beijing',
      schemaIssues: [{ path: 'output.results', code: 'invalid_type' }],
    })
    expect(
      JSON.stringify((caught as ShadowRerankProviderResponseError).schemaIssues),
    ).not.toContain('dashscope-malformed-1')
  })
})
