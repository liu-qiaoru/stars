import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

type Env = Record<string, string | undefined>

export interface LocalResetTarget {
  databaseUrl: string
  databaseLabel: string
  qdrantUrl: string
  appHomePath: string
  derivedCachePath: string
}

export interface LocalResetInventory {
  sourceMediaPaths: string[]
  qdrantCollections: string[]
  protectedQdrantCollections: string[]
}

export type LocalResetMode = 'dry-run' | 'confirmed-reset'

export interface LocalResetOperations {
  resetPostgres: () => Promise<unknown>
  deleteQdrantCollection: (name: string) => Promise<unknown>
  deleteDerivedCache: () => Promise<unknown>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1'])

/**
 * Parses and validates the reset target before the script opens a database connection.
 * A URL (Uniform Resource Locator，统一资源定位符) identifies one network endpoint.
 * An explicit local environment plus loopback-only service URLs prevents a copied
 * production configuration from turning this developer convenience into a remote wipe.
 */
export function buildLocalResetTarget(env: Env, projectRoot: string): LocalResetTarget {
  if (env.MEDIA_AGENT_ENV !== 'local') {
    throw new Error('MEDIA_AGENT_ENV must be exactly "local" before local data can be reset')
  }

  const databaseUrl = parseRequiredUrl(env.DATABASE_URL, 'DATABASE_URL')
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol')
  }
  assertLoopback(databaseUrl, 'DATABASE_URL')

  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, ''))
  if (!databaseName) {
    throw new Error('DATABASE_URL must include a non-empty database name')
  }
  if (SYSTEM_DATABASES.has(databaseName)) {
    throw new Error(`Refusing to reset PostgreSQL system database "${databaseName}"`)
  }

  const qdrantUrl = parseRequiredUrl(env.QDRANT_URL, 'QDRANT_URL')
  if (!['http:', 'https:'].includes(qdrantUrl.protocol)) {
    throw new Error('QDRANT_URL must use HTTP or HTTPS')
  }
  assertLoopback(qdrantUrl, 'QDRANT_URL')

  const appHomePath = resolveConfiguredPath(env.MEDIA_AGENT_HOME ?? '.media-agent', projectRoot)
  const derivedCachePath = resolveConfiguredPath(
    env.MEDIA_AGENT_CACHE_DIR ?? '.media-agent/cache',
    projectRoot,
  )

  return {
    databaseUrl: databaseUrl.toString(),
    // The password must never be printed in a dry-run or copied into an issue report.
    databaseLabel: `${databaseUrl.hostname}:${databaseUrl.port || '5432'}/${databaseName}`,
    qdrantUrl: qdrantUrl.toString(),
    appHomePath,
    derivedCachePath,
  }
}

/**
 * Ensures the only writable filesystem target is a derived cache owned by this app.
 * Both parent/child overlap directions are rejected because deleting either one could
 * remove a registered source library or files below it.
 */
export function validateDerivedCachePath(input: {
  appHomePath: string
  derivedCachePath: string
  sourceMediaPaths: string[]
}): void {
  const appHomePath = resolve(input.appHomePath)
  const derivedCachePath = resolve(input.derivedCachePath)

  if (derivedCachePath === appHomePath || !isPathInside(derivedCachePath, appHomePath)) {
    throw new Error('MEDIA_AGENT_CACHE_DIR must be inside MEDIA_AGENT_HOME, not the home itself')
  }

  for (const sourcePath of input.sourceMediaPaths) {
    const resolvedSourcePath = resolve(sourcePath)
    if (
      resolvedSourcePath === derivedCachePath ||
      isPathInside(resolvedSourcePath, derivedCachePath) ||
      isPathInside(derivedCachePath, resolvedSourcePath)
    ) {
      throw new Error(
        `Derived cache path overlaps source media and cannot be deleted: ${resolvedSourcePath}`,
      )
    }
  }
}

/**
 * Refuses symbolic links at the app-home/cache boundary. Without this check a path
 * can look repository-local while resolving to unrelated storage at deletion time.
 */
export async function assertNoSymlinkDeletionTarget(
  appHomePath: string,
  derivedCachePath: string,
): Promise<void> {
  const relativeCachePath = relative(appHomePath, derivedCachePath)
  const pathsToCheck = [
    appHomePath,
    ...relativeCachePath
      .split(/[\\/]+/u)
      .filter(Boolean)
      .map((_, index, parts) => join(appHomePath, ...parts.slice(0, index + 1))),
  ]

  for (const pathToCheck of pathsToCheck) {
    try {
      const stats = await lstat(pathToCheck)
      if (stats.isSymbolicLink()) {
        throw new Error(`Deletion target contains a symbolic link: ${pathToCheck}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A missing component means every deeper component is also absent, so rm --force
        // has nothing to delete and no link can redirect the operation.
        return
      }
      throw error
    }
  }
}

/**
 * Resolves existing filesystem paths before comparing them. This protects a source
 * library whose configured path is a symbolic link into the derived cache; lexical
 * comparison alone cannot see that relationship.
 */
export async function validateRealPathSeparation(input: {
  derivedCachePath: string
  sourceMediaPaths: string[]
}): Promise<void> {
  let realCachePath: string
  try {
    realCachePath = await realpath(input.derivedCachePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  for (const sourcePath of input.sourceMediaPaths) {
    let realSourcePath: string
    try {
      realSourcePath = await realpath(sourcePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }

    if (
      realSourcePath === realCachePath ||
      isPathInside(realSourcePath, realCachePath) ||
      isPathInside(realCachePath, realSourcePath)
    ) {
      throw new Error(`Derived cache real path overlaps source media: ${sourcePath}`)
    }
  }
}

/**
 * Separates this project's known vector collections from unrelated collections on a
 * shared local Qdrant endpoint. Unknown collections are reported but never deleted.
 */
export function partitionProjectCollections(
  discoveredCollections: string[],
  projectCollections: readonly string[],
): Pick<LocalResetInventory, 'qdrantCollections' | 'protectedQdrantCollections'> {
  const projectCollectionSet = new Set(projectCollections)
  return {
    qdrantCollections: discoveredCollections.filter((name) => projectCollectionSet.has(name)),
    protectedQdrantCollections: discoveredCollections.filter(
      (name) => !projectCollectionSet.has(name),
    ),
  }
}

/**
 * Executes the already-validated deletion plan. A dry-run is the default and performs
 * no writes. PostgreSQL is cleared first, then Qdrant collections, then derived files,
 * matching the rebuild plan's explicit cross-system order.
 */
export async function executeLocalReset(
  inventory: LocalResetInventory,
  mode: LocalResetMode,
  operations: LocalResetOperations,
): Promise<void> {
  if (mode === 'dry-run') {
    return
  }

  await operations.resetPostgres()
  for (const collectionName of inventory.qdrantCollections) {
    await operations.deleteQdrantCollection(collectionName)
  }
  await operations.deleteDerivedCache()
}

function parseRequiredUrl(value: string | undefined, name: string): URL {
  if (!value?.trim()) {
    throw new Error(`${name} is required`)
  }

  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
}

function assertLoopback(url: URL, name: string): void {
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1')
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${name} must point to a loopback host (localhost, 127.0.0.1, or ::1)`)
  }
}

function resolveConfiguredPath(value: string, projectRoot: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value)
}

function isPathInside(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent)
}
