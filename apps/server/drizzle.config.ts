import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { defineConfig } from 'drizzle-kit'

const envFilePath = ['.env', '../../.env'].find((path) => existsSync(path))

if (envFilePath) {
  loadEnvFile(envFilePath)
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/local_media_agent',
  },
})
