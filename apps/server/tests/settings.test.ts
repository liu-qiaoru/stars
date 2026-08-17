import { describe, expect, test } from 'vitest'
import { createSettings } from '../src/config/settings.js'

describe('createSettings', () => {
  test('从环境变量读取服务地址和外部依赖地址', () => {
    const settings = createSettings({
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: '5001',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
      QDRANT_URL: 'http://localhost:6333',
    })

    expect(settings).toEqual({
      serverHost: '0.0.0.0',
      serverPort: 5001,
      databaseUrl: 'postgres://user:pass@localhost:5432/media_agent_test',
      qdrantUrl: 'http://localhost:6333',
      modelServiceUrl: 'http://127.0.0.1:4020',
      modelServiceTimeoutMs: 10000,
      allowExternalLlm: false,
      anthropicApiKey: undefined,
      agentModel: 'disabled',
      agentMaxSteps: 4,
      agentToolTimeoutMs: 10000,
      rightCodeBaseUrl: undefined,
      rightCodeApiKey: undefined,
      agentExecutorEnabled: false,
      agentExecutorIntervalMs: 2000,
      agentLeaseDurationMs: 130000,
      agentActivityTimeoutMs: 120000,
      agentWaitingTtlSeconds: 604800,
      agentWebPollIntervalMs: 2000,
      jobCoordinatorEnabled: true,
      jobCoordinatorIntervalMs: 5000,
      jobCoordinatorEmbeddingLimit: 100,
      queryExpansionProvider: 'none',
      queryExpansionTimeoutMs: 10000,
      queryExpansionMaxVariants: 3,
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekApiKey: undefined,
      deepseekModel: 'deepseek-v4-flash',
      shadowRerankProvider: 'disabled',
      dashscopeWorkspaceId: undefined,
      dashscopeApiKey: undefined,
      shadowRerankMaxCalls: 1,
      shadowRerankMaxCostCny: 0.5,
      agentRerankProvider: 'disabled',
      agentRerankTimeoutMs: 180000,
      vlmReviewProvider: 'disabled',
      vlmReviewMaxCalls: 84,
      vlmReviewMaxCostCny: 5,
      vlmReviewTimeoutMs: 180000,
      captionIndexingEnabled: false,
      captionSearchEnabled: false,
      localVlmEnabled: false,
      localVlmServiceUrl: 'http://127.0.0.1:4030',
      searchRerankMode: 'off',
      searchRerankTopK: 10,
      searchRerankTimeoutMs: 30000,
      frameCacheEnabled: false,
      frameCacheMaxBytes: 1073741824,
      frameCacheImageMaxWidth: 512,
    })
  })

  test('读取 DeepSeek query expansion 配置并默认关闭', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
      }),
    ).toMatchObject({
      queryExpansionProvider: 'none',
      queryExpansionTimeoutMs: 10000,
      queryExpansionMaxVariants: 3,
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekModel: 'deepseek-v4-flash',
    })

    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        QUERY_EXPANSION_PROVIDER: 'deepseek',
        QUERY_EXPANSION_TIMEOUT_MS: '2500',
        QUERY_EXPANSION_MAX_VARIANTS: '4',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_MODEL: 'deepseek-v4-flash',
      }),
    ).toMatchObject({
      queryExpansionProvider: 'deepseek',
      queryExpansionTimeoutMs: 2500,
      queryExpansionMaxVariants: 4,
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekApiKey: 'test-key',
      deepseekModel: 'deepseek-v4-flash',
    })
  })

  test('拒绝越界的 query expansion 变体上限', () => {
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        QUERY_EXPANSION_MAX_VARIANTS: '0',
      }),
    ).toThrow('QUERY_EXPANSION_MAX_VARIANTS must be between 1 and 10')
  })

  test('影子重排默认禁用且启用 DashScope 时要求完整北京地域配置', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        DASHSCOPE_API_KEY: 'present-but-not-authorized',
      }),
    ).toMatchObject({
      shadowRerankProvider: 'disabled',
      dashscopeWorkspaceId: undefined,
      dashscopeApiKey: 'present-but-not-authorized',
      shadowRerankMaxCalls: 1,
      shadowRerankMaxCostCny: 0.5,
    })

    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        SHADOW_RERANK_PROVIDER: 'dashscope',
        DASHSCOPE_API_KEY: 'test-key',
      }),
    ).toThrow('DASHSCOPE_WORKSPACE_ID is required when a DashScope rerank provider is enabled')

    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        SHADOW_RERANK_PROVIDER: 'dashscope',
        DASHSCOPE_WORKSPACE_ID: 'ws-test',
        DASHSCOPE_API_KEY: 'test-key',
      }),
    ).toMatchObject({
      shadowRerankProvider: 'dashscope',
      dashscopeWorkspaceId: 'ws-test',
      dashscopeApiKey: 'test-key',
      shadowRerankMaxCalls: 1,
      shadowRerankMaxCostCny: 0.5,
    })

    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        SHADOW_RERANK_MAX_CALLS: '5',
      }),
    ).toThrow('SHADOW_RERANK_MAX_CALLS must be between 1 and 4')
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        SHADOW_RERANK_MAX_COST_CNY: '0.5001',
      }),
    ).toThrow('SHADOW_RERANK_MAX_COST_CNY must be greater than 0 and at most 0.5')
  })

  test('产品 Rerank 独立默认关闭，超时门槛固定不超过三分钟', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        DASHSCOPE_WORKSPACE_ID: 'ws-test',
        DASHSCOPE_API_KEY: 'test-key',
      }),
    ).toMatchObject({ agentRerankProvider: 'disabled', agentRerankTimeoutMs: 180000 })

    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        AGENT_RERANK_PROVIDER: 'dashscope',
        AGENT_RERANK_TIMEOUT_MS: '90000',
        DASHSCOPE_WORKSPACE_ID: 'ws-test',
        DASHSCOPE_API_KEY: 'test-key',
      }),
    ).toMatchObject({ agentRerankProvider: 'dashscope', agentRerankTimeoutMs: 90000 })

    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        AGENT_RERANK_TIMEOUT_MS: '180001',
      }),
    ).toThrow('AGENT_RERANK_TIMEOUT_MS must be between 1000 and 180000')
  })

  test('读取 Agent 外部模型配置并保留默认关闭', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        MODEL_SERVICE_URL: 'http://127.0.0.1:5005',
        MODEL_SERVICE_TIMEOUT_MS: '2500',
      }),
    ).toMatchObject({
      modelServiceUrl: 'http://127.0.0.1:5005',
      modelServiceTimeoutMs: 2500,
      allowExternalLlm: false,
      agentModel: 'disabled',
      agentMaxSteps: 4,
      agentToolTimeoutMs: 10000,
      rightCodeBaseUrl: undefined,
      rightCodeApiKey: undefined,
      agentExecutorEnabled: false,
      agentExecutorIntervalMs: 2000,
      agentLeaseDurationMs: 130000,
      agentActivityTimeoutMs: 120000,
      agentWaitingTtlSeconds: 604800,
      agentWebPollIntervalMs: 2000,
    })

    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        ALLOW_EXTERNAL_LLM: 'true',
        ANTHROPIC_API_KEY: 'test-key',
        AGENT_MODEL: 'qwen3.7-plus',
        AGENT_MAX_STEPS: '3',
        AGENT_TOOL_TIMEOUT_MS: '2500',
        RIGHT_CODE_BASE_URL: 'https://right.example.test',
        RIGHT_CODE_API_KEY: 'right-test-key',
        AGENT_EXECUTOR_ENABLED: 'true',
        AGENT_EXECUTOR_INTERVAL_MS: '2500',
        AGENT_LEASE_DURATION_MS: '150000',
        AGENT_ACTIVITY_TIMEOUT_MS: '90000',
        AGENT_WAITING_TTL_SECONDS: '86400',
        AGENT_WEB_POLL_INTERVAL_MS: '2500',
      }),
    ).toMatchObject({
      allowExternalLlm: true,
      anthropicApiKey: 'test-key',
      agentModel: 'qwen3.7-plus',
      agentMaxSteps: 3,
      agentToolTimeoutMs: 2500,
      rightCodeBaseUrl: 'https://right.example.test',
      rightCodeApiKey: 'right-test-key',
      agentExecutorEnabled: true,
      agentExecutorIntervalMs: 2500,
      agentLeaseDurationMs: 150000,
      agentActivityTimeoutMs: 90000,
      agentWaitingTtlSeconds: 86400,
      agentWebPollIntervalMs: 2500,
    })
  })

  test('真实 VLM 视觉 Provider 独立默认关闭并限制 84 次与 5 元预算', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        RIGHT_CODE_BASE_URL: 'https://provider.example/v1',
        RIGHT_CODE_API_KEY: 'configured-but-not-authorized',
      }),
    ).toMatchObject({
      vlmReviewProvider: 'disabled',
      vlmReviewMaxCalls: 84,
      vlmReviewMaxCostCny: 5,
    })
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        VLM_REVIEW_PROVIDER: 'rightapi',
      }),
    ).toThrow(/RIGHT_CODE_BASE_URL and RIGHT_CODE_API_KEY/)
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        VLM_REVIEW_MAX_CALLS: '85',
      }),
    ).toThrow('VLM_REVIEW_MAX_CALLS must be between 1 and 84')
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        VLM_REVIEW_TIMEOUT_MS: '180000',
      }),
    ).toMatchObject({ vlmReviewTimeoutMs: 180000 })
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        VLM_REVIEW_TIMEOUT_MS: '180001',
      }),
    ).toThrow('VLM_REVIEW_TIMEOUT_MS must be between 1000 and 180000')
  })

  test('端口不是数字时抛出明确错误', () => {
    expect(() =>
      createSettings({
        SERVER_PORT: 'not-a-number',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
      }),
    ).toThrow('SERVER_PORT must be a valid port')
  })

  test('Agent 租约必须覆盖最长硬超时和 5 秒提交余量', () => {
    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        AGENT_LEASE_DURATION_MS: '124999',
        AGENT_ACTIVITY_TIMEOUT_MS: '120000',
      }),
    ).toThrow(
      'AGENT_LEASE_DURATION_MS must be at least max(AGENT_ACTIVITY_TIMEOUT_MS, AGENT_TOOL_TIMEOUT_MS) + 5000',
    )

    expect(() =>
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        AGENT_TOOL_TIMEOUT_MS: '120000',
        AGENT_ACTIVITY_TIMEOUT_MS: '100000',
        AGENT_LEASE_DURATION_MS: '124999',
      }),
    ).toThrow('AGENT_LEASE_DURATION_MS must be at least')
  })
})
