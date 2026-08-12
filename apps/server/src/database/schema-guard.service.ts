import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { PG_POOL } from './database.tokens.js'

const REQUIRED_TABLES = [
  'libraries',
  'media_files',
  'media_assets',
  'vector_refs',
  'jobs',
  'agent_runs',
  // Agent V1 不能只看到旧 agent_runs 就认为可恢复。步骤、授权、幂等输入、
  // 冻结候选和副作用唯一键都是 Phase A 必需事实，缺任一表必须在启动时快速失败。
  'agent_run_authorizations',
  'agent_run_steps',
  'agent_run_inputs',
  'agent_run_candidates',
  'agent_side_effects',
  // Phase D 页面和 Worker 都依赖独立证据事实；缺表时禁止退化为只读 jobs.result_json。
  'candidate_evidence',
] as const

const MIGRATION_COMMAND = 'corepack pnpm --dir apps/server db:migrate'

interface SchemaQueryClient {
  query(sql: string, values: string[]): Promise<{ rows: Array<{ table_name: string | null }> }>
}

@Injectable()
export class DatabaseSchemaGuardService implements OnApplicationBootstrap {
  constructor(@Inject(PG_POOL) private readonly pool: SchemaQueryClient) {}

  async onApplicationBootstrap() {
    // 启动时尽早失败比在第一个 API 请求里报 obscure SQL 错误更友好。
    // 这里只检查关键表是否存在，不尝试自动迁移，避免服务进程隐式修改数据库。
    const missingTables: string[] = []

    for (const tableName of REQUIRED_TABLES) {
      const result = await this.pool.query('select to_regclass($1) as table_name', [
        `public.${tableName}`,
      ])
      if (!result.rows[0]?.table_name) {
        missingTables.push(tableName)
      }
    }

    if (missingTables.length) {
      throw new Error(
        `Database schema is missing required tables: ${missingTables.join(', ')}. Run: ${MIGRATION_COMMAND}`,
      )
    }
  }
}
