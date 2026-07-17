import { BadRequestException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SETTINGS, type Settings } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../../src/database/repositories.js'
import { videoScenes } from '../../src/database/schema.js'
import { ModelGatewayService } from '../../src/model-gateway/model-gateway.service.js'
import { QDRANT_CLIENT } from '../../src/qdrant/qdrant.module.js'
import { SearchModule } from '../../src/search/search.module.js'
import { SearchService } from '../../src/search/search.service.js'
import { createTestDatabase } from '../database/test-db.js'

let closeDb: () => Promise<void>
let closeModule: () => Promise<void>
let service: SearchService
let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
const search = vi.fn()
const searchPointGroups = vi.fn()
const embedText = vi.fn()
const testSettings: Settings = {
  serverHost: '127.0.0.1',
  serverPort: 4000,
  databaseUrl: 'postgres://user:pass@localhost:5432/media_agent_test',
  qdrantUrl: 'http://localhost:6333',
  modelServiceUrl: 'http://127.0.0.1:4020',
  modelServiceTimeoutMs: 10000,
  allowExternalLlm: false,
  agentModel: 'disabled',
  agentMaxSteps: 4,
  agentToolTimeoutMs: 10000,
  jobCoordinatorEnabled: true,
  jobCoordinatorIntervalMs: 5000,
  jobCoordinatorEmbeddingLimit: 100,
  queryExpansionProvider: 'none',
  queryExpansionTimeoutMs: 10000,
  queryExpansionMaxVariants: 3,
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: undefined,
  deepseekModel: 'deepseek-v4-flash',
  captionIndexingEnabled: false,
  captionSearchEnabled: false,
  localVlmEnabled: false,
  localVlmServiceUrl: 'http://127.0.0.1:4030',
  searchRerankMode: 'off',
  searchRerankTopK: 10,
  searchRerankTimeoutMs: 30000,
  frameCacheEnabled: false,
  frameCacheMaxBytes: 1073741824,
  frameCacheImageMaxWidth: 512,
}
let currentSettings: Settings = testSettings

// 阶段 2 后视频走 video_scenes 表 + scene_id 外键；Qdrant 对 video_frame_vectors 用分组检索。
async function seedVideoScene(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: { fileId: string; sceneKey?: string; start?: string; end?: string; generation?: number },
) {
  const [row] = await db
    .insert(videoScenes)
    .values({
      id: randomUUID(),
      fileId: input.fileId,
      sceneKey: input.sceneKey ?? 'scene-0001',
      startTimeSeconds: input.start ?? '0',
      endTimeSeconds: input.end ?? '30',
      detectionStrategy: 'scene_detection',
      strategyFingerprint: 'test-fingerprint',
      indexGeneration: input.generation ?? 0,
    })
    .returning()
  return row
}

async function buildModule(settings: Settings) {
  const moduleRef = await Test.createTestingModule({ imports: [SearchModule] })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(settings)
    .overrideProvider(QDRANT_CLIENT)
    .useValue({ search, searchPointGroups })
    .overrideProvider(ModelGatewayService)
    .useValue({ embedText })
    .compile()
  service = moduleRef.get(SearchService)
  closeModule = () => moduleRef.close()
}

beforeEach(async () => {
  const testDb = await createTestDatabase()
  db = testDb.db
  closeDb = testDb.close
  search.mockReset()
  searchPointGroups.mockReset()
  embedText.mockReset()
  embedText.mockResolvedValue(Array.from({ length: 768 }, (_, index) => index / 768))
  currentSettings = testSettings
  await buildModule(currentSettings)
})

afterEach(async () => {
  await closeModule?.()
  await closeDb?.()
  vi.restoreAllMocks()
})

