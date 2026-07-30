import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
} from '../../src/database/repositories.js'
import { evaluationCandidates, videoScenes } from '../../src/database/schema.js'
import { EvaluationService } from '../../src/evaluation/evaluation.service.js'
import type { SearchService } from '../../src/search/search.service.js'
import { createTestDatabase } from '../database/test-db.js'

let context: Awaited<ReturnType<typeof createTestDatabase>>

beforeEach(async () => {
  context = await createTestDatabase()
})

afterEach(async () => {
  await context.close()
})

describe('Phase 6 evaluation runtime', () => {
  test('PGlite migration creates all six evaluation tables', async () => {
    const rows = await context.client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' and tablename like 'evaluation_%'",
    )
    expect(rows.rows.map((row) => row.tablename).sort()).toEqual([
      'evaluation_candidates',
      'evaluation_judgments',
      'evaluation_queries',
      'evaluation_runs',
      'evaluation_sets',
      'evaluation_versions',
    ])
  })

  test('uses a current video_scenes UUID and keeps snapshot evidence blind', async () => {
    const library = await createLibrary(context.db, { name: '主库', rootPath: '/media' })
    const file = await createMediaFile(context.db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const sceneId = randomUUID()
    await context.db.insert(videoScenes).values({
      id: sceneId,
      fileId: file.id,
      sceneKey: 'scene-0001',
      startTimeSeconds: '3',
      endTimeSeconds: '9',
      detectionStrategy: 'content',
      strategyFingerprint: 'test',
      indexGeneration: 0,
    })
    const asset = await createMediaAsset(context.db, {
      fileId: file.id,
      assetType: 'video_frame',
      sceneId,
      frameTimeSeconds: '5',
    })
    const item = {
      asset_id: asset.id,
      file_id: file.id,
      media_type: 'video',
      path: '/media/clip.mp4',
      start_time_seconds: 3,
      end_time_seconds: 9,
      scene_id: sceneId,
      score: 0.03,
      ranking_diagnostics: {
        source_ranks: { visual: 1, caption: 2 },
        rrf_contributions: { visual: 1 / 61, caption: 1 / 62 },
        primary_signal: 'visual',
      },
    }
    const searchForEvaluation = vi.fn().mockResolvedValue({
      limit: 20,
      offset: 0,
      results: [item],
      groups: [
        { collection: 'image_vectors', score_kind: 'cosine_similarity', results: [] },
        { collection: 'video_frame_vectors', score_kind: 'cosine_similarity', results: [item] },
        { collection: 'caption_text_vectors', score_kind: 'cosine_similarity', results: [] },
        { collection: 'text_search', score_kind: 'ts_rank_cd', results: [] },
      ],
      comparison_results: { current: [item], rrf: [item], full_rrf: [item] },
    })
    const service = new EvaluationService(context.db, {
      searchForEvaluation,
    } as unknown as SearchService)
    const set = await service.createSet({ name: '最小评测' })
    await expect(
      service.addQuery(set.version_id, {
        query_text: '缺少视频场景',
        query_type: 'known_target',
        intent_category: '人物',
        must_have: ['人'],
        target_file_id: file.id,
        target_scene_id: null,
      }),
    ).rejects.toThrow(/requires target_scene_id/)
    await service.addQuery(set.version_id, {
      query_text: '海边的人',
      query_type: 'known_target',
      intent_category: '人物',
      must_have: ['人'],
      target_file_id: file.id,
      target_scene_id: sceneId,
    })
    await service.freezeVersion(set.version_id)
    const run = await service.startRun(set.version_id, { library_ids: [library.id] })

    expect(run.status).toBe('ready_for_labeling')
    expect(run.candidates[0]).toMatchObject({ scene_id: sceneId, judgment: null })
    expect(run.candidates[0]).not.toHaveProperty('source_evidence')
    await expect(service.getRun(run.id, true)).rejects.toThrow(/evidence remains hidden/)
    expect(searchForEvaluation).toHaveBeenCalledTimes(1)

    const labeled = await service.saveJudgment(run.id, run.candidates[0]!.id, { relevance: 2 })
    expect(labeled.status).toBe('labeled')
    const reported = await service.finalizeRun(run.id)
    expect(reported.status).toBe('reported')
    await expect(
      service.saveJudgment(run.id, run.candidates[0]!.id, { relevance: 0 }),
    ).rejects.toThrow(/immutable/)
  })

  test('removes partial candidates and marks the whole run failed when a required source is absent', async () => {
    const searchForEvaluation = vi.fn().mockResolvedValue({
      limit: 20,
      offset: 0,
      results: [],
      groups: [{ collection: 'text_search', score_kind: 'ts_rank_cd', results: [] }],
      comparison_results: { current: [], rrf: [], full_rrf: [] },
    })
    const service = new EvaluationService(context.db, {
      searchForEvaluation,
    } as unknown as SearchService)
    const set = await service.createSet({ name: '失败评测' })
    await service.addQuery(set.version_id, {
      query_text: '缺少视觉通道',
      query_type: 'discovery',
      intent_category: '完整性',
      must_have: ['视觉'],
    })
    await service.freezeVersion(set.version_id)
    const run = await service.startRun(set.version_id, {})
    const candidates = await context.db.select().from(evaluationCandidates)

    expect(run).toMatchObject({
      status: 'failed',
      error_code: 'EVALUATION_RETRIEVAL_INCOMPLETE',
    })
    expect(candidates).toHaveLength(0)
  })
})
