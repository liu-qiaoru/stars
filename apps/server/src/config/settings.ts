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
  }
}
