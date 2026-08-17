import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
} from '../../src/database/repositories.js'
import { evaluationCandidates, videoScenes } from '../../src/database/schema.js'
import {
  EvaluationService,
  requiresCandidateJudgment,
} from '../../src/evaluation/evaluation.service.js'
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
  test('only discovery candidates in either current or RRF Top-20 require human labels', () => {
    expect(requiresCandidateJudgment('known_target', 1, 1)).toBe(false)
    expect(requiresCandidateJudgment('discovery', 20, null)).toBe(true)
    expect(requiresCandidateJudgment('discovery', null, 20)).toBe(true)
    expect(requiresCandidateJudgment('discovery', 21, null)).toBe(false)
    expect(requiresCandidateJudgment('discovery', null, 21)).toBe(false)
  })

  test('PGlite migration creates baseline, Phase E and Phase F evaluation tables', async () => {
    const rows = await context.client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' and tablename like 'evaluation_%'",
    )
    expect(rows.rows.map((row) => row.tablename).sort()).toEqual([
      'evaluation_candidates',
      'evaluation_judgments',
      'evaluation_queries',
      'evaluation_runs',
      'evaluation_sets',
      'evaluation_shadow_attempts',
      'evaluation_shadow_rankings',
      'evaluation_shadow_runs',
      'evaluation_shadow_usage_reconciliations',
      'evaluation_versions',
      'evaluation_vlm_blind_cases',
      'evaluation_vlm_blind_conditions',
      'evaluation_vlm_blind_datasets',
      'evaluation_vlm_blind_fake_results',
      'evaluation_vlm_blind_fake_runs',
      'evaluation_vlm_blind_labeling_sessions',
      'evaluation_vlm_blind_real_attempts',
      'evaluation_vlm_blind_real_results',
      'evaluation_vlm_blind_real_runs',
      'evaluation_vlm_blind_visual_authorizations',
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
        search_scope: 'visual',
        intent_category: '人物',
        must_have: ['人'],
        target_file_id: file.id,
        target_scene_id: null,
      }),
    ).rejects.toThrow(/requires target_scene_id/)
    await service.addQuery(set.version_id, {
      query_text: '海边的人',
      query_type: 'known_target',
      search_scope: 'visual',
      intent_category: '人物',
      must_have: ['人'],
      target_file_id: file.id,
      target_scene_id: sceneId,
    })
    await service.addQuery(set.version_id, {
      query_text: '自然发现海边的人',
      query_type: 'discovery',
      search_scope: 'visual',
      intent_category: '人物',
      must_have: ['人'],
    })
    await service.freezeVersion(set.version_id)
    const run = await service.startRun(set.version_id, { library_ids: [library.id] })

    expect(run.status).toBe('ready_for_labeling')
    const knownTarget = run.candidates.find((candidate) => candidate.query_text === '海边的人')!
    const discovery = run.candidates.find(
      (candidate) => candidate.query_text === '自然发现海边的人',
    )!
    expect(knownTarget).toMatchObject({
      scene_id: sceneId,
      judgment: null,
      requires_judgment: false,
    })
    expect(discovery).toMatchObject({ judgment: null, requires_judgment: true })
    expect(knownTarget).not.toHaveProperty('source_evidence')
    await expect(service.getRun(run.id, true)).rejects.toThrow(/evidence remains hidden/)
    expect(searchForEvaluation).toHaveBeenCalledTimes(2)

    // 复现用户在工作量收紧前多标了一个两种排序前 20 名之外的候选。该判断需要保留审计，
    // 但不能进入正式 nDCG 理想分母，否则分数会取决于用户偶然多标了多少条。
    const outsidePoolId = randomUUID()
    await context.db.insert(evaluationCandidates).values({
      id: outsidePoolId,
      runId: run.id,
      queryId: discovery.query_id,
      candidateKey: 'outside-top-20',
      assetId: asset.id,
      fileId: file.id,
      sceneId,
      fileGeneration: 0,
      mediaType: 'video',
      startTimeSeconds: '3',
      endTimeSeconds: '9',
      sourceEvidenceJson: [],
      currentRank: 21,
      rrfRank: 21,
      blindOrder: 99,
      primaryPool: false,
    })
    await service.saveJudgment(run.id, outsidePoolId, { relevance: 2 })
    const partiallyLabeledHistory = await service.listRuns({ limit: 10, offset: 0 })
    expect(partiallyLabeledHistory.items[0]).toMatchObject({
      required_candidate_count: 1,
      judged_required_candidate_count: 0,
      judged_candidate_count: 1,
    })

    // 指定目标只读冻结目标唯一标识与名次；只完成自然发现正式池即可结束标注。
    const labeled = await service.saveJudgment(run.id, discovery.id, { relevance: 1 })
    expect(labeled.status).toBe('labeled')
    expect(
      labeled.candidates.find((candidate) => candidate.id === knownTarget.id)?.judgment,
    ).toBeNull()
    const reported = await service.finalizeRun(run.id)
    expect(reported.status).toBe('reported')
    const report = reported.report as {
      queries: Array<{
        query_id: string
        current: { ndcgAt10: number | null }
        rrf: { ndcgAt10: number | null }
      }>
    }
    const discoveryReport = report.queries.find((entry) => entry.query_id === discovery.query_id)
    expect(discoveryReport?.current.ndcgAt10).toBe(1)
    expect(discoveryReport?.rrf.ndcgAt10).toBe(1)

    // 报告页先读取轻量运行列表，再按需读取某次运行的候选详情。列表必须带上评测集、
    // 版本和标注进度，否则页面只能要求用户手工保存不可读的 UUID。
    const history = await service.listRuns({ limit: 10, offset: 0 })
    expect(history).toMatchObject({ total: 1, limit: 10, offset: 0 })
    expect(history.items[0]).toMatchObject({
      id: run.id,
      set_name: '最小评测',
      version: 1,
      status: 'reported',
      query_count: 2,
      candidate_count: 3,
      required_candidate_count: 1,
      judged_required_candidate_count: 1,
      judged_candidate_count: 2,
    })
    expect(history.items[0]?.report).toEqual(reported.report)
    await expect(service.saveJudgment(run.id, discovery.id, { relevance: 0 })).rejects.toThrow(
      /immutable/,
    )
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
      search_scope: 'visual',
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
