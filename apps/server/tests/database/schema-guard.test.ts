import { describe, expect, test, vi } from 'vitest'
import { DatabaseSchemaGuardService } from '../../src/database/schema-guard.service.js'

function createPoolWithTables(existingTables: Set<string>) {
  return {
    query: vi.fn(async (_sql: string, values: string[]) => {
      const tableName = values[0].replace('public.', '')
      return {
        rows: [{ table_name: existingTables.has(tableName) ? tableName : null }],
      }
    }),
  }
}

describe('DatabaseSchemaGuardService', () => {
  test('关键表都存在时启动检查通过', async () => {
    const pool = createPoolWithTables(
      new Set([
        'libraries',
        'media_files',
        'media_assets',
        'vector_refs',
        'jobs',
        'agent_runs',
        'agent_run_authorizations',
        'agent_run_steps',
        'agent_run_inputs',
        'agent_run_candidates',
        'agent_side_effects',
        'candidate_evidence',
      ]),
    )
    const service = new DatabaseSchemaGuardService(pool)

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined()
  })

  test('Agent V1 Phase A 表缺失时在启动阶段快速失败', async () => {
    const pool = createPoolWithTables(
      new Set(['libraries', 'media_files', 'media_assets', 'vector_refs', 'jobs', 'agent_runs']),
    )
    const service = new DatabaseSchemaGuardService(pool)

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'agent_run_authorizations, agent_run_steps, agent_run_inputs, agent_run_candidates, agent_side_effects',
    )
  })

  test('缺少关键表时提示先执行 Drizzle migration', async () => {
    const pool = createPoolWithTables(new Set(['jobs']))
    const service = new DatabaseSchemaGuardService(pool)

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'Database schema is missing required tables: libraries, media_files, media_assets, vector_refs, agent_runs, agent_run_authorizations, agent_run_steps, agent_run_inputs, agent_run_candidates, agent_side_effects, candidate_evidence. Run: corepack pnpm --dir apps/server db:migrate',
    )
  })
})
