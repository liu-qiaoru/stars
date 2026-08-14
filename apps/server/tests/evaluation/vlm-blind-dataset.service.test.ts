import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  evaluationCandidates,
  evaluationQueries,
  evaluationRuns,
  evaluationSets,
  evaluationVersions,
  evaluationVlmBlindCases,
} from '../../src/database/schema.js'
import { VlmBlindDatasetService } from '../../src/evaluation/vlm-blind-dataset.service.js'
import { createTestDatabase } from '../database/test-db.js'

describe('Phase F VLM blind dataset service', () => {
  let context: Awaited<ReturnType<typeof createTestDatabase>>

  beforeEach(async () => {
    context = await createTestDatabase()
  })

  afterEach(async () => {
    await context.close()
  })

  test('imports 60 verified proposals and keeps candidate review separate from human labels', async () => {
    const packet = await seedProposalSources(context.db)
    const service = new VlmBlindDatasetService(context.db)

    const created = await service.importCandidateReviewPacket({
      name: 'Phase F 候选审核 1',
      packet,
    })

    expect(created.status).toBe('candidate_review')
    expect(created.summary).toEqual({
      pending: 60,
      accepted: 0,
      rejected: 0,
      historical_rejected: 0,
      historical_accepted: 0,
    })
    expect(created.cases).toHaveLength(60)
    expect(created.cases[0]!.human_labels).toEqual([])
  })

  test('concurrent imports reuse one fingerprint identity and create only 60 cases', async () => {
    const packet = await seedProposalSources(context.db)
    const service = new VlmBlindDatasetService(context.db)

    // 两个请求同时通过候选身份校验后，数据库的 proposal_fingerprint 唯一索引
    // 决定唯一胜者；失败的一方读取胜者，而不是再生成一套 60 对数据。
    const [first, second] = await Promise.all([
      service.importCandidateReviewPacket({ name: 'concurrent first', packet }),
      service.importCandidateReviewPacket({ name: 'concurrent second', packet }),
    ])

    expect(second.id).toBe(first.id)
    const datasetCount = await context.client.query<{ count: number }>(
      'select count(*)::int as count from evaluation_vlm_blind_datasets',
    )
    const caseCount = await context.client.query<{ count: number }>(
      'select count(*)::int as count from evaluation_vlm_blind_cases',
    )
    expect(datasetCount.rows[0]?.count).toBe(1)
    expect(caseCount.rows[0]?.count).toBe(60)
  })

  test('rejects a proposal whose frozen candidate identity was changed', async () => {
    const packet = await seedProposalSources(context.db)
    packet.proposals[0]!.candidate_key = 'video:invented'
    const service = new VlmBlindDatasetService(context.db)

    await expect(service.importCandidateReviewPacket({ name: 'invalid', packet })).rejects.toThrow(
      /identity/i,
    )
  })

  test('rejects malformed frozen condition JSON instead of treating it as an empty array', async () => {
    const packet = await seedProposalSources(context.db)
    // 复现历史风险：条件列仍是合法 jsonb，但不再是协议要求的 string[]。
    // 导入必须报告损坏字段，不能与使用相同降级逻辑的生成器一起漏掉该条件。
    await context.client.exec(`update evaluation_queries set must_have_json = '"broken"'::jsonb`)
    const service = new VlmBlindDatasetService(context.db)

    await expect(
      service.importCandidateReviewPacket({ name: 'malformed conditions', packet }),
    ).rejects.toThrow(/frozen must_have_json must be a string array/)
  })

  test('records accept, reject and group correction without freezing labels', async () => {
    const packet = await seedProposalSources(context.db)
    const service = new VlmBlindDatasetService(context.db)
    const dataset = await service.importCandidateReviewPacket({ name: 'review', packet })

    const afterAccept = await service.reviewCandidate(dataset.id, dataset.cases[0]!.id, {
      decision: 'accepted',
      reviewed_group: 'exclusion_hit',
      notes: '视频中明确命中排除条件',
    })
    const afterReject = await service.reviewCandidate(dataset.id, dataset.cases[1]!.id, {
      decision: 'rejected',
      notes: '场景边界不完整，需要替换',
    })

    expect(afterAccept.cases[0]).toMatchObject({
      review_status: 'accepted',
      reviewed_group: 'exclusion_hit',
    })
    expect(afterReject.summary).toEqual({
      pending: 58,
      accepted: 1,
      rejected: 1,
      historical_rejected: 0,
      historical_accepted: 0,
    })
    expect(afterReject.status).toBe('candidate_review')
  })

  test('creates a pending replacement without overwriting the rejected audit case', async () => {
    const packet = await seedProposalSources(context.db)
    const service = new VlmBlindDatasetService(context.db)
    const dataset = await service.importCandidateReviewPacket({ name: 'replacement', packet })
    const rejected = dataset.cases[0]!
    await service.reviewCandidate(dataset.id, rejected.id, { decision: 'rejected' })

    const [source] = await context.db.select().from(evaluationCandidates).limit(1)
    const [sourceQuery] = await context.db
      .select()
      .from(evaluationQueries)
      .where(eq(evaluationQueries.id, source!.queryId))
      .limit(1)
    const replacementQueryId = randomUUID()
    const replacementRunId = randomUUID()
    await context.db.insert(evaluationQueries).values({
      ...sourceQuery!,
      id: replacementQueryId,
      queryText: '全新的未拒绝查询文本',
    })
    await context.db.insert(evaluationRuns).values({
      id: replacementRunId,
      versionId: sourceQuery!.versionId,
      status: 'ready_for_labeling',
      libraryIdsJson: [],
      configJson: {},
    })
    const replacementCandidateId = randomUUID()
    const replacementSceneId = randomUUID()
    await context.db.insert(evaluationCandidates).values({
      ...source!,
      id: replacementCandidateId,
      runId: replacementRunId,
      queryId: replacementQueryId,
      candidateKey: `video:${replacementSceneId}`,
      assetId: randomUUID(),
      sceneId: replacementSceneId,
      rrfRank: 2,
      currentRank: 2,
      blindOrder: 100,
    })

    const replaced = await service.generateRejectedReplacements(dataset.id, replacementRunId)
    const historical = replaced.cases.find((item) => item.id === rejected.id)
    const replacement = replaced.cases.find(
      (item) => item.source_candidate_id === replacementCandidateId,
    )

    expect(historical).toMatchObject({ review_status: 'rejected', is_active: false })
    expect(replacement).toMatchObject({
      review_status: 'pending',
      is_active: true,
      replaces_case_id: rejected.id,
      query_text: '全新的未拒绝查询文本',
    })
    expect(
      replaced.cases.filter((item) => item.is_active).map((item) => item.query_text),
    ).not.toContain(rejected.query_text)
    expect(replaced.summary).toEqual({
      pending: 60,
      accepted: 0,
      rejected: 0,
      historical_rejected: 1,
      historical_accepted: 0,
    })

    await expect(
      service.reviewCandidate(dataset.id, rejected.id, {
        decision: 'accepted',
        reviewed_group: 'exact_match',
      }),
    ).rejects.toThrow(/superseded candidate case is read-only/)
    const afterRejectedReplay = await service.get(dataset.id)
    expect(afterRejectedReplay.cases.find((item) => item.id === rejected.id)).toMatchObject({
      review_status: 'rejected',
      is_active: false,
    })
  })

  test('discards every active case whose query text was ever rejected', async () => {
    const packet = await seedProposalSources(context.db)
    const [firstSource, secondSource] = await context.db
      .select()
      .from(evaluationCandidates)
      .orderBy(evaluationCandidates.blindOrder)
      .limit(2)
    const rejectedText = packet.proposals[0]!.query_text
    await context.db
      .update(evaluationQueries)
      .set({ queryText: rejectedText })
      .where(eq(evaluationQueries.id, secondSource!.queryId))
    packet.proposals[1]!.query_text = rejectedText

    const service = new VlmBlindDatasetService(context.db)
    const dataset = await service.importCandidateReviewPacket({ name: 'discard query', packet })
    await service.reviewCandidate(dataset.id, dataset.cases[1]!.id, {
      decision: 'accepted',
      reviewed_group: 'exact_match',
    })
    await service.reviewCandidate(dataset.id, dataset.cases[0]!.id, { decision: 'rejected' })

    for (const [index, source] of [firstSource!, secondSource!].entries()) {
      const queryId = randomUUID()
      await context.db.insert(evaluationQueries).values({
        id: queryId,
        versionId: (await context.db.select().from(evaluationQueries).limit(1))[0]!.versionId,
        queryText: `未拒绝替代查询 ${index + 1}`,
        queryType: 'discovery',
        searchScope: 'visual',
        intentCategory: 'visual',
        mustHaveJson: ['画面中有人'],
        optionalJson: [],
        exclusionsJson: ['人物没有走路'],
      })
      await context.db.insert(evaluationCandidates).values({
        ...source,
        id: randomUUID(),
        queryId,
        assetId: randomUUID(),
        sceneId: randomUUID(),
        candidateKey: `video:${randomUUID()}`,
        rrfRank: index + 1,
        currentRank: index + 1,
        blindOrder: 100 + index,
      })
    }

    const replaced = await service.generateRejectedReplacements(dataset.id)
    const active = replaced.cases.filter((item) => item.is_active)

    expect(active).toHaveLength(60)
    expect(active.map((item) => item.query_text)).not.toContain(rejectedText)
    expect(active.filter((item) => item.review_status === 'pending')).toHaveLength(60)
    expect(replaced.summary.historical_rejected).toBe(1)
    expect(replaced.summary.historical_accepted).toBe(1)
  })

  test('freezes an accepted balanced candidate pool with one stable fingerprint', async () => {
    const packet = await seedProposalSources(context.db)
    const service = new VlmBlindDatasetService(context.db)
    const dataset = await service.importCandidateReviewPacket({
      name: 'freeze candidate pool',
      packet,
    })
    await context.db
      .update(evaluationVlmBlindCases)
      .set({
        reviewStatus: 'accepted',
        reviewedGroup: sql`proposed_group`,
        reviewedAt: new Date(),
      })
      .where(eq(evaluationVlmBlindCases.datasetId, dataset.id))

    const frozen = await service.freezeCandidateReview(dataset.id)
    const repeated = await service.freezeCandidateReview(dataset.id)

    expect(frozen.status).toBe('frozen')
    expect(frozen.frozen_fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(repeated.frozen_fingerprint).toBe(frozen.frozen_fingerprint)
    await expect(
      service.reviewCandidate(dataset.id, frozen.cases[0]!.id, {
        decision: 'rejected',
      }),
    ).rejects.toThrow(/candidate review is already closed/)
  })
})

async function seedProposalSources(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const setId = randomUUID()
  const versionId = randomUUID()
  const runId = randomUUID()
  await db.insert(evaluationSets).values({ id: setId, name: 'Phase F source' })
  await db
    .insert(evaluationVersions)
    .values({ id: versionId, setId, version: 1, status: 'frozen', frozenAt: new Date() })
  await db.insert(evaluationRuns).values({
    id: runId,
    versionId,
    // Phase F 候选审核发生在条件真值标注之前；只要候选召回已原子冻结，
    // ready_for_labeling 就是合法输入，不应强迫用户先完成无关的检索等级标注。
    status: 'ready_for_labeling',
    libraryIdsJson: [],
    configJson: {},
  })
  const groups = [
    'exact_match',
    'missing_must_have',
    'exclusion_hit',
    'partial_relevance',
    'insufficient_evidence',
  ] as const
  const queryRows = groups.flatMap((_, groupIndex) =>
    Array.from({ length: 12 }, (_, itemIndex) => {
      const ordinal = groupIndex * 12 + itemIndex + 1
      return {
        id: randomUUID(),
        versionId,
        queryText: `冻结查询文本 ${ordinal}`,
        queryType: 'discovery' as const,
        searchScope: 'visual' as const,
        intentCategory: 'visual',
        mustHaveJson: ['画面中有人'],
        optionalJson: [],
        exclusionsJson: ['人物没有走路'],
      }
    }),
  )
  await db.insert(evaluationQueries).values(queryRows)
  const proposals = groups.flatMap((group, groupIndex) =>
    Array.from({ length: 12 }, (_, itemIndex) => {
      const sourceCandidateId = randomUUID()
      const fileId = randomUUID()
      const sceneId = randomUUID()
      const ordinal = groupIndex * 12 + itemIndex + 1
      const query = queryRows[ordinal - 1]!
      return {
        source: {
          id: sourceCandidateId,
          runId,
          queryId: query.id,
          candidateKey: `video:${sceneId}`,
          assetId: randomUUID(),
          fileId,
          sceneId,
          fileGeneration: 0,
          mediaType: 'video',
          startTimeSeconds: String(ordinal),
          endTimeSeconds: String(ordinal + 2),
          sourceEvidenceJson: [],
          currentRank: ordinal,
          rrfRank: ordinal,
          blindOrder: ordinal,
          labelStatus: 'judged',
        },
        proposal: {
          proposal_id: `phase-f-${ordinal.toString().padStart(2, '0')}`,
          source_evaluation_run_id: runId,
          source_candidate_id: sourceCandidateId,
          query_text: query.queryText,
          candidate_key: `video:${sceneId}`,
          file_id: fileId,
          scene_id: sceneId,
          start_time_seconds: ordinal,
          end_time_seconds: ordinal + 2,
          proposed_group: group,
          selection_basis: 'deterministic local proposal; human review required',
          conditions: [
            { condition_id: 'must-1', kind: 'must_have' as const, source_text: '画面中有人' },
            {
              condition_id: 'exclusion-1',
              kind: 'exclusion' as const,
              source_text: '人物没有走路',
            },
          ],
        },
      }
    }),
  )
  await db.insert(evaluationCandidates).values(proposals.map((item) => item.source))
  return {
    schema_version: 'phase-f-vlm-candidate-review-v1' as const,
    proposals: proposals.map((item) => item.proposal),
  }
}
