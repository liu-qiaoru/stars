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
      jobCoordinatorEnabled: true,
      jobCoordinatorIntervalMs: 5000,
      jobCoordinatorEmbeddingLimit: 100,
      jobCoordinatorOcrLimit: 500,
      queryExpansionProvider: 'none',
      queryExpansionTimeoutMs: 10000,
      queryExpansionMaxVariants: 3,
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekApiKey: undefined,
      deepseekModel: 'deepseek-v4-flash',
      captionIndexingEnabled: false,
      captionSearchEnabled: false,
      videoSegmentSearchEnabled: true,
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

  test('video segment search migration switch defaults on and can be disabled', () => {
    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
      }),
    ).toMatchObject({ videoSegmentSearchEnabled: true })

    expect(
      createSettings({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/media_agent_test',
        QDRANT_URL: 'http://localhost:6333',
        VIDEO_SEGMENT_SEARCH_ENABLED: 'false',
      }),
    ).toMatchObject({ videoSegmentSearchEnabled: false })
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
      }),
    ).toMatchObject({
      allowExternalLlm: true,
      anthropicApiKey: 'test-key',
      agentModel: 'qwen3.7-plus',
      agentMaxSteps: 3,
      agentToolTimeoutMs: 2500,
    })
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
})
