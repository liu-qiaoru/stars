import { createHash, randomUUID } from 'node:crypto'
import { vlmBlindCandidateReviewPacketSchema } from '@local-media-agent/shared/schemas'
import { Pool, type PoolClient } from 'pg'
import {
  assertFreshQueriesDoNotOverlapHistory,
  selectDiversePendingCandidates,
  type DiversityCandidate,
  type VlmBlindSelectionGroup,
} from '../evaluation/vlm-blind-candidate-diversity.js'
import { commitThenPublishPreparedJson, prepareAtomicJsonPublish } from './atomic-json-publish.js'

type CandidateRow = {
  candidate_id: string
  run_id: string
  query_text: string
  candidate_key: string
  file_id: string
  scene_id: string
  start_time_seconds: string
  end_time_seconds: string
  rrf_rank: number | null
  current_rank: number | null
  must_have: unknown
  optional: unknown
  exclusions: unknown
  frame_count: string
}

type CaseRow = {
  id: string
  proposal_id: string
  source_evaluation_run_id: string
  source_candidate_id: string
  query_text: string
  candidate_key: string
  file_id: string
  scene_id: string
  start_time_seconds: string
  end_time_seconds: string
  proposed_group: VlmBlindSelectionGroup
  review_status: 'pending' | 'accepted' | 'rejected'
  selection_basis: string
}

type ConditionRow = {
  case_id: string
  condition_id: string
  kind: 'must_have' | 'optional' | 'exclusion'
  source_text: string
}

type HistoricalQueryRow = {
  query_text: string
}

/**
 * 本地维护工具：保留所有已审核 Phase F 案例，只用一个新的 Evaluation run
 * 替换 pending 案例。新 run 必须恰好提供 30 条未在已审核案例中出现的新查询，
 * 且每条查询只进入一个待审核槽位。事务提交后同步更新静态候选包，便于重建环境。
 * 它只读 Evaluation/PostgreSQL 事实，不读取图片或视频，也没有 Provider 调用能力。
 */
