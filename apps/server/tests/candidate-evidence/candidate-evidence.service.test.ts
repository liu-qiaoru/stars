import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CandidateEvidenceModule } from '../../src/candidate-evidence/candidate-evidence.module.js'
import { CandidateEvidenceService } from '../../src/candidate-evidence/candidate-evidence.service.js'
import { SETTINGS } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
} from '../../src/database/repositories.js'
import {
  agentRunCandidates,
  agentRuns,
  candidateEvidence,
  evaluationCandidates,
  evaluationQueries,
  evaluationRuns,
  evaluationSets,
  evaluationVersions,
  jobs,
  mediaFiles,
  videoScenes,
} from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

describe('candidate evidence service', () => {
  let closeDb: () => Promise<void>
  let closeModule: () => Promise<void>
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
  let service: CandidateEvidenceService

  beforeEach(async () => {
    const testDb = await createTestDatabase()
    db = testDb.db
    closeDb = testDb.close
    const moduleRef = await Test.createTestingModule({ imports: [CandidateEvidenceModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(PG_POOL)
      .useValue(null)
      .overrideProvider(SETTINGS)
      .useValue({
        serverHost: '127.0.0.1',
        serverPort: 4000,
        databaseUrl: 'postgres://test',
        qdrantUrl: 'http://127.0.0.1:6333',
        modelServiceUrl: 'http://127.0.0.1:4020',
        modelServiceTimeoutMs: 10_000,
      })
      .compile()
    service = moduleRef.get(CandidateEvidenceService)
    closeModule = () => moduleRef.close()
  })

  afterEach(async () => {
    await closeModule?.()
    await closeDb?.()
  })

  async function createFrozenAgentVideoCandidate() {
    const library = await createLibrary(db, { name: 'Main', rootPath: '/media' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/media/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 1,
    })
    await db
      .update(mediaFiles)
      .set({ indexStatus: 'indexed', indexGeneration: 3 })
      .where(eq(mediaFiles.id, file.id))
    const sceneId = randomUUID()
    await db.insert(videoScenes).values({
      id: sceneId,
      fileId: file.id,
      sceneKey: 'scene-1',
      startTimeSeconds: '10',
      endTimeSeconds: '30',
      detectionStrategy: 'scene_detection',
      strategyFingerprint: 'strategy-v1',
      indexGeneration: 3,
    })
    const asset = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'video_frame',
      sceneId,
      frameTimeSeconds: '12.5',
      contentHash: 'frame-1',
      metadataJson: { stale: false },
    })
    const runId = randomUUID()
    await db.insert(agentRuns).values({ id: runId, prompt: '找视频' })
    await db.insert(agentRunCandidates).values({
      id: randomUUID(),
      runId,
      candidateKey: `video:${sceneId}`,
      fileId: file.id,
      fileGeneration: 3,
      assetId: asset.id,
      sceneId,
      sceneStartSeconds: '10',
      sceneEndSeconds: '30',
      rank: 1,
    })
    return { runId, fileId: file.id, sceneId, assetId: asset.id, candidateKey: `video:${sceneId}` }
  }

  test('reuses one evidence record and one Job for repeated requests of the same frozen candidate', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const request = {
      source: { type: 'agent_run_candidate' as const, run_id: fixture.runId },
      candidate_key: fixture.candidateKey,
      strategies: ['contact_sheet_v1' as const],
    }

    const [first, repeated] = await Promise.all([
      service.createEvidence(request),
      service.createEvidence(request),
    ])
    // 新 Service 实例没有任何旧进程内状态，仍应从同一 PostgreSQL 行恢复。
    const afterRestart = await new CandidateEvidenceService(db).createEvidence(request)
    const [evidenceCount] = await db.select({ value: count() }).from(candidateEvidence)
    const [jobCount] = await db
      .select({ value: count() })
      .from(jobs)
      .where(eq(jobs.jobType, 'build_candidate_evidence'))

    expect(first.items[0].id).toBe(repeated.items[0].id)
    expect(first.items[0].job_id).toBe(repeated.items[0].job_id)
    expect(afterRestart.items[0].job_id).toBe(first.items[0].job_id)
    expect(first.items[0]).toMatchObject({
      status: 'queued',
      strategy: 'contact_sheet_v1',
      protocol_version: 'candidate-evidence-v1',
    })
    expect(evidenceCount.value).toBe(1)
    expect(jobCount.value).toBe(1)
  })

  test('rejects a stale file generation instead of silently reading the new generation', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    await db.update(mediaFiles).set({ indexGeneration: 4 }).where(eq(mediaFiles.id, fixture.fileId))

    await expect(
      service.createEvidence({
        source: { type: 'agent_run_candidate', run_id: fixture.runId },
        candidate_key: fixture.candidateKey,
        strategies: ['contact_sheet_v1'],
      }),
    ).rejects.toMatchObject({ response: { error_code: 'STALE_FILE_GENERATION' } })
  })

  test('creates only one replacement Job when failed evidence is retried concurrently', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const request = {
      source: { type: 'agent_run_candidate' as const, run_id: fixture.runId },
      candidate_key: fixture.candidateKey,
      strategies: ['contact_sheet_v1' as const],
    }
    const created = await service.createEvidence(request)
    await db
      .update(candidateEvidence)
      .set({ status: 'failed', errorCode: 'FIXTURE_FAILURE', errorMessage: 'fixture' })
      .where(eq(candidateEvidence.id, created.items[0].id))

    const [firstRetry, concurrentRetry] = await Promise.all([
      service.createEvidence(request),
      service.createEvidence(request),
    ])
    const [jobCount] = await db
      .select({ value: count() })
      .from(jobs)
      .where(eq(jobs.jobType, 'build_candidate_evidence'))

    expect(firstRetry.items[0].job_id).toBe(concurrentRetry.items[0].job_id)
    expect(jobCount.value).toBe(2)
  })

  test('rejects candidate ownership mismatches before creating a Job', async () => {
    const fixture = await createFrozenAgentVideoCandidate()

    await expect(
      service.createEvidence({
        source: { type: 'agent_run_candidate', run_id: randomUUID() },
        candidate_key: fixture.candidateKey,
        strategies: ['contact_sheet_v1'],
      }),
    ).rejects.toMatchObject({ status: 404 })
    const [jobCount] = await db.select({ value: count() }).from(jobs)
    expect(jobCount.value).toBe(0)
  })

  test('rejects frozen candidate file, scene, and asset identity mismatches', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const otherLibrary = await createLibrary(db, {
      name: 'Other identity',
      rootPath: '/other-identity',
    })
    const otherFile = await createMediaFile(db, {
      libraryId: otherLibrary.id,
      path: '/other-identity/clip.mp4',
      relativePath: 'clip.mp4',
      mediaType: 'video',
      sizeBytes: 100,
      mtimeMs: 1,
    })
    await db
      .update(mediaFiles)
      .set({ indexStatus: 'indexed', indexGeneration: 3 })
      .where(eq(mediaFiles.id, otherFile.id))
    const otherSceneId = randomUUID()
    await db.insert(videoScenes).values({
      id: otherSceneId,
      fileId: otherFile.id,
      sceneKey: 'other-scene',
      startTimeSeconds: '10',
      endTimeSeconds: '30',
      detectionStrategy: 'scene_detection',
      strategyFingerprint: 'strategy-v1',
      indexGeneration: 3,
    })
    const otherAsset = await createMediaAsset(db, {
      fileId: otherFile.id,
      assetType: 'video_frame',
      sceneId: otherSceneId,
      frameTimeSeconds: '12.5',
      contentHash: 'other-frame',
      metadataJson: { stale: false },
    })

    for (const mismatch of ['file', 'scene', 'asset'] as const) {
      await db
        .update(agentRunCandidates)
        .set(
          mismatch === 'file'
            ? { fileId: otherFile.id }
            : mismatch === 'scene'
              ? { sceneId: otherSceneId }
              : { assetId: otherAsset.id },
        )
        .where(eq(agentRunCandidates.runId, fixture.runId))

      await expect(
        service.createEvidence({
          source: { type: 'agent_run_candidate', run_id: fixture.runId },
          candidate_key: fixture.candidateKey,
          strategies: ['contact_sheet_v1'],
        }),
      ).rejects.toMatchObject({ status: 409 })
      await db
        .update(agentRunCandidates)
        .set({ fileId: fixture.fileId, sceneId: fixture.sceneId, assetId: fixture.assetId })
        .where(eq(agentRunCandidates.runId, fixture.runId))
    }
    const [jobCount] = await db.select({ value: count() }).from(jobs)
    expect(jobCount.value).toBe(0)
  })

  test('restores state by source, never returns an absolute path, and cancels a queued shared Job', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const created = await service.createEvidence({
      source: { type: 'agent_run_candidate', run_id: fixture.runId },
      candidate_key: fixture.candidateKey,
      strategies: ['contact_sheet_v1', 'all_indexed_frames_v1'],
    })

    const restored = await service.listEvidence({
      source_type: 'agent_run_candidate',
      source_id: fixture.runId,
      candidate_key: fixture.candidateKey,
    })
    expect(restored.items.map((item) => item.id)).toEqual(created.items.map((item) => item.id))
    expect(JSON.stringify(restored)).not.toContain('/media/')
    expect(JSON.stringify(restored)).not.toContain('artifact_path')

    const cancelled = await service.cancelEvidence(created.items[0].id)
    expect(cancelled).toMatchObject({ status: 'cancelled' })
    const evidenceRows = await db.select().from(candidateEvidence)
    expect(evidenceRows.map((row) => row.status)).toEqual(['cancelled', 'cancelled'])
    const [job] = await db.select().from(jobs)
    expect(job.status).toBe('cancelled')
  })

  test('serves only a succeeded artifact whose bytes match the persisted SHA-256', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const created = await service.createEvidence({
      source: { type: 'agent_run_candidate', run_id: fixture.runId },
      candidate_key: fixture.candidateKey,
      strategies: ['contact_sheet_v1'],
    })
    await expect(service.getArtifact(created.items[0].id)).rejects.toMatchObject({ status: 409 })

    const directory = await mkdtemp(join(tmpdir(), 'candidate-evidence-server-'))
    try {
      const artifactPath = join(directory, 'sheet.png')
      const bytes = Buffer.from('local-fixture-image')
      await writeFile(artifactPath, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await db
        .update(candidateEvidence)
        .set({
          status: 'succeeded',
          artifactPath,
          artifactSha256: sha256,
          artifactMimeType: 'image/png',
        })
        .where(eq(candidateEvidence.id, created.items[0].id))

      const artifact = await service.getArtifact(created.items[0].id)
      expect(artifact.content).toEqual(bytes)
      expect(artifact.contentType).toBe('image/png')

      await writeFile(artifactPath, 'tampered')
      await expect(service.getArtifact(created.items[0].id)).rejects.toMatchObject({
        response: { error_code: 'EVIDENCE_ARTIFACT_FINGERPRINT_MISMATCH' },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('supports a frozen Evaluation candidate and retains its evidence without the 24-hour cache expiry', async () => {
    const fixture = await createFrozenAgentVideoCandidate()
    const setId = randomUUID()
    const versionId = randomUUID()
    const queryId = randomUUID()
    const evaluationRunId = randomUUID()
    const candidateId = randomUUID()
    await db.insert(evaluationSets).values({ id: setId, name: 'Frozen' })
    await db.insert(evaluationVersions).values({
      id: versionId,
      setId,
      version: 1,
      status: 'frozen',
    })
    await db.insert(evaluationQueries).values({
      id: queryId,
      versionId,
      queryText: '红车',
      queryType: 'natural_discovery',
      intentCategory: 'visual',
      mustHaveJson: ['红车'],
    })
    await db.insert(evaluationRuns).values({
      id: evaluationRunId,
      versionId,
      status: 'ready_for_labeling',
      configJson: {},
    })
    await db.insert(evaluationCandidates).values({
      id: candidateId,
      runId: evaluationRunId,
      queryId,
      candidateKey: fixture.candidateKey,
      assetId: fixture.assetId,
      fileId: fixture.fileId,
      sceneId: fixture.sceneId,
      fileGeneration: 3,
      mediaType: 'video',
      startTimeSeconds: '10',
      endTimeSeconds: '30',
      blindOrder: 1,
    })

    const created = await service.createEvidence({
      source: {
        type: 'evaluation_candidate',
        run_id: evaluationRunId,
        candidate_id: candidateId,
      },
      candidate_key: fixture.candidateKey,
      strategies: ['all_indexed_frames_v1'],
    })
    const [row] = await db
      .select()
      .from(candidateEvidence)
      .where(eq(candidateEvidence.id, created.items[0].id))

    expect(row.retentionClass).toBe('evaluation_frozen')
    expect(row.expiresAt).toBeNull()
    expect(row.frozenAt).toBeInstanceOf(Date)
  })
})
