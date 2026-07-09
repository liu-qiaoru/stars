import { z } from 'zod'

export interface Settings {
  serverHost: string
  serverPort: number
  databaseUrl: string
  qdrantUrl: string
  modelServiceUrl: string
  modelServiceTimeoutMs: number
  allowExternalLlm: boolean
  anthropicApiKey?: string
  agentModel: string
  agentMaxSteps: number
  agentToolTimeoutMs: number
  jobCoordinatorEnabled: boolean
  jobCoordinatorIntervalMs: number
  jobCoordinatorEmbeddingLimit: number
  jobCoordinatorOcrLimit: number
  queryExpansionProvider: 'none' | 'deepseek'
  queryExpansionTimeoutMs: number
  deepseekBaseUrl: string
  deepseekApiKey?: string
  deepseekModel: string
  captionIndexingEnabled: boolean
  captionSearchEnabled: boolean
  localVlmEnabled: boolean
  localVlmServiceUrl: string
  searchRerankMode: 'off' | 'blocking'
  searchRerankTopK: number
  searchRerankTimeoutMs: number
  frameCacheEnabled: boolean
  frameCacheMaxBytes: number
  frameCacheImageMaxWidth: number
}

type Env = Record<string, string | undefined>

export const SETTINGS = Symbol('SETTINGS')

// Settings 是运行时配置的唯一解析入口。这里把 env 的字符串形态转成强类型，
// 避免各个 service 自己读取 process.env 造成默认值、校验规则和测试行为分散。
const settingsSchema = z.object({
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z
    .string()
    .default('4000')
    .transform((value, context) => {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SERVER_PORT must be a valid port',
        })
        return z.NEVER
      }
      return port
    }),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  QDRANT_URL: z.string().url('QDRANT_URL must be a valid URL'),
  MODEL_SERVICE_URL: z
    .string()
    .url('MODEL_SERVICE_URL must be a valid URL')
    .default('http://127.0.0.1:4020'),
  MODEL_SERVICE_TIMEOUT_MS: z
    .string()
    .default('10000')
    .transform((value, context) => {
      const timeout = Number(value)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MODEL_SERVICE_TIMEOUT_MS must be between 1000 and 120000',
        })
        return z.NEVER
      }
      return timeout
    }),
  ALLOW_EXTERNAL_LLM: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default('disabled'),
  AGENT_MAX_STEPS: z
    .string()
    .default('4')
    .transform((value, context) => {
      const steps = Number(value)
      if (!Number.isInteger(steps) || steps < 1 || steps > 10) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AGENT_MAX_STEPS must be an integer between 1 and 10',
        })
        return z.NEVER
      }
      return steps
    }),
  AGENT_TOOL_TIMEOUT_MS: z
    .string()
    .default('10000')
    .transform((value, context) => {
      const timeout = Number(value)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AGENT_TOOL_TIMEOUT_MS must be between 1000 and 120000',
        })
        return z.NEVER
      }
      return timeout
    }),
  JOB_COORDINATOR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  JOB_COORDINATOR_INTERVAL_MS: z
    .string()
    .default('5000')
    .transform((value, context) => {
      const interval = Number(value)
      if (!Number.isInteger(interval) || interval < 1000 || interval > 3600000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JOB_COORDINATOR_INTERVAL_MS must be between 1000 and 3600000',
        })
        return z.NEVER
      }
      return interval
    }),
  JOB_COORDINATOR_EMBEDDING_LIMIT: z
    .string()
    .default('100')
    .transform((value, context) => {
      const limit = Number(value)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JOB_COORDINATOR_EMBEDDING_LIMIT must be between 1 and 10000',
        })
        return z.NEVER
      }
      return limit
    }),
  JOB_COORDINATOR_OCR_LIMIT: z
    .string()
    .default('500')
    .transform((value, context) => {
      const limit = Number(value)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JOB_COORDINATOR_OCR_LIMIT must be between 1 and 10000',
        })
        return z.NEVER
      }
      return limit
    }),
  QUERY_EXPANSION_PROVIDER: z.enum(['none', 'deepseek']).default('none'),
  QUERY_EXPANSION_TIMEOUT_MS: z
    .string()
    .default('10000')
    .transform((value, context) => {
      const timeout = Number(value)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUERY_EXPANSION_TIMEOUT_MS must be between 1000 and 120000',
        })
        return z.NEVER
      }
      return timeout
    }),
  DEEPSEEK_BASE_URL: z.string().url('DEEPSEEK_BASE_URL must be a valid URL').default('https://api.deepseek.com'),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-v4-flash'),
  CAPTION_INDEXING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CAPTION_SEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOCAL_VLM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOCAL_VLM_SERVICE_URL: z
    .string()
    .url('LOCAL_VLM_SERVICE_URL must be a valid URL')
    .default('http://127.0.0.1:4030'),
  SEARCH_RERANK_MODE: z.enum(['off', 'blocking']).default('off'),
  SEARCH_RERANK_TOP_K: z
    .string()
    .default('10')
    .transform((value, context) => {
      const topK = Number(value)
      if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SEARCH_RERANK_TOP_K must be between 1 and 50',
        })
        return z.NEVER
      }
      return topK
    }),
  SEARCH_RERANK_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform((value, context) => {
      const timeout = Number(value)
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SEARCH_RERANK_TIMEOUT_MS must be between 1000 and 120000',
        })
        return z.NEVER
      }
      return timeout
    }),
  FRAME_CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  FRAME_CACHE_MAX_BYTES: z
    .string()
    .default('1073741824')
    .transform((value, context) => {
      const maxBytes = Number(value)
      if (!Number.isInteger(maxBytes) || maxBytes < 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FRAME_CACHE_MAX_BYTES must be a non-negative integer',
        })
        return z.NEVER
      }
      return maxBytes
    }),
  FRAME_CACHE_IMAGE_MAX_WIDTH: z
    .string()
    .default('512')
    .transform((value, context) => {
      const maxWidth = Number(value)
      if (!Number.isInteger(maxWidth) || maxWidth < 64 || maxWidth > 4096) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FRAME_CACHE_IMAGE_MAX_WIDTH must be between 64 and 4096',
        })
        return z.NEVER
      }
      return maxWidth
    }),
})

