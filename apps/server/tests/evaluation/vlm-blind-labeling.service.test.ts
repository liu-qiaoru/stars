import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  candidateEvidence,
  evaluationVlmBlindCases,
  evaluationVlmBlindConditions,
  evaluationVlmBlindDatasets,
  evaluationVlmBlindLabelingSessions,
} from '../../src/database/schema.js'
import { VlmBlindLabelingService } from '../../src/evaluation/vlm-blind-labeling.service.js'
import { createProtocolExerciseFakeVlmReviewProvider } from '../../src/evaluation/vlm-review.provider.js'
import { createTestDatabase } from '../database/test-db.js'

describe('Phase F human condition labeling', () => {
  let context: Awaited<ReturnType<typeof createTestDatabase>>
  let seeded: Awaited<ReturnType<typeof seedFrozenCandidate>>

  beforeEach(async () => {
    context = await createTestDatabase()
    seeded = await seedFrozenCandidate(context.db)
  })

  afterEach(async () => {
    await context.close()
  })

  test('keeps candidate freeze separate and does not create evidence while reading progress', async () => {
    const createEvidence = vi.fn()
    const service = new VlmBlindLabelingService(
      context.db,
      { createEvidence } as never,
      createProtocolExerciseFakeVlmReviewProvider(),
    )

    await expect(service.get(seeded.datasetId)).resolves.toMatchObject({
      candidate_status: 'frozen',
      labels_status: 'evidence_pending',
      session_id: null,
      evidence_summary: { total: 1, missing: 1 },
    })
    expect(createEvidence).not.toHaveBeenCalled()
  })

  test('prepares only all_indexed_frames_v1 from the frozen Evaluation identity', async () => {
    const createEvidence = vi.fn().mockResolvedValue({ items: [] })
    const service = new VlmBlindLabelingService(
      context.db,
      { createEvidence } as never,
      createProtocolExerciseFakeVlmReviewProvider(),
    )

    await expect(service.prepareEvidence(seeded.datasetId)).resolves.toMatchObject({
      candidate_status: 'frozen',
      labels_status: 'evidence_preparing',
    })
    expect(createEvidence).toHaveBeenCalledWith({
      source: {
        type: 'evaluation_candidate',
        run_id: seeded.runId,
        candidate_id: seeded.candidateId,
      },
      candidate_key: seeded.candidateKey,
      strategies: ['all_indexed_frames_v1'],
    })
  })

  test('enforces first, second and final order before freezing one stable label identity', async () => {
    await seedSucceededEvidence(context.db, seeded)
    const service = new VlmBlindLabelingService(
      context.db,
      { createEvidence: vi.fn() } as never,
      createProtocolExerciseFakeVlmReviewProvider(),
    )

    await expect(
      service.saveConditionLabel(
        seeded.datasetId,
        seeded.caseId,
        seeded.mustConditionId,
        'second',
        { verdict: 'yes' },
      ),
    ).rejects.toThrow(/first pass/i)

    for (const conditionId of [seeded.mustConditionId, seeded.exclusionConditionId]) {
      await service.saveConditionLabel(seeded.datasetId, seeded.caseId, conditionId, 'first', {
        verdict: conditionId === seeded.mustConditionId ? 'yes' : 'no',
      })
    }
    await service.saveConditionLabel(
      seeded.datasetId,
      seeded.caseId,
      seeded.mustConditionId,
      'second',
      { verdict: 'yes' },
    )
    const disputed = await service.saveConditionLabel(
      seeded.datasetId,
      seeded.caseId,
      seeded.exclusionConditionId,
      'second',
      { verdict: 'yes' },
    )
    expect(disputed.labels_status).toBe('adjudication')
    expect(disputed.label_progress).toMatchObject({
      total: 2,
      first: 2,
      second: 2,
      adjudication_required: 1,
      resolved: 1,
    })

    await service.saveConditionLabel(
      seeded.datasetId,
      seeded.caseId,
      seeded.exclusionConditionId,
      'final',
      { verdict: 'no' },
    )
    const frozen = await service.freezeLabels(seeded.datasetId)
    expect(frozen).toMatchObject({
      candidate_status: 'frozen',
      labels_status: 'labels_frozen',
      label_progress: { resolved: 2 },
    })
    expect(frozen.labels_fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  test('runs the frozen fake protocol locally and persists no image payload', async () => {
    const evidence = await seedSucceededEvidence(context.db, seeded)
    const service = new VlmBlindLabelingService(
      context.db,
      { createEvidence: vi.fn() } as never,
      createProtocolExerciseFakeVlmReviewProvider(),
    )
    for (const conditionId of [seeded.mustConditionId, seeded.exclusionConditionId]) {
      const verdict = conditionId === seeded.mustConditionId ? 'yes' : 'no'
      await service.saveConditionLabel(seeded.datasetId, seeded.caseId, conditionId, 'first', {
        verdict,
      })
    }
    for (const conditionId of [seeded.mustConditionId, seeded.exclusionConditionId]) {
      const verdict = conditionId === seeded.mustConditionId ? 'yes' : 'no'
      await service.saveConditionLabel(seeded.datasetId, seeded.caseId, conditionId, 'second', {
        verdict,
      })
    }
    await service.freezeLabels(seeded.datasetId)
    await publishFakeBundle(context.db, evidence.id, seeded)

    const result = await service.runFake(seeded.datasetId)
    expect(result.fake_report).toMatchObject({
      status: 'succeeded',
      provider: 'fake',
      external_call_count: 0,
      metrics: {
        condition_total: 2,
        condition_correct: 2,
        condition_accuracy: 1,
        case_total: 1,
        case_status_correct: 1,
        case_status_accuracy: 1,
      },
    })
    expect(JSON.stringify(result.fake_report)).not.toContain('image_base64')
    expect(JSON.stringify(result.fake_report)).not.toContain('ZmFrZS1wbmc')
  })
})

async function seedFrozenCandidate(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const datasetId = randomUUID()
  const caseId = randomUUID()
  const mustConditionId = randomUUID()
  const exclusionConditionId = randomUUID()
  const runId = randomUUID()
  const candidateId = randomUUID()
  const fileId = randomUUID()
  const sceneId = randomUUID()
  const assetId = randomUUID()
  const candidateKey = `video:${sceneId}`
  await db.insert(evaluationVlmBlindDatasets).values({
    id: datasetId,
    name: 'frozen labeling fixture',
    schemaVersion: 'phase-f-vlm-candidate-review-v1',
    status: 'frozen',
    targetCaseCount: 1,
    proposalFingerprint: 'a'.repeat(64),
    frozenFingerprint: 'b'.repeat(64),
    frozenAt: new Date(),
  })
  await db.insert(evaluationVlmBlindCases).values({
    id: caseId,
    datasetId,
    proposalId: 'case-1',
    sourceEvaluationRunId: runId,
    sourceCandidateId: candidateId,
    queryText: '有人在海边走路',
    candidateKey,
    fileId,
    sceneId,
    startTimeSeconds: '3',
    endTimeSeconds: '9',
    proposedGroup: 'exact_match',
    reviewedGroup: 'exact_match',
    reviewStatus: 'accepted',
    selectionBasis: 'test fixture',
  })
  await db.insert(evaluationVlmBlindConditions).values([
    {
      id: mustConditionId,
      caseId,
      conditionId: 'must-1',
      kind: 'must_have',
      sourceText: '画面中有人',
      ordinal: 0,
    },
    {
      id: exclusionConditionId,
      caseId,
      conditionId: 'exclusion-1',
      kind: 'exclusion',
      sourceText: '人物没有走路',
      ordinal: 1,
    },
  ])
  return {
    datasetId,
    caseId,
    mustConditionId,
    exclusionConditionId,
    runId,
    candidateId,
    fileId,
    sceneId,
    assetId,
    candidateKey,
  }
}

async function seedSucceededEvidence(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  seeded: Awaited<ReturnType<typeof seedFrozenCandidate>>,
) {
  await db.insert(evaluationVlmBlindLabelingSessions).values({
    id: randomUUID(),
    datasetId: seeded.datasetId,
  })
  const id = randomUUID()
  await db.insert(candidateEvidence).values({
    id,
    sourceType: 'evaluation_candidate',
    sourceId: seeded.candidateId,
    candidateKey: seeded.candidateKey,
    fileId: seeded.fileId,
    fileGeneration: 1,
    assetId: seeded.assetId,
    sceneId: seeded.sceneId,
    strategy: 'all_indexed_frames_v1',
    protocolVersion: 'candidate-evidence-v1',
    status: 'succeeded',
    retentionClass: 'evaluation_frozen',
    manifestJson: { frame_count: 1 },
  })
  return { id }
}

async function publishFakeBundle(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  evidenceId: string,
  seeded: Awaited<ReturnType<typeof seedFrozenCandidate>>,
) {
  const root = await mkdtemp(join(tmpdir(), 'stars-phase-f-fake-'))
  await mkdir(join(root, 'frames'))
  const frameBytes = Buffer.from('fake-png')
  const relativePath = `frames/01-${seeded.assetId}.png`
  await writeFile(join(root, relativePath), frameBytes)
  const payload = {
    candidate_key: seeded.candidateKey,
    file_id: seeded.fileId,
    scene_id: seeded.sceneId,
    protocol_version: 'candidate-evidence-v1',
    strategy: 'all_indexed_frames_v1',
    frames: [
      {
        asset_id: seeded.assetId,
        frame_sha256: createHash('sha256').update(frameBytes).digest('hex'),
        relative_path: relativePath,
      },
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(payload))
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, manifestBytes)
  await db
    .update(candidateEvidence)
    .set({
      artifactPath: manifestPath,
      artifactSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    })
    .where((await import('drizzle-orm')).eq(candidateEvidence.id, evidenceId))
}