async function main() {
  const [datasetId, sourceRunId, outputPath] = process.argv.slice(2)
  if (!datasetId || !sourceRunId || !outputPath || !process.env.DATABASE_URL) {
    throw new Error(
      'usage: <dataset-id> <fresh-source-run-id> <output-path>; DATABASE_URL is required',
    )
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  let commitStarted = false
  let prepared: Awaited<ReturnType<typeof prepareAtomicJsonPublish>> | undefined
  try {
    await client.query('begin')
    const packet = await refreshPendingCases(client, datasetId, sourceRunId)
    // 先在目标同目录写完并读回校验，再提交 PostgreSQL。这样文件系统错误发生时
    // 数据库仍可回滚，静态包也继续保留旧的完整版本。
    prepared = await prepareAtomicJsonPublish(outputPath, `${JSON.stringify(packet, null, 2)}\n`)
    commitStarted = true
    await commitThenPublishPreparedJson({
      commit: async () => {
        await client.query('commit')
      },
      publish: () => prepared!.publish(),
      temporaryPath: prepared.temporaryPath,
    })
    process.stdout.write(
      `refreshed ${packet.proposals.length} pairs with ${new Set(packet.proposals.map((item) => item.query_text)).size} unique queries\n`,
    )
  } catch (error) {
    if (!commitStarted) {
      await client.query('rollback')
      await prepared?.discard()
      throw error
    }
    // COMMIT 发出后无论得到明确成功还是连接中断，都不能再 rollback 或删除恢复文件。
    // commitThenPublishPreparedJson 已区分“结果未知”和“已提交但发布失败”。
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function refreshPendingCases(client: PoolClient, datasetId: string, sourceRunId: string) {
  const datasetResult = await client.query<{ id: string; status: string }>(
    `select id, status from evaluation_vlm_blind_datasets where id = $1 for update`,
    [datasetId],
  )
  const dataset = datasetResult.rows[0]
  if (!dataset) throw new Error('VLM blind dataset not found')
  if (dataset.status !== 'candidate_review') throw new Error('candidate review is already closed')

  const caseResult = await client.query<CaseRow>(
    `select id, proposal_id, source_evaluation_run_id, source_candidate_id, query_text,
            candidate_key, file_id, scene_id, start_time_seconds, end_time_seconds,
            proposed_group, review_status, selection_basis
       from evaluation_vlm_blind_cases
      where dataset_id = $1
      order by proposal_id
      for update`,
    [datasetId],
  )
  if (caseResult.rows.length !== 60) throw new Error('dataset must contain exactly 60 cases')
  const cases = caseResult.rows
  const candidateResult = await client.query<CandidateRow>(candidateSql, [sourceRunId])
  const candidates = candidateResult.rows
  const candidateById = new Map(candidates.map((item) => [item.candidate_id, item]))
  const reviewed = cases.filter((item) => item.review_status !== 'pending')
  const pending = cases.filter((item) => item.review_status === 'pending')
  if (pending.length !== 30) {
    throw new Error(
      `fresh query refresh requires exactly 30 pending cases; received ${pending.length}`,
    )
  }
  const freshQueryTexts = new Set(candidates.map((item) => item.query_text))
  if (freshQueryTexts.size !== pending.length) {
    throw new Error(
      `fresh Evaluation run must contain ${pending.length} distinct queries; received ${freshQueryTexts.size}`,
    )
  }
  // 新 run 自己的 version 当然包含这 30 条文本，因此只排除该 version；其他 draft、
  // frozen 和历史 run 的查询全部属于“旧 Evaluation”，即使从未进入人工审核也不能复用。
  const historicalQueryResult = await client.query<HistoricalQueryRow>(
    `select distinct q.query_text
       from evaluation_queries q
      where q.version_id <> (
        select r.version_id from evaluation_runs r where r.id = $1
      )`,
    [sourceRunId],
  )
  assertFreshQueriesDoNotOverlapHistory(
    freshQueryTexts,
    historicalQueryResult.rows.map((item) => item.query_text),
  )
  const reviewedQueryTexts = new Set(reviewed.map((item) => item.query_text))

  const diversityCandidates: DiversityCandidate[] = candidates.map((candidate) => ({
    candidateId: candidate.candidate_id,
    queryText: candidate.query_text,
    eligibleGroups: groups.filter((group) => groupPredicate(group, candidate)),
    stableOrder: createHash('sha256')
      .update(`${candidate.query_text}:${candidate.candidate_id}`)
      .digest('hex'),
  }))
  const selected = selectDiversePendingCandidates({
    slots: pending.map((item) => ({ proposalId: item.proposal_id, group: item.proposed_group })),
    candidates: diversityCandidates,
    reviewedCandidateIds: new Set(reviewed.map((item) => item.source_candidate_id)),
    // 候选池只来自新的 run，因此这里不把旧查询计入匹配配额；最终包校验会把
    // 已审核事实与新选择合并统计。max=1 强制 30 个 pending 各自使用不同新查询。
    reviewedQueryTexts: [],
    minimumUniqueQueries: pending.length,
    maxPairsPerQuery: 1,
  })
  const selectedQueryTexts = new Set([...selected.values()].map((item) => item.queryText))
  if (selectedQueryTexts.size !== pending.length) {
    throw new Error('fresh candidate selection did not preserve one query per pending case')
  }

  for (const pendingCase of pending) {
    const choice = selected.get(pendingCase.proposal_id)
    const candidate = choice ? candidateById.get(choice.candidateId) : undefined
    if (!candidate)
      throw new Error(`pending proposal ${pendingCase.proposal_id} has no replacement`)
    await client.query(
      `update evaluation_vlm_blind_cases
          set source_evaluation_run_id = $1, source_candidate_id = $2, query_text = $3,
              candidate_key = $4, file_id = $5, scene_id = $6,
              start_time_seconds = $7, end_time_seconds = $8, selection_basis = $9,
              updated_at = now()
        where id = $10 and review_status = 'pending'`,
      [
        candidate.run_id,
        candidate.candidate_id,
        candidate.query_text,
        candidate.candidate_key,
        candidate.file_id,
        candidate.scene_id,
        candidate.start_time_seconds,
        candidate.end_time_seconds,
        selectionBasis(pendingCase.proposed_group, candidate),
        pendingCase.id,
      ],
    )
    await client.query(`delete from evaluation_vlm_blind_conditions where case_id = $1`, [
      pendingCase.id,
    ])
    for (const [ordinal, condition] of conditionsFor(candidate).entries()) {
      await client.query(
        `insert into evaluation_vlm_blind_conditions
          (id, case_id, condition_id, kind, source_text, ordinal)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          pendingCase.id,
          condition.condition_id,
          condition.kind,
          condition.source_text,
          ordinal,
        ],
      )
    }
  }

  const packet = await readPacket(client, datasetId)
  const queryCounts = countValues(packet.proposals.map((item) => item.query_text))
  const expectedUniqueQueries = reviewedQueryTexts.size + pending.length
  if (
    queryCounts.size !== expectedUniqueQueries ||
    [...queryCounts.values()].some((count) => count > 2)
  ) {
    throw new Error(
      `refreshed packet does not satisfy ${expectedUniqueQueries} unique queries with a maximum of two reviewed pairs`,
    )
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(packet)).digest('hex')
  await client.query(
    `update evaluation_vlm_blind_datasets
        set proposal_fingerprint = $1, updated_at = now()
      where id = $2`,
    [fingerprint, datasetId],
  )
  return packet
}

async function readPacket(client: PoolClient, datasetId: string) {
  const cases = (
    await client.query<CaseRow>(
      `select id, proposal_id, source_evaluation_run_id, source_candidate_id, query_text,
              candidate_key, file_id, scene_id, start_time_seconds, end_time_seconds,
              proposed_group, review_status, selection_basis
         from evaluation_vlm_blind_cases where dataset_id = $1 order by proposal_id`,
      [datasetId],
    )
  ).rows
  const conditions = (
    await client.query<ConditionRow>(
      `select c.case_id, c.condition_id, c.kind, c.source_text
         from evaluation_vlm_blind_conditions c
         join evaluation_vlm_blind_cases v on v.id = c.case_id
        where v.dataset_id = $1 order by c.case_id, c.ordinal`,
      [datasetId],
    )
  ).rows
  return vlmBlindCandidateReviewPacketSchema.parse({
    schema_version: 'phase-f-vlm-candidate-review-v1',
    proposals: cases.map((item) => ({
      proposal_id: item.proposal_id,
      source_evaluation_run_id: item.source_evaluation_run_id,
      source_candidate_id: item.source_candidate_id,
      query_text: item.query_text,
      candidate_key: item.candidate_key,
      file_id: item.file_id,
      scene_id: item.scene_id,
      start_time_seconds: Number(item.start_time_seconds),
      end_time_seconds: Number(item.end_time_seconds),
      proposed_group: item.proposed_group,
      selection_basis: item.selection_basis,
      conditions: conditions
        .filter((condition) => condition.case_id === item.id)
        .map(({ condition_id, kind, source_text }) => ({ condition_id, kind, source_text })),
    })),
  })
}

const groups: VlmBlindSelectionGroup[] = [
  'exact_match',
  'missing_must_have',
  'exclusion_hit',
  'partial_relevance',
  'insufficient_evidence',
]

function groupPredicate(group: VlmBlindSelectionGroup, row: CandidateRow) {
  const rank = row.rrf_rank ?? row.current_rank ?? Number.MAX_SAFE_INTEGER
  const duration = Number(row.end_time_seconds) - Number(row.start_time_seconds)
  if (group === 'insufficient_evidence') return Number(row.frame_count) <= 2 || duration <= 2
  if (group === 'exact_match') return rank <= 4
  if (group === 'partial_relevance') return rank >= 5 && rank <= 10
  if (group === 'exclusion_hit')
    return asTextArray(row.exclusions, 'exclusions').length > 0 && rank >= 8
  return rank >= 8
}

function conditionsFor(row: CandidateRow) {
  return [
    ...asTextArray(row.must_have, 'must_have').map((source_text, index) => ({
      condition_id: `must-${index + 1}`,
      kind: 'must_have' as const,
      source_text,
    })),
    ...asTextArray(row.optional, 'optional').map((source_text, index) => ({
      condition_id: `optional-${index + 1}`,
      kind: 'optional' as const,
      source_text,
    })),
    ...asTextArray(row.exclusions, 'exclusions').map((source_text, index) => ({
      condition_id: `exclusion-${index + 1}`,
      kind: 'exclusion' as const,
      source_text,
    })),
  ]
}

function selectionBasis(group: VlmBlindSelectionGroup, row: CandidateRow) {
  const rank = row.rrf_rank ?? row.current_rank
  if (group === 'insufficient_evidence') {
    return `本地抽样建议：当前独立索引帧 ${row.frame_count} 张，场景时长 ${(Number(row.end_time_seconds) - Number(row.start_time_seconds)).toFixed(1)} 秒；需人工确认是否真的证据不足。`
  }
  return `本地抽样建议：RRF 名次 ${rank ?? '无'}；组别仅为候选分层，需人工播放后确认。`
}

function asTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`frozen ${field} must be a string array`)
  }
  return value
}

function countValues(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

const candidateSql = `select
  c.id as candidate_id, c.run_id, q.query_text, c.candidate_key, c.file_id, c.scene_id,
  c.start_time_seconds, c.end_time_seconds, c.rrf_rank, c.current_rank,
  q.must_have_json as must_have, q.optional_json as optional, q.exclusions_json as exclusions,
  count(distinct vr.id) filter (where vr.status = 'indexed') as frame_count
from evaluation_candidates c
join evaluation_runs r on r.id = c.run_id
join evaluation_queries q on q.id = c.query_id
join media_files f on f.id = c.file_id and f.deleted_at is null and f.index_generation = c.file_generation
join video_scenes s on s.id = c.scene_id and s.index_generation = c.file_generation
left join media_assets a on a.scene_id = c.scene_id and a.asset_type = 'video_frame'
left join vector_refs vr on vr.asset_id = a.id and vr.collection_name = 'video_frame_vectors'
where c.run_id = $1 and r.status in ('ready_for_labeling', 'labeled', 'reported')
  and c.primary_pool = true and c.media_type = 'video'
group by c.id, q.id order by c.id`

await main()
