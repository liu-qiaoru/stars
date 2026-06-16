import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { PG_POOL } from './database.tokens.js'

const REQUIRED_TABLES = [
  'libraries',
  'media_files',
  'media_assets',
  'vector_refs',
  'jobs',
  'agent_runs',
] as const

const MIGRATION_COMMAND = 'corepack pnpm --dir apps/server db:migrate'

interface SchemaQueryClient {
  query(sql: string, values: string[]): Promise<{ rows: Array<{ table_name: string | null }> }>
}

@Injectable()
export class DatabaseSchemaGuardService implements OnApplicationBootstrap {
  constructor(@Inject(PG_POOL) private readonly pool: SchemaQueryClient) {}

  async onApplicationBootstrap() {
    const missingTables: string[] = []

    for (const tableName of REQUIRED_TABLES) {
      const result = await this.pool.query(
        'select to_regclass($1) as table_name',
        [`public.${tableName}`],
      )
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
