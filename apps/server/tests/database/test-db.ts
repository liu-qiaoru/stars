import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '../../src/database/schema.js'

export async function createTestDatabase() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  const migrationDir = resolve('drizzle')
  const migrationFiles = (await readdir(migrationDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of migrationFiles) {
    await client.exec(await readFile(resolve(migrationDir, file), 'utf8'))
  }

  return {
    db,
    close: () => client.close(),
  }
}
