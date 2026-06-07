import { Module } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { ConfigModule } from '../config/config.module.js'
import { SETTINGS, type Settings } from '../config/settings.js'
import * as schema from './schema.js'

export const PG_POOL = Symbol('PG_POOL')
export const DATABASE = Symbol('DATABASE')

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
  ],
  exports: [PG_POOL, DATABASE],
})
export class DatabaseModule {}