describe('search service', () => {
  test('按 collection 搜索 image 和 video frame，视频按场景分组并回 PostgreSQL 补齐', async () => {
    const library = await createLibrary(db, { name: 'Main Media', rootPath: '/Volumes/Media' })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/Volumes/Media/cat.jpg',
      relativePath: 'cat.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1710000000000,
    })
    const imageAsset = await createMediaAsset(db, { fileId: imageFile.id, assetType: 'image' })
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/Volumes/Media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 1710000000001,
    })
    const scene = await seedVideoScene(db, { fileId: videoFile.id, start: '30', end: '60' })
    const frameAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: 'video_frame',
      sceneId: scene.id,
      frameTimeSeconds: '42',
    })
    const imagePointId = '11111111-1111-4111-8111-111111111111'
    const framePointId = '22222222-2222-4222-8222-222222222222'
    await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: imagePointId,
      modelName: 'mock',
      modelVersion: 'phase5',
      vectorKind: 'image_embedding',
      vectorDim: 512,
      distance: 'Cosine',
      contentHash: 'image-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    await createVectorRef(db, {
      assetId: frameAsset.id,
      fileId: videoFile.id,
      libraryId: library.id,
      collectionName: 'video_frame_vectors',
      pointId: framePointId,
      modelName: 'mock',
      modelVersion: 'phase5',
      vectorKind: 'frame_embedding',
      vectorDim: 512,
      distance: 'Cosine',
      contentHash: 'frame-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    search.mockImplementation(async (collectionName: string) => {
      if (collectionName === 'image_vectors') {
        return [{ id: imagePointId, score: 0.91 }]
      }
      return []
    })
    searchPointGroups.mockResolvedValue({
      groups: [{ id: scene.id, hits: [{ id: framePointId, score: 0.82 }] }],
    })

    const result = await service.search({
      query: 'cat by window',
      media_types: ['image', 'video'],
      library_ids: [library.id],
      limit: 5,
      offset: 0,
    })

    // 视频帧向量走分组检索（按 scene_id），图片走普通检索。
    expect(search).toHaveBeenCalledWith('image_vectors', expect.any(Object))
    expect(searchPointGroups).toHaveBeenCalledWith('video_frame_vectors', expect.any(Object))
    expect(result.results.map((item) => item.asset_id).sort()).toEqual(
      [imageAsset.id, frameAsset.id].sort(),
    )
    const videoResult = result.results.find((item) => item.media_type === 'video')
    expect(videoResult).toMatchObject({
      scene_id: scene.id,
      start_time_seconds: 30,
      end_time_seconds: 60,
      source_scores: { video_frame_vectors: 0.82 },
    })
  })

  test('空结果返回稳定分页结构', async () => {
    search.mockResolvedValue([])
    searchPointGroups.mockResolvedValue({ groups: [] })

    await expect(
      service.search({ query: 'nothing', media_types: ['image'], limit: 10, offset: 0 }),
    ).resolves.toEqual({
      limit: 10,
      offset: 0,
      results: [],
      groups: [
        { collection: 'image_vectors', score_kind: 'cosine_similarity', results: [] },
        { collection: 'text_search', score_kind: 'ts_rank_cd', results: [] },
      ],
    })
  })

  test('校验失败时抛出 BadRequestException', async () => {
    await expect(service.search({ query: '', limit: 10 })).rejects.toThrow(BadRequestException)
    await expect(service.search({ query: 'test', limit: 0 })).rejects.toThrow(BadRequestException)
    await expect(service.search({ query: 'test', limit: 101 })).rejects.toThrow(BadRequestException)
    await expect(service.search({ query: 'test', library_ids: ['not-a-uuid'] })).rejects.toThrow(
      BadRequestException,
    )
  })

  test('不支持向量或文本检索的 media_types 返回空 groups', async () => {
    const result = await service.search({ query: 'test', media_types: ['document'], limit: 10 })

    expect(result).toEqual({ limit: 10, offset: 0, results: [], groups: [] })
    expect(search).not.toHaveBeenCalled()
  })

  test('filters legacy video frame hits without a stable scene', async () => {
    // 视频帧缺 scene_id（旧迁移残留）必须被回表拒绝，不进入结果。
    const library = await createLibrary(db, { name: 'Video', rootPath: '/video' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/video/scene.mp4',
      relativePath: 'scene.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const frameAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'video_frame',
      frameTimeSeconds: '12',
    })
    const framePointId = '99999999-9999-4999-8999-999999999999'
    await createVectorRef(db, {
      assetId: frameAsset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'video_frame_vectors',
      pointId: framePointId,
      modelName: 'mock',
      modelVersion: 'phase5',
      vectorKind: 'frame_embedding',
      vectorDim: 512,
      distance: 'Cosine',
      contentHash: 'frame-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    searchPointGroups.mockResolvedValue({
      groups: [{ id: 'orphan-scene', hits: [{ id: framePointId, score: 0.81 }] }],
    })

    const result = await service.search({ query: 'beach', media_types: ['video'], limit: 10 })

    expect(result.results).toEqual([])
  })

  test('grouped retrieval returns one candidate per scene using the best frame', async () => {
    // 同一场景两帧命中：分组检索只返回该场景的代表（最高分）帧，作为一条候选。
    const library = await createLibrary(db, { name: 'MaxSim', rootPath: '/maxsim' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/maxsim/performance.mp4',
      relativePath: 'performance.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const scene = await seedVideoScene(db, { fileId: file.id, start: '0', end: '30' })
    const frameA = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'video_frame',
      sceneId: scene.id,
      frameTimeSeconds: '5',
    })
    const frameB = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'video_frame',
      sceneId: scene.id,
      frameTimeSeconds: '25',
    })
    const pointA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pointB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    for (const [asset, pointId, hash] of [
      [frameA, pointA, 'frame-a'],
      [frameB, pointB, 'frame-b'],
    ] as const) {
      await createVectorRef(db, {
        assetId: asset.id,
        fileId: file.id,
        libraryId: library.id,
        collectionName: 'video_frame_vectors',
        pointId,
        modelName: 'mock',
        modelVersion: 'phase5',
        vectorKind: 'frame_embedding',
        vectorDim: 512,
        distance: 'Cosine',
        contentHash: hash,
        indexProfile: 'balanced',
        status: 'indexed',
      })
    }
    // Qdrant 分组检索返回该场景一个组，代表帧是分数更高的 frameB。
    searchPointGroups.mockResolvedValue({
      groups: [{ id: scene.id, hits: [{ id: pointB, score: 0.91 }] }],
    })

    const result = await service.search({ query: 'singing', media_types: ['video'], limit: 10 })

    expect(result.results).toEqual([
      expect.objectContaining({
        asset_id: frameB.id,
        scene_id: scene.id,
        start_time_seconds: 0,
        end_time_seconds: 30,
        source_scores: { video_frame_vectors: 0.91 },
      }),
    ])
  })

  test('caption search is disabled by default', async () => {
    search.mockResolvedValue([])
    searchPointGroups.mockResolvedValue({ groups: [] })

    await service.search({ query: 'kitchen cooking', media_types: ['video'], limit: 10 })

    expect(search).not.toHaveBeenCalledWith('caption_text_vectors', expect.any(Object))
  })

  test('caption vector hits are returned as caption_match when enabled', async () => {
    currentSettings = { ...testSettings, captionSearchEnabled: true }
    await closeModule()
    await buildModule(currentSettings)

    const library = await createLibrary(db, { name: 'Video', rootPath: '/video' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/video/kitchen.mp4',
      relativePath: 'kitchen.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const scene = await seedVideoScene(db, { fileId: file.id, start: '10', end: '20' })
    // 旧 caption-v1 视频 Caption 缺 scene_id（被拒绝）；新 scene-caption-v2 引用正式 scene_id。
    const legacyCaptionAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'caption',
      startTimeSeconds: '10.1',
      endTimeSeconds: '20',
      textContent: 'Legacy single-frame caption',
      contentHash: 'legacy-caption-hash',
      metadataJson: { prompt_version: 'caption-v1', source: 'vlm_caption' },
    })
    const legacyPointId = '13131313-1313-4313-8313-131313131313'
    const captionAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'caption',
      sceneId: scene.id,
      startTimeSeconds: '10',
      endTimeSeconds: '20',
      textContent: 'A person cooks in a kitchen',
      contentHash: 'caption-hash',
      metadataJson: { prompt_version: 'scene-caption-v2', source: 'vlm_scene_caption' },
    })
    const pointId = '12121212-1212-4212-8212-121212121212'
    for (const [asset, pointId2, hash] of [
      [legacyCaptionAsset, legacyPointId, 'legacy-caption-hash'],
      [captionAsset, pointId, 'caption-hash'],
    ] as const) {
      await createVectorRef(db, {
        assetId: asset.id,
        fileId: file.id,
        libraryId: library.id,
        collectionName: 'caption_text_vectors',
        pointId: pointId2,
        modelName: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
        modelVersion: 'paraphrase-multilingual-MiniLM-L12-v2',
        vectorKind: 'vlm_caption_text_embedding',
        vectorDim: 384,
        distance: 'Cosine',
        contentHash: hash,
        indexProfile: 'balanced',
        status: 'indexed',
      })
    }
    embedText.mockResolvedValue(Array.from({ length: 384 }, (_, index) => index / 384))
    search.mockImplementation(async (collectionName: string) => {
      if (collectionName === 'caption_text_vectors') {
        return [
          { id: legacyPointId, score: 0.91 },
          { id: pointId, score: 0.86 },
        ]
      }
      return []
    })
    searchPointGroups.mockResolvedValue({ groups: [] })

    const result = await service.search({
      query: 'kitchen cooking',
      media_types: ['video'],
      limit: 10,
    })

    expect(search).toHaveBeenCalledWith('caption_text_vectors', expect.any(Object))
    // 旧 caption-v1（无 scene_id）被回表拒绝；只保留引用正式 scene_id 的 scene-caption-v2。
    expect(result.results.map((item) => item.asset_id)).toEqual([captionAsset.id])
    expect(result.results[0]).toMatchObject({
      asset_id: captionAsset.id,
      primary_reason: 'caption_match',
      scene_id: scene.id,
    })
  })

  test('audio-only search returns transcript matches from PostgreSQL FTS', async () => {
    const library = await createLibrary(db, { name: 'Interviews', rootPath: '/audio' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/audio/interview.mp3',
      relativePath: 'interview.mp3',
      mediaType: 'audio',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'text_chunk',
      startTimeSeconds: '30',
      endTimeSeconds: '55',
    })
    await db.execute(sql`
      UPDATE media_assets
      SET text_content = 'the guest describes a red bicycle near the station'
      WHERE id = ${asset.id}
    `)

    const result = await service.search({
      query: 'bicycle',
      media_types: ['audio'],
      library_ids: [library.id],
      limit: 10,
    })

    expect(result.results.map((item) => item.asset_id)).toEqual([asset.id])
    expect(result.results[0]).toMatchObject({
      asset_id: asset.id,
      primary_reason: 'transcript_match',
      reasons: ['transcript_match'],
    })
    expect(search).not.toHaveBeenCalled()
  })

  test('Qdrant 返回的 point 在 PostgreSQL 中不存在时被静默跳过', async () => {
    const library = await createLibrary(db, { name: 'Test', rootPath: '/test' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/test/img.jpg',
      relativePath: 'img.jpg',
      mediaType: 'image',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const asset = await createMediaAsset(db, { fileId: file.id, assetType: 'image' })
    const validPointId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const orphanPointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: validPointId,
      modelName: 'mock',
      modelVersion: 'phase5',
      vectorKind: 'image_embedding',
      vectorDim: 512,
      distance: 'Cosine',
      contentHash: 'hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    search.mockResolvedValue([
      { id: validPointId, score: 0.9 },
      { id: orphanPointId, score: 0.8 },
    ])

    const result = await service.search({ query: 'test', media_types: ['image'], limit: 10 })

    expect(result.results.map((item) => item.asset_id)).toEqual([asset.id])
  })

  test('soft-deleted media is filtered from vector, FTS, and hybrid results', async () => {
    const library = await createLibrary(db, { name: 'Deleted', rootPath: '/deleted' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/deleted/poster.png',
      relativePath: 'poster.png',
      mediaType: 'image',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/deleted/poster.png',
      textContent: 'deleted archive poster',
    })
    const pointId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await createVectorRef(db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId,
      modelName: 'mock',
      modelVersion: 'phase5',
      vectorKind: 'image_embedding',
      vectorDim: 512,
      distance: 'Cosine',
      contentHash: 'hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    await db.execute(sql`
      UPDATE media_files
      SET deleted_at = NOW()
      WHERE id = ${file.id}
    `)
    search.mockResolvedValue([{ id: pointId, score: 0.9 }])

    const result = await service.search({
      query: 'archive',
      media_types: ['image'],
      library_ids: [library.id],
      limit: 10,
    })

    expect(result.results).toEqual([])
  })
})
