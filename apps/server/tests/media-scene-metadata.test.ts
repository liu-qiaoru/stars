import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../src/database/repositories.js'
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

  async function seedSceneVector() {
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
    const asset = await createMediaAsset(context.db, {
      fileId: file.id,
      assetType: 'video_segment',
      startTimeSeconds: '0',
      endTimeSeconds: '30',
      contentHash: 'scene-hash',
      metadataJson: {
        scene_id: 'scene-0001',
        segment_strategy: 'scene_detection',
      },
    })
    await createVectorRef(context.db, {
      assetId: asset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'video_segment_vectors',
      pointId: '11111111-1111-4111-8111-111111111111',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'representative_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'scene-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    return { file }
  }

  it('returns asset metadata for media detail scene grouping', async () => {
    const { file } = await seedSceneVector()
    const service = new MediaService(context.db)

    const response = await service.getMedia(file.id)

    expect(response.assets[0].metadata_json).toEqual({
      scene_id: 'scene-0001',
      segment_strategy: 'scene_detection',
    })
  })

  it('returns scene_id on hydrated video search results', async () => {
    await seedSceneVector()
    const service = new SearchService(
      context.db,
      {
        search: async () => [{ id: '11111111-1111-4111-8111-111111111111', score: 0.9, version: 1 }],
      },
      {
        embedQuery: async () => Array.from({ length: 768 }, () => 0.1),
      } as unknown as SearchQueryVectorService,
      {
        expand: async (query: string) => [{ text: query, weight: 1, source: 'original' }],
      } as unknown as QueryExpansionService,
    )

    const response = await service.search({ query: 'opening shot', media_types: ['video'] })

    expect(response.groups[0].results[0].scene_id).toBe('scene-0001')
  })
})
