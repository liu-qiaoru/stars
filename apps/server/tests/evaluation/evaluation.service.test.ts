import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
} from '../../src/database/repositories.js'
import { mediaFiles } from '../../src/database/schema.js'
import { EvaluationService } from '../../src/evaluation/evaluation.service.js'
import type { SearchService } from '../../src/search/search.service.js'
import { createTestDatabase } from '../database/test-db.js'

describe('evaluation service', () => {
  let context: Awaited<ReturnType<typeof createTestDatabase>>

  beforeEach(async () => {
    context = await createTestDatabase()
  })

  afterEach(async () => {
    await context.close()
  })

  test('runs a frozen blind evaluation and reports current versus RRF from one snapshot', async () => {
    const library = await createLibrary(context.db, { name: '评测素材', rootPath: '/evaluation' })
    const first = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/evaluation/a.jpg',
      relativePath: 'a.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const second = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/evaluation/b.jpg',
      relativePath: 'b.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 2,
    })
    const searchForEvaluation = vi.fn().mockResolvedValue({
      limit: 20,
      offset: 0,
      executed_collections: ['image_vectors', 'video_frame_vectors', 'caption_text_vectors'],
      groups: [
        {
          collection: 'image_vectors',
          score_kind: 'cosine_similarity',
          results: [
            result(first.id, 'asset-a', 0.3),
            result(first.id, 'asset-a-duplicate', 0.29),
            result(second.id, 'asset-b', 0.2),
          ],
        },
        {
          collection: 'caption_text_vectors',
          score_kind: 'cosine_similarity',
          results: [result(second.id, 'caption-b', 0.9)],
        },
        { collection: 'text_search', score_kind: 'ts_rank_cd', results: [] },
      ],
      results: [
        { ...result(second.id, 'caption-b', 0.9), score_kind: 'hybrid_score' },
        { ...result(first.id, 'asset-a', 0.3), score_kind: 'hybrid_score' },
      ],
    })
    const service = new EvaluationService(context.db, {
      searchForEvaluation,
    } as unknown as SearchService)

    const set = await service.createSet({ name: '基线' })
    const query = await service.addQuery(set.version_id, {
      query_text: '红色汽车',
      query_type: 'discovery',
      intent_category: '物体',
      must_have: ['汽车'],
      optional: ['红色'],
      exclusions: [],
    })
    await service.freezeVersion(set.version_id)
    const run = await service.startRun(set.version_id, { library_ids: [library.id] })

    expect(searchForEvaluation).toHaveBeenCalledWith(
      { query: '红色汽车', media_types: [], library_ids: [library.id] },
      20,
    )
    expect(run.status).toBe('ready_for_labeling')
    expect(run.candidates).toHaveLength(2)
    expect(run.candidates[0]).not.toHaveProperty('source_evidence')

    for (const candidate of run.candidates) {
      await service.saveJudgment(run.id, candidate.id, {
        relevance: candidate.file_id === second.id ? 2 : 0,
      })
    }
    const report = await service.finalizeRun(run.id)

    expect(report.status).toBe('reported')
    expect(report.report).toMatchObject({
      queries: [{ query_id: query.id, current: { precisionAt5: 0.5 }, rrf: { precisionAt5: 0.5 } }],
    })
    const secondCandidate = report.candidates.find((candidate) => candidate.file_id === second.id)
    expect(secondCandidate?.rrf_rank).toBe(1)
    expect(secondCandidate?.rrf_score).toBeLessThan(0.04)
    expect(secondCandidate?.source_evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ collection: 'image_vectors', rank: 2 })]),
    )
  })

  test('returns seeded image and video-scene targets without duplicate videos', async () => {
    const library = await createLibrary(context.db, { name: '随机目标', rootPath: '/targets' })
    const image = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/targets/photo.jpg',
      relativePath: 'photo.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const video = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/targets/video.mp4',
      relativePath: 'video.mp4',
      mediaType: 'video',
      sizeBytes: 10,
      mtimeMs: 2,
    })
    await context.db
      .update(mediaFiles)
      .set({ indexStatus: 'indexed' })
      .where(eq(mediaFiles.libraryId, library.id))
    await createMediaAsset(context.db, {
      fileId: video.id,
      assetType: 'video_segment',
      startTimeSeconds: '0',
      endTimeSeconds: '10',
      metadataJson: { scene_id: 'scene-a' },
    })
    await createMediaAsset(context.db, {
      fileId: video.id,
      assetType: 'video_segment',
      startTimeSeconds: '10',
      endTimeSeconds: '20',
      metadataJson: { scene_id: 'scene-b' },
    })
    const service = new EvaluationService(context.db, {} as SearchService)

    const result = await service.listRandomTargets({
      libraryId: library.id,
      limit: 20,
      seed: 'fixed-seed',
    })

    expect(result.seed).toBe('fixed-seed')
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_id: image.id, media_type: 'image', scene_id: null }),
        expect.objectContaining({
          file_id: video.id,
          media_type: 'video',
          scene_id: expect.stringMatching(/^scene-/),
        }),
      ]),
    )
    expect(result.items.filter((item) => item.file_id === video.id)).toHaveLength(1)
  })
})

function result(fileId: string, assetId: string, score: number) {
  return {
    asset_id: assetId,
    file_id: fileId,
    media_type: 'image' as const,
    path: `/evaluation/${fileId}.jpg`,
    start_time_seconds: null,
    end_time_seconds: null,
    scene_id: null,
    score,
    reason: 'vector_match' as const,
  }
}
