import { z } from 'zod'

export interface Settings {
  serverHost: string
  serverPort: number
  databaseUrl: string
  qdrantUrl: string
}

type Env = Record<string, string | undefined>

export const SETTINGS = Symbol('SETTINGS')

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
})

export function createSettings(env: Env = process.env): Settings {
  const parsed = settingsSchema.parse(env)

  return {
    serverHost: parsed.SERVER_HOST,
    serverPort: parsed.SERVER_PORT,
    databaseUrl: parsed.DATABASE_URL,
    qdrantUrl: parsed.QDRANT_URL,
  }
}
