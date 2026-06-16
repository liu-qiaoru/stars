import { Module } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { ConfigModule } from '../config/config.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE, PG_POOL } from './database.tokens.js'
import * as schema from './schema.js'
import { DatabaseSchemaGuardService } from './schema-guard.service.js'

export { DATABASE, PG_POOL } from './database.tokens.js'

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [SETTINGS],
      useFactory: (settings: Settings) => new Pool({ connectionString: settings.databaseUrl }),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    DatabaseSchemaGuardService,
  ],
  exports: [PG_POOL, DATABASE],
})
export class DatabaseModule {}