export function createSettings(env: Env = process.env): Settings {
  const parsed = settingsSchema.parse(env)

  return {
    serverHost: parsed.SERVER_HOST,
    serverPort: parsed.SERVER_PORT,
    databaseUrl: parsed.DATABASE_URL,
    qdrantUrl: parsed.QDRANT_URL,
    modelServiceUrl: parsed.MODEL_SERVICE_URL,
    modelServiceTimeoutMs: parsed.MODEL_SERVICE_TIMEOUT_MS,
    allowExternalLlm: parsed.ALLOW_EXTERNAL_LLM,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    agentModel: parsed.AGENT_MODEL,
    agentMaxSteps: parsed.AGENT_MAX_STEPS,
    agentToolTimeoutMs: parsed.AGENT_TOOL_TIMEOUT_MS,
    jobCoordinatorEnabled: parsed.JOB_COORDINATOR_ENABLED,
    jobCoordinatorIntervalMs: parsed.JOB_COORDINATOR_INTERVAL_MS,
    jobCoordinatorEmbeddingLimit: parsed.JOB_COORDINATOR_EMBEDDING_LIMIT,
    jobCoordinatorOcrLimit: parsed.JOB_COORDINATOR_OCR_LIMIT,
    queryExpansionProvider: parsed.QUERY_EXPANSION_PROVIDER,
    queryExpansionTimeoutMs: parsed.QUERY_EXPANSION_TIMEOUT_MS,
    deepseekBaseUrl: parsed.DEEPSEEK_BASE_URL,
    deepseekApiKey: parsed.DEEPSEEK_API_KEY,
    deepseekModel: parsed.DEEPSEEK_MODEL,
    captionIndexingEnabled: parsed.CAPTION_INDEXING_ENABLED,
    captionSearchEnabled: parsed.CAPTION_SEARCH_ENABLED,
    localVlmEnabled: parsed.LOCAL_VLM_ENABLED,
    localVlmServiceUrl: parsed.LOCAL_VLM_SERVICE_URL,
    searchRerankMode: parsed.SEARCH_RERANK_MODE,
    searchRerankTopK: parsed.SEARCH_RERANK_TOP_K,
    searchRerankTimeoutMs: parsed.SEARCH_RERANK_TIMEOUT_MS,
    frameCacheEnabled: parsed.FRAME_CACHE_ENABLED,
    frameCacheMaxBytes: parsed.FRAME_CACHE_MAX_BYTES,
    frameCacheImageMaxWidth: parsed.FRAME_CACHE_IMAGE_MAX_WIDTH,
  }
}
