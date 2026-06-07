import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '../../src/database/schema.js'

export async function createTestDatabase() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  const migrationSql = await readFile(resolve('drizzle/0000_tense_starfox.sql'), 'utf8')
  await client.exec(migrationSql)

  return {
    db,
    close: () => client.close(),
  }
}
