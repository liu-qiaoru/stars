import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import {
  assertNoSymlinkDeletionTarget,
  buildLocalResetTarget,
  executeLocalReset,
  validateDerivedCachePath,
  type LocalResetInventory,
} from '../../src/tools/local-data-reset.js'

const localEnv = {
  MEDIA_AGENT_ENV: 'local',
  DATABASE_URL: 'postgres://media_agent:secret@127.0.0.1:5432/media_agent',
  QDRANT_URL: 'http://localhost:6333',
  MEDIA_AGENT_HOME: '.media-agent',
  MEDIA_AGENT_CACHE_DIR: '.media-agent/cache',
}

describe('local data reset safety boundary', () => {
  test('accepts only an explicitly local environment and hides database credentials', () => {
    const target = buildLocalResetTarget(localEnv, '/repo')

    expect(target.databaseLabel).toBe('127.0.0.1:5432/media_agent')
    expect(target.databaseLabel).not.toContain('secret')
    expect(target.qdrantUrl).toBe('http://localhost:6333/')
    expect(target.derivedCachePath).toBe('/repo/.media-agent/cache')
  })

  test.each([
    [{ ...localEnv, MEDIA_AGENT_ENV: 'production' }, 'MEDIA_AGENT_ENV'],
    [{ ...localEnv, DATABASE_URL: 'postgres://user:pass@db.example.com/media_agent' }, 'loopback'],
    [{ ...localEnv, DATABASE_URL: 'postgres://user:pass@localhost/' }, 'database name'],
    [{ ...localEnv, DATABASE_URL: 'postgres://user:pass@localhost/postgres' }, 'system database'],
    [{ ...localEnv, QDRANT_URL: 'https://qdrant.example.com' }, 'loopback'],
  ])('rejects an unsafe target before inventory or deletion', (env, message) => {
    expect(() => buildLocalResetTarget(env, '/repo')).toThrow(message)
  })

  test('rejects cache paths outside the configured app home or overlapping source media', () => {
    expect(() =>
      validateDerivedCachePath({
        appHomePath: '/repo/.media-agent',
        derivedCachePath: '/tmp/cache',
        sourceMediaPaths: ['/media/library'],
      }),
    ).toThrow('inside MEDIA_AGENT_HOME')

    expect(() =>
      validateDerivedCachePath({
        appHomePath: '/media',
        derivedCachePath: '/media/library',
        sourceMediaPaths: ['/media/library'],
      }),
    ).toThrow('overlaps source media')
  })

  test('rejects a derived-cache path that reaches storage through a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-agent-reset-'))
    const realHome = join(root, 'real-home')
    const linkedHome = join(root, '.media-agent')
    await mkdir(realHome)
    await symlink(realHome, linkedHome)

    await expect(
      assertNoSymlinkDeletionTarget(linkedHome, join(linkedHome, 'cache')),
    ).rejects.toThrow('symbolic link')
  })

  test('dry-run performs no deletion', async () => {
    const inventory: LocalResetInventory = {
      sourceMediaPaths: ['/media/library'],
      qdrantCollections: ['image_vectors', 'video_frame_vectors'],
    }
    const operations = {
      resetPostgres: vi.fn(),
      deleteQdrantCollection: vi.fn(),
      deleteDerivedCache: vi.fn(),
    }

    await executeLocalReset(inventory, false, operations)

    expect(operations.resetPostgres).not.toHaveBeenCalled()
    expect(operations.deleteQdrantCollection).not.toHaveBeenCalled()
    expect(operations.deleteDerivedCache).not.toHaveBeenCalled()
  })

  test('confirmed reset preserves the required cross-system deletion order', async () => {
    const calls: string[] = []
    const inventory: LocalResetInventory = {
      sourceMediaPaths: ['/media/library'],
      qdrantCollections: ['image_vectors', 'caption_text_vectors'],
    }

    await executeLocalReset(inventory, true, {
      resetPostgres: async () => calls.push('postgres'),
      deleteQdrantCollection: async (name) => calls.push(`qdrant:${name}`),
      deleteDerivedCache: async () => calls.push('cache'),
    })

    expect(calls).toEqual([
      'postgres',
      'qdrant:image_vectors',
      'qdrant:caption_text_vectors',
      'cache',
    ])
  })
})
