import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SETTINGS } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import {
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../../src/database/repositories.js'
import { JobsController } from '../../src/jobs/jobs.controller.js'
import { JobsModule } from '../../src/jobs/jobs.module.js'
import { LibrariesController } from '../../src/libraries/libraries.controller.js'
import { LibrariesModule } from '../../src/libraries/libraries.module.js'
import { createTestDatabase } from '../database/test-db.js'

let closeDb: () => Promise<void>
let closeModule: () => Promise<void>
let librariesController: LibrariesController
let jobsController: JobsController
let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
let client: Awaited<ReturnType<typeof createTestDatabase>>['client']
const testSettings = {
  serverHost: '127.0.0.1',
  serverPort: 4000,
  databaseUrl: 'postgres://user:pass@localhost:5432/media_agent_test',
  qdrantUrl: 'http://localhost:6333',
}

beforeEach(async () => {
  const testDb = await createTestDatabase()
  db = testDb.db
  client = testDb.client
  const { close } = testDb
  closeDb = close

  const moduleRef = await Test.createTestingModule({
    imports: [JobsModule, LibrariesModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile()

  librariesController = moduleRef.get(LibrariesController)
  jobsController = moduleRef.get(JobsController)
  closeModule = () => moduleRef.close()
})

afterEach(async () => {
  await closeModule?.()
  await closeDb?.()
})

describe('libraries API', () => {
  test('创建、列表、详情、禁用和删除 library', async () => {
    const created = await librariesController.createLibrary({
      name: 'Main Media',
      root_path: '/Volumes/Media',
    })

    expect(created).toMatchObject({
      id: expect.any(String),
      name: 'Main Media',
      root_path: '/Volumes/Media',
      enabled: true,
    })

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [
        {
          id: created.id,
          name: 'Main Media',
          root_path: '/Volumes/Media',
          enabled: true,
          media_count: 0,
          indexed_count: 0,
          failed_count: 0,
        },
      ],
    })

    await expect(librariesController.getLibrary(created.id)).resolves.toMatchObject({
      id: created.id,
      root_path: '/Volumes/Media',
      enabled: true,
    })

    await expect(librariesController.disableLibrary(created.id)).resolves.toMatchObject({
      id: created.id,
      enabled: false,
    })

    await expect(librariesController.deleteLibrary(created.id)).resolves.toEqual({
      deleted: true,
    })

    await expect(librariesController.listLibraries()).resolves.toEqual({ items: [] })
  })

  test('scan endpoint 为 library 创建 queued scan_library job', async () => {
    const library = await librariesController.createLibrary({
      name: 'Main Media',
      root_path: '/Volumes/Media',
    })

    const scan = await librariesController.scanLibrary(library.id)

    expect(scan).toMatchObject({
      job_id: expect.any(String),
      status: 'queued',
    })
    await expect(jobsController.getJob(scan.job_id)).resolves.toMatchObject({
      id: scan.job_id,
      job_type: 'scan_library',
      status: 'queued',
      input: {
        library_id: library.id,
        root_path: '/Volumes/Media',
        scan_mode: 'mtime_size',
      },
    })
  })

  test('list endpoint 返回 media 计数', async () => {
    const library = await librariesController.createLibrary({
      name: 'Main Media',
      root_path: '/Volumes/Media',
    })
    await createMediaFile(db, {
      libraryId: library.id,
      path: '/Volumes/Media/video.mp4',
      relativePath: 'video.mp4',
      mediaType: 'video',
      sizeBytes: 10,
      mtimeMs: 1710000000000,
    })

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [
        {
          id: library.id,
          media_count: 1,
          indexed_count: 0,
          failed_count: 0,
        },
      ],
    })
  })

  test('历史 indexed vector ref 迁移后回填 media file 已索引状态', async () => {
    const library = await librariesController.createLibrary({
      name: 'Historical',
      root_path: '/Volumes/Historical',
    })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/Volumes/Historical/photo.jpg',
      relativePath: 'photo.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1710000000000,
    })
    const asset = await createMediaAsset(db, { fileId: file.id, assetType: 'image' })
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      modelName: 'test',
      modelVersion: 'v1',
      vectorKind: 'image_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [expect.objectContaining({ indexed_count: 0 })],
    })
    const migration = await readFile(
      resolve('drizzle/0002_backfill_indexed_media_files.sql'),
      'utf8',
    )
    await client.exec(migration)

    await expect(librariesController.listLibraries()).resolves.toMatchObject({
      items: [expect.objectContaining({ indexed_count: 1 })],
    })
  })

  test('按素材库稳定分页返回 active media files', async () => {
    const library = await librariesController.createLibrary({
      name: 'Browse',
      root_path: '/Volumes/Browse',
    })
    for (const relativePath of ['z-last.mp4', 'a-first.jpg', 'm-middle.wav']) {
      await createMediaFile(db, {
        libraryId: library.id,
        path: `/Volumes/Browse/${relativePath}`,
        relativePath,
        mediaType: relativePath.endsWith('.jpg')
          ? 'image'
          : relativePath.endsWith('.wav')
            ? 'audio'
            : 'video',
        sizeBytes: 10,
        mtimeMs: 1710000000000,
      })
    }

    await expect(librariesController.listMedia(library.id, '2', '0')).resolves.toMatchObject({
      total: 3,
      limit: 2,
      offset: 0,
      items: [
        { relative_path: 'a-first.jpg', media_type: 'image', index_status: 'pending' },
        { relative_path: 'm-middle.wav', media_type: 'audio', index_status: 'pending' },
      ],
    })
    await expect(librariesController.listMedia(library.id, '2', '2')).resolves.toMatchObject({
      total: 3,
      items: [{ relative_path: 'z-last.mp4' }],
    })
    await expect(
      librariesController.listMedia(library.id, '25', '0', 'LAST'),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ relative_path: 'z-last.mp4' }],
    })
  })

  test('素材库文件分页拒绝非法参数并对缺失 library 返回 404', async () => {
    expect(() => librariesController.listMedia('missing', '0', '0')).toThrow(BadRequestException)
    await expect(
      librariesController.listMedia('11111111-1111-4111-8111-111111111111', '25', '0'),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
