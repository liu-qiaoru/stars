import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../src/database/repositories.js'
import { videoScenes } from '../src/database/schema.js'
import type { Settings } from '../src/config/settings.js'
import { MediaService } from '../src/media/media.service.js'
import type { QueryExpansionService } from '../src/search/query-expansion.service.js'
import type { SearchQueryVectorService } from '../src/search/search-query-vector.service.js'
import { SearchService } from '../src/search/search.service.js'
import { createTestDatabase } from './database/test-db.js'

describe('scene metadata surfaces', () => {
  let context: Awaited<ReturnType<typeof createTestDatabase>>

  beforeEach(async () => {
    context = await createTestDatabase()
  })

  afterEach(async () => {
    await context.close()
  })

  // 阶段 2 后场景身份在 video_scenes 表，视频帧通过 scene_id 外键引用场景行。
  async function seedSceneFrame() {
    const library = await createLibrary(context.db, { name: 'Videos', rootPath: '/media' })
    const file = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 200,
      durationSeconds: '30',
    })
    const [scene] = await context.db
      .insert(videoScenes)
      .values({
        id: randomUUID(),
        fileId: file.id,
        sceneKey: 'scene-0001',
        startTimeSeconds: '0',
        endTimeSeconds: '30',
        detectionStrategy: 'scene_detection',
        strategyFingerprint: 'test-fingerprint',
        indexGeneration: 0,
      })
      .returning()
    const asset = await createMediaAsset(context.db, {
      fileId: file.id,
      assetType: 'video_frame',
      sceneId: scene.id,
      frameTimeSeconds: '5',
      contentHash: 'frame-hash',
      metadataJson: { scene_key: 'scene-0001', index_layout_version: 'scene-frames-v3' },
    })
    const pointId = '11111111-1111-4111-8111-111111111111'
    await createVectorRef(context.db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'video_frame_vectors',
      pointId,
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'frame-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    return { file, scene, asset, pointId }
  }

  it('returns asset metadata for media detail scene grouping', async () => {
    const { file } = await seedSceneFrame()
    const service = new MediaService(context.db)

    const response = await service.getMedia(file.id)

    expect(response.assets[0].metadata_json).toEqual({
      scene_key: 'scene-0001',
      index_layout_version: 'scene-frames-v3',
    })
  })

  it('returns scene_id on hydrated video search results', async () => {
    const { scene, pointId } = await seedSceneFrame()
    const service = new SearchService(
      context.db,
      {
        search: async () => [],
        // 视频帧向量走分组检索，返回该场景一个组，代表帧即命中的 point。
        searchPointGroups: async () => ({
          groups: [{ id: scene.id, hits: [{ id: pointId, score: 0.9, version: 1 }] }],
        }),
      },
      {
        embedQuery: async () => Array.from({ length: 768 }, () => 0.1),
      } as unknown as SearchQueryVectorService,
      {
        expand: async (query: string) => [{ text: query, weight: 1, source: 'original' }],
      } as unknown as QueryExpansionService,
      {
        captionSearchEnabled: false,
      } as unknown as Settings,
    )

    const response = await service.search({ query: 'opening shot', media_types: ['video'] })

    // scene_id 是正式 video_scenes.id（UUID），不再是 metadata 里的字符串键。
    expect(response.groups[0].results[0].scene_id).toBe(scene.id)
  })
})
