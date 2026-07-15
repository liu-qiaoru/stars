import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { loadEnvFile } from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import {
  assertNoSymlinkDeletionTarget,
  buildLocalResetTarget,
  executeLocalReset,
  validateDerivedCachePath,
  type LocalResetInventory,
} from './local-data-reset.js'
import { findFirstExistingPath } from '../env-file.js'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const envFilePath = findFirstExistingPath([`${projectRoot}.env`, '.env', '../../.env'])

if (envFilePath) {
  // This command runs from apps/server under pnpm, but all processes share the root .env.
  loadEnvFile(envFilePath)
}

const confirmed = process.argv.slice(2).includes('--confirm-reset-local-data')

try {
  const target = buildLocalResetTarget(process.env, projectRoot)
  const runningServices = await findRunningBusinessServices(process.env)
  if (runningServices.length > 0) {
    throw new Error(
      `Stop all business services before reset. Still detected: ${runningServices.join(', ')}`,
    )
  }

  const pool = new Pool({ connectionString: target.databaseUrl, max: 1 })
  try {
    // Source paths are read before any destructive action so filesystem guards can prove
    // that the derived-cache deletion cannot reach a registered media library.
    const sourceMediaPaths = await readSourceMediaPaths(pool)
    const qdrantCollections = await readQdrantCollections(target.qdrantUrl)
    const inventory: LocalResetInventory = { sourceMediaPaths, qdrantCollections }

    await assertNoSymlinkDeletionTarget(target.appHomePath, target.derivedCachePath)
    validateDerivedCachePath({
      appHomePath: target.appHomePath,
      derivedCachePath: target.derivedCachePath,
      sourceMediaPaths,
    })
    printResetPlan(target, inventory, confirmed)

    await executeLocalReset(inventory, confirmed, {
      resetPostgres: async () => {
        // Dropping and recreating public in one PostgreSQL transaction removes app tables,
        // evaluation data, jobs, and Drizzle migration history as a single database change.
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query('DROP SCHEMA public CASCADE')
          await client.query('CREATE SCHEMA public')
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      deleteQdrantCollection: async (collectionName) => {
        const endpoint = new URL(
          `/collections/${encodeURIComponent(collectionName)}`,
          target.qdrantUrl,
        )
        const response = await fetch(endpoint, { method: 'DELETE' })
        if (!response.ok) {
          throw new Error(
            `Qdrant failed to delete collection "${collectionName}" (HTTP ${response.status})`,
          )
        }
      },
      deleteDerivedCache: async () => {
        await rm(target.derivedCachePath, { recursive: true, force: true })
      },
    })

    console.log(
      confirmed
        ? '\nLocal index data reset completed. Source media was not modified.'
        : '\nDry-run only. No PostgreSQL, Qdrant, or filesystem data was modified.',
    )
  } finally {
    await pool.end()
  }
} catch (error) {
  console.error(`Local reset refused: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function readSourceMediaPaths(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ root_path: string }>(
    'SELECT root_path FROM libraries WHERE deleted_at IS NULL ORDER BY root_path',
  )
  return result.rows.map((row) => row.root_path)
}

async function readQdrantCollections(qdrantUrl: string): Promise<string[]> {
  const response = await fetch(new URL('/collections', qdrantUrl))
  if (!response.ok) {
    throw new Error(`Cannot inventory Qdrant collections (HTTP ${response.status})`)
  }

  const body = (await response.json()) as {
    result?: { collections?: Array<{ name?: unknown }> }
  }
  const collections = body.result?.collections
  if (!Array.isArray(collections)) {
    throw new Error('Qdrant collection inventory returned an unexpected response')
  }
  return collections
    .map((collection) => collection.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort()
}

async function findRunningBusinessServices(env: NodeJS.ProcessEnv): Promise<string[]> {
  const endpoints = [
    ['Web', Number(env.WEB_PORT ?? 3000)],
    ['Server', Number(env.SERVER_PORT ?? 4000)],
    ['model_service', Number(env.MODEL_SERVICE_PORT ?? 4020)],
    ['vlm_service', Number(env.LOCAL_VLM_SERVICE_PORT ?? 4030)],
  ] as const
  const detected: string[] = []

  for (const [name, port] of endpoints) {
    if (Number.isInteger(port) && port > 0 && port <= 65535 && (await isPortOpen(port))) {
      detected.push(`${name} (:${port})`)
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    const workerRunning = stdout.split('\n').some((line) => {
      const command = line.trim().replace(/^\d+\s+/, '')
      return /python(?:\d+(?:\.\d+)?)?.*\s-m\s+media_agent_worker(?:\s|$)/.test(command)
    })
    if (workerRunning) {
      detected.push('Python Worker')
    }
  } catch (error) {
    throw new Error(
      `Cannot verify whether the Python Worker is stopped: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return detected
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function printResetPlan(
  target: ReturnType<typeof buildLocalResetTarget>,
  inventory: LocalResetInventory,
  confirmed: boolean,
): void {
  console.log(confirmed ? 'CONFIRMED LOCAL RESET' : 'LOCAL RESET DRY-RUN')
  console.log(`PostgreSQL database to clear: ${target.databaseLabel}`)
  console.log(`Qdrant endpoint: ${target.qdrantUrl}`)
  console.log(`Qdrant collections to delete: ${inventory.qdrantCollections.join(', ') || '(none)'}`)
  console.log(`Derived cache to delete: ${target.derivedCachePath}`)
  console.log('Source media paths that will NEVER be written or deleted:')
  for (const sourcePath of inventory.sourceMediaPaths) {
    console.log(`  - ${sourcePath}`)
  }
  if (inventory.sourceMediaPaths.length === 0) {
    console.log('  - (no active libraries registered)')
  }
}
