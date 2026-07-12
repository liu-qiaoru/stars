import { Test } from '@nestjs/testing'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SETTINGS } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import {
  createJob,
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../../src/database/repositories.js'
import { jobs, vectorRefs } from '../../src/database/schema.js'
import { JobsController } from '../../src/jobs/jobs.controller.js'
import { JobsModule } from '../../src/jobs/jobs.module.js'
import { JobsService } from '../../src/jobs/jobs.service.js'
import { createTestDatabase } from '../database/test-db.js'

let closeDb: () => Promise<void>
let closeModule: () => Promise<void>
let service: JobsService
let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
const testSettings = {
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
}

beforeEach(async () => {
  const testDb = await createTestDatabase()
  db = testDb.db
  closeDb = testDb.close

  const moduleRef = await Test.createTestingModule({
    imports: [JobsModule],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PG_POOL)
    .useValue(null)
    .overrideProvider(SETTINGS)
    .useValue(testSettings)
    .compile()

  service = moduleRef.get(JobsService)
  closeModule = () => moduleRef.close()
})

afterEach(async () => {
  await closeModule?.()
  await closeDb?.()
})

describe('jobs service', () => {
  test('video reindex controller maps snake_case rollout inputs', () => {
    const jobsService = {
      queueVideoReindexJobs: vi.fn().mockReturnValue({ scanned: 0, created: 0 }),
    } as unknown as JobsService
    const controller = new JobsController(jobsService)

    controller.queueVideoReindexJobs({
      library_id: '11111111-1111-4111-8111-111111111111',
      file_id: '22222222-2222-4222-8222-222222222222',
      limit: 25,
      dry_run: true,
      only_not_ready: false,
    })

    expect(jobsService.queueVideoReindexJobs).toHaveBeenCalledWith({
      libraryId: '11111111-1111-4111-8111-111111111111',
      fileId: '22222222-2222-4222-8222-222222222222',
      limit: 25,
      dryRun: true,
      onlyNotReady: false,
    })
  })

  test('video reindex supports dry-run and skips an already active file', async () => {
    const library = await createLibrary(db, { name: 'Video', rootPath: '/video' })
    const video = await createMediaFile(db, {
      libraryId: library.id,
      path: '/video/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    await createMediaFile(db, {
      libraryId: library.id,
      path: '/video/poster.jpg',
      relativePath: 'poster.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })

    await expect(
      service.queueVideoReindexJobs({ limit: 100, dryRun: true }),
    ).resolves.toMatchObject({
      scanned: 1,
      queueable: 1,
      created: 0,
      skipped_active: 0,
      dry_run: true,
      file_ids: [video.id],
    })
    await expect(service.listJobs()).resolves.toMatchObject({ total: 0 })

    await expect(service.queueVideoReindexJobs({ limit: 100 })).resolves.toMatchObject({
      created: 1,
      file_ids: [video.id],
    })
    await expect(service.queueVideoReindexJobs({ limit: 100 })).resolves.toMatchObject({
      created: 0,
      skipped_active: 1,
    })
  })

  test('video reindex readiness reports missing frames, long segments, and active segment refs', async () => {
    const library = await createLibrary(db, { name: 'Readiness', rootPath: '/ready' })
    const video = await createMediaFile(db, {
      libraryId: library.id,
      path: '/ready/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const segment = await createMediaAsset(db, {
      fileId: video.id,
      assetType: 'video_segment',
      startTimeSeconds: '0',
      endTimeSeconds: '60',
      metadataJson: { scene_id: 'scene-0001', stale: false },
    })
    await createVectorRef(db, {
      assetId: segment.id,
      fileId: video.id,
      libraryId: library.id,
      collectionName: 'video_segment_vectors',
      pointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      modelName: 'mock',
      modelVersion: 'v1',
      vectorKind: 'representative_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'segment',
      indexProfile: 'balanced',
      status: 'indexed',
    })

    await expect(service.getVideoReindexReadiness()).resolves.toMatchObject({
      ready: false,
      active_video_files: 1,
      active_video_segments: 1,
      segments_without_frames: 1,
      segments_over_30_seconds: 1,
      active_video_segment_vector_refs: 1,
      segments_without_scene_caption_v2: 1,
      missing_file_ids: [video.id],
    })
  })

  test('OCR queue-pending controller 透传 limit 和 batch size', () => {
    const jobsService = {
      queuePendingOcrJobs: vi.fn().mockReturnValue({ scanned: 0, created: 0, skipped: 0 }),
    } as unknown as JobsService
    const controller = new JobsController(jobsService)

    controller.queuePendingOcrJobs({
      library_id: '11111111-1111-4111-8111-111111111111',
      file_id: '22222222-2222-4222-8222-222222222222',
      batch_size: 5,
      limit: 50,
    })

    expect(jobsService.queuePendingOcrJobs).toHaveBeenCalledWith({
      libraryId: '11111111-1111-4111-8111-111111111111',
      fileId: '22222222-2222-4222-8222-222222222222',
      batchSize: 5,
      limit: 50,
    })
  })

  test('按优先级 claim queued job 并写入 worker lock', async () => {
    await createJob(db, {
      jobType: 'scan_library',
      priority: 0,
      inputJson: {
        library_id: '11111111-1111-4111-8111-111111111111',
        root_path: '/low',
        scan_mode: 'mtime_size',
      },
    })
    const highPriority = await createJob(db, {
      jobType: 'scan_library',
      priority: 10,
      inputJson: {
        library_id: '22222222-2222-4222-8222-222222222222',
        root_path: '/high',
        scan_mode: 'mtime_size',
      },
    })

    const claimed = await service.claimNextJob('worker-1')

    expect(claimed).toMatchObject({
      id: highPriority.id,
      status: 'running',
      locked_by: 'worker-1',
      attempt: 1,
    })
  })

  test('回收 heartbeat 超时的 running job', async () => {
    const job = await createJob(db, {
      jobType: 'scan_library',
      timeoutSeconds: 30,
      inputJson: {
        library_id: '33333333-3333-4333-8333-333333333333',
        root_path: '/stale',
        scan_mode: 'mtime_size',
      },
    })
    await service.claimNextJob('worker-1', new Date('2026-06-01T00:00:00Z'))

    const reclaimed = await service.reclaimStaleJobs(new Date('2026-06-01T00:01:00Z'))
    const requeued = await service.getJob(job.id)

    expect(reclaimed).toBe(1)
    expect(requeued).toMatchObject({
      id: job.id,
      status: 'queued',
      locked_by: null,
      heartbeat_at: null,
    })
  })

  test('jobs list 支持分页并返回总数，不把页面固定截断为 50 条', async () => {
    for (let index = 0; index < 60; index += 1) {
      await createJob(db, {
        jobType: 'scan_library',
        inputJson: {
          library_id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
          root_path: `/media/${index}`,
          scan_mode: 'mtime_size',
        },
      })
    }

    await expect(service.listJobs({ limit: 100, offset: 0 })).resolves.toMatchObject({
      total: 60,
      limit: 100,
      offset: 0,
      items: expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({ root_path: '/media/59' }),
        }),
        expect.objectContaining({
          input: expect.objectContaining({ root_path: '/media/0' }),
        }),
      ]),
    })

    await expect(service.listJobs({ limit: 25, offset: 25 })).resolves.toMatchObject({
      total: 60,
      limit: 25,
      offset: 25,
      items: expect.any(Array),
    })
  })

  test('jobs list 返回任务所属文件路径', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/poster.png',
      relativePath: 'poster.png',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/poster.png',
    })

    await createJob(db, {
      jobType: 'index_media',
      inputJson: {
        file_id: file.id,
        index_profile: 'balanced',
        segment_strategy: 'fixed_30s',
      },
    })
    await createJob(db, {
      jobType: 'run_ocr',
      inputJson: {
        asset_ids: [imageAsset.id],
        engine: 'paddleocr',
        language: 'ch',
      },
    })
    await createJob(db, {
      jobType: 'probe_media',
      inputJson: {
        file_id: file.id,
        path: '/media/clip.mp4',
        media_type: 'video',
      },
    })

    await expect(service.listJobs({ limit: 10, offset: 0 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          job_type: 'index_media',
          file_paths: ['/media/clip.mp4'],
        }),
        expect.objectContaining({
          job_type: 'run_ocr',
          file_paths: ['/media/poster.png'],
        }),
        expect.objectContaining({
          job_type: 'probe_media',
          file_paths: ['/media/clip.mp4'],
        }),
      ]),
    })
  })

  test('将 pending image 和 video segment vector_refs 转成 embedding jobs', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/cat.jpg',
      relativePath: 'cat.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/cat.jpg',
      contentHash: 'cat-hash',
    })
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const segmentAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: 'video_segment',
      startTimeSeconds: '30',
      endTimeSeconds: '60',
      contentHash: 'segment-hash',
    })

    await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: '11111111-1111-4111-8111-111111111111',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'image_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'cat-hash',
      indexProfile: 'balanced',
    })
    await createVectorRef(db, {
      assetId: segmentAsset.id,
      fileId: videoFile.id,
      libraryId: library.id,
      collectionName: 'video_segment_vectors',
      pointId: '22222222-2222-4222-8222-222222222222',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'representative_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'segment-hash',
      indexProfile: 'balanced',
    })

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 2,
      created: 2,
      skipped: 0,
    })
    const jobs = await service.listJobs()

    expect(jobs.items.map((job) => job.job_type).sort()).toEqual([
      'embed_image',
      'embed_video_frame',
    ])
    expect(jobs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_type: 'embed_image',
          input: expect.objectContaining({
            asset_id: imageAsset.id,
            path: '/media/cat.jpg',
            collection: 'image_vectors',
            model_name: 'google/siglip-base-patch16-224',
            model_version: 'siglip-base-patch16-224',
          }),
        }),
        expect.objectContaining({
          job_type: 'embed_video_frame',
          input: expect.objectContaining({
            asset_id: segmentAsset.id,
            frame_path: '/media/clip.mp4',
            frame_time_seconds: 45,
            collection: 'video_segment_vectors',
            model_name: 'google/siglip-base-patch16-224',
            model_version: 'siglip-base-patch16-224',
          }),
        }),
      ]),
    )
  })

  test('将 pending caption_text_vectors 转成 embed_text_asset job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const captionAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'caption',
      startTimeSeconds: '30',
      endTimeSeconds: '60',
      textContent: 'A person is cooking in a kitchen',
      contentHash: 'caption-hash',
    })

    await createVectorRef(db, {
      assetId: captionAsset.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'caption_text_vectors',
      pointId: '66666666-6666-4666-8666-666666666666',
      modelName: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      modelVersion: 'paraphrase-multilingual-MiniLM-L12-v2',
      vectorKind: 'vlm_caption_text_embedding',
      vectorDim: 384,
      distance: 'Cosine',
      contentHash: 'caption-hash',
      indexProfile: 'balanced',
    })

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 1,
      created: 1,
      skipped: 0,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items).toEqual([
      expect.objectContaining({
        job_type: 'embed_text_asset',
        input: expect.objectContaining({
          asset_id: captionAsset.id,
          collection: 'caption_text_vectors',
          model_name: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
          model_version: 'paraphrase-multilingual-MiniLM-L12-v2',
        }),
      }),
    ])
  })

  test('embedding queue-pending 不会为已经失败的 vector_ref 反复创建新 job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const segmentAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: 'video_segment',
      startTimeSeconds: '30',
      endTimeSeconds: '60',
      contentHash: 'segment-hash',
    })
    await createVectorRef(db, {
      assetId: segmentAsset.id,
      fileId: videoFile.id,
      libraryId: library.id,
      collectionName: 'video_segment_vectors',
      pointId: '33333333-3333-4333-8333-333333333333',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'representative_frame_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'segment-hash',
      indexProfile: 'balanced',
    })
    const failedJob = await createJob(db, {
      jobType: 'embed_video_frame',
      inputJson: {
        asset_id: segmentAsset.id,
        frame_path: '/media/clip.mp4',
        frame_time_seconds: 45,
        collection: 'video_segment_vectors',
        model_name: 'google/siglip-base-patch16-224',
        model_version: 'siglip-base-patch16-224',
      },
    })
    await db
      .update(jobs)
      .set({
        status: 'failed',
        errorMessage: 'ffmpeg failed',
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, failedJob.id))

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 1,
      created: 0,
      skipped: 1,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items.filter((job) => job.job_type === 'embed_video_frame')).toHaveLength(1)
  })

  test('embedding queue-pending 不会为已尝试过的 pending ref 创建重复 job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/cat.jpg',
      relativePath: 'cat.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/cat.jpg',
      contentHash: 'cat-hash',
    })
    await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: '44444444-4444-4444-8444-444444444444',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'image_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'cat-hash',
      indexProfile: 'balanced',
    })
    const succeededJob = await createJob(db, {
      jobType: 'embed_image',
      inputJson: {
        asset_id: imageAsset.id,
        path: '/media/cat.jpg',
        collection: 'image_vectors',
        model_name: 'google/siglip-base-patch16-224',
        model_version: 'siglip-base-patch16-224',
      },
    })
    await db
      .update(jobs)
      .set({
        status: 'succeeded',
        progress: 100,
        resultJson: { point_id: '44444444-4444-4444-8444-444444444444' },
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, succeededJob.id))

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 1,
      created: 0,
      skipped: 1,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items.filter((job) => job.job_type === 'embed_image')).toHaveLength(1)
  })

  test('embedding queue-pending 允许 reset 后的 vector_ref 重新创建 job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/reset.jpg',
      relativePath: 'reset.jpg',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/reset.jpg',
      contentHash: 'reset-hash',
    })
    const ref = await createVectorRef(db, {
      assetId: imageAsset.id,
      fileId: imageFile.id,
      libraryId: library.id,
      collectionName: 'image_vectors',
      pointId: '55555555-5555-4555-8555-555555555555',
      modelName: 'google/siglip-base-patch16-224',
      modelVersion: 'siglip-base-patch16-224',
      vectorKind: 'image_embedding',
      vectorDim: 768,
      distance: 'Cosine',
      contentHash: 'reset-hash',
      indexProfile: 'balanced',
    })
    const oldJob = await createJob(db, {
      jobType: 'embed_image',
      inputJson: {
        asset_id: imageAsset.id,
        path: '/media/reset.jpg',
        collection: 'image_vectors',
        model_name: 'google/siglip-base-patch16-224',
        model_version: 'siglip-base-patch16-224',
      },
    })
    await db
      .update(jobs)
      .set({
        status: 'succeeded',
        progress: 100,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        finishedAt: new Date('2026-06-01T00:00:00Z'),
      })
      .where(eq(jobs.id, oldJob.id))
    await db
      .update(vectorRefs)
      .set({
        status: 'pending',
        updatedAt: new Date('2026-06-01T00:01:00Z'),
      })
      .where(eq(vectorRefs.id, ref.id))

    await expect(service.queuePendingEmbeddingJobs(10)).resolves.toEqual({
      scanned: 1,
      created: 1,
      skipped: 0,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items.filter((job) => job.job_type === 'embed_image')).toHaveLength(2)
  })

  test('将未 OCR 的 image 和 video_frame assets 批量转成 run_ocr jobs', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const imageFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/poster.png',
      relativePath: 'poster.png',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const imageAsset = await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/poster.png',
    })
    const videoFile = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 20,
      mtimeMs: 2,
    })
    const frameAsset = await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: 'video_frame',
      path: '/media/clip.mp4',
      frameTimeSeconds: '12.5',
    })
    await createMediaAsset(db, {
      fileId: imageFile.id,
      assetType: 'image',
      path: '/media/already.png',
      textContent: 'already indexed',
      metadataJson: { ocr: { engine: 'paddleocr' } },
    })
    await createMediaAsset(db, {
      fileId: videoFile.id,
      assetType: 'video_segment',
      startTimeSeconds: '0',
      endTimeSeconds: '30',
    })

    await expect(
      service.queuePendingOcrJobs({ libraryId: library.id, batchSize: 20 }),
    ).resolves.toEqual({
      scanned: 2,
      created: 1,
      skipped: 0,
    })
    const jobs = await service.listJobs()

    expect(jobs.items).toEqual([
      expect.objectContaining({
        job_type: 'run_ocr',
        timeout_seconds: 7200,
        input: {
          asset_ids: [imageAsset.id, frameAsset.id],
          engine: 'paddleocr',
          language: 'ch',
        },
      }),
    ])
  })

  test('OCR queue-pending 不会为已经失败的 asset 反复创建新 job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/poster.png',
      relativePath: 'poster.png',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/media/poster.png',
    })
    const failedJob = await createJob(db, {
      jobType: 'run_ocr',
      inputJson: {
        asset_ids: [asset.id],
        engine: 'paddleocr',
        language: 'ch',
      },
    })
    await db
      .update(jobs)
      .set({
        status: 'failed',
        errorMessage: 'The truth value of an empty array is ambiguous',
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, failedJob.id))

    await expect(service.queuePendingOcrJobs({ libraryId: library.id })).resolves.toEqual({
      scanned: 1,
      created: 0,
      skipped: 1,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items.filter((job) => job.job_type === 'run_ocr')).toHaveLength(1)
  })

  test('OCR queue-pending 不会为已成功但没有文本的 asset 重复创建 job', async () => {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/blank.png',
      relativePath: 'blank.png',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/media/blank.png',
    })
    const succeededJob = await createJob(db, {
      jobType: 'run_ocr',
      inputJson: {
        asset_ids: [asset.id],
        engine: 'paddleocr',
        language: 'ch',
      },
    })
    await db
      .update(jobs)
      .set({
        status: 'succeeded',
        resultJson: { assets_processed: 1, text_written: 0, skipped_no_text: 1 },
        progress: 100,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, succeededJob.id))

    await expect(service.queuePendingOcrJobs({ libraryId: library.id })).resolves.toEqual({
      scanned: 1,
      created: 0,
      skipped: 1,
    })
    const listed = await service.listJobs({ limit: 10, offset: 0 })

    expect(listed.items.filter((job) => job.job_type === 'run_ocr')).toHaveLength(1)
  })

  test('OCR queue-pending 使用 limit 并从 OCR_BATCH_SIZE 读取默认 batch size', async () => {
    const originalBatchSize = process.env.OCR_BATCH_SIZE
    process.env.OCR_BATCH_SIZE = '1'
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/contact-sheet.png',
      relativePath: 'contact-sheet.png',
      mediaType: 'image',
      sizeBytes: 10,
      mtimeMs: 1,
    })
    const firstAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/media/contact-sheet-1.png',
    })
    const secondAsset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/media/contact-sheet-2.png',
    })
    await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'image',
      path: '/media/contact-sheet-3.png',
    })

    try {
      await expect(
        service.queuePendingOcrJobs({ libraryId: library.id, limit: 2 }),
      ).resolves.toEqual({
        scanned: 2,
        created: 2,
        skipped: 0,
      })
      const jobs = await service.listJobs()

      const queuedAssetIds = jobs.items
        .map((job) => (job.input as { asset_ids: string[] }).asset_ids[0])
        .sort()
      expect(queuedAssetIds).toEqual([firstAsset.id, secondAsset.id].sort())
    } finally {
      if (originalBatchSize === undefined) {
        delete process.env.OCR_BATCH_SIZE
      } else {
        process.env.OCR_BATCH_SIZE = originalBatchSize
      }
    }
  })
})
