import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { vlmBlindCandidateReviewPacketSchema } from '@local-media-agent/shared/schemas'
import { Pool } from 'pg'
import {
  selectDiversePendingCandidates,
  type VlmBlindSelectionGroup,
} from '../evaluation/vlm-blind-candidate-diversity.js'

type CandidateRow = {
  source_candidate_id: string
  source_evaluation_run_id: string
  query_id: string
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

const groups = [
  'insufficient_evidence',
  'exact_match',
  'partial_relevance',
  'exclusion_hit',
  'missing_must_have',
] as const

/**
 * 从一次当前索引的 Evaluation 快照生成 5×12 的“待审核建议”。分组依据只是
 * RRF 名次、场景时长和可用帧数的确定性抽样，不是人工真值。脚本只读 PostgreSQL，
 * 不读文件路径/Caption/转录，不写 Qdrant，也不调用任何模型。
 */
async function main() {
  const [runId, outputPath] = process.argv.slice(2)
  if (!runId || !outputPath || !process.env.DATABASE_URL) {
    throw new Error('usage: <run-id> <output-path>; DATABASE_URL is required')
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const result = await pool.query<CandidateRow>(
      `select
         c.id as source_candidate_id,
         c.run_id as source_evaluation_run_id,
         c.query_id,
         q.query_text,
         c.candidate_key,
         c.file_id,
         c.scene_id,
         c.start_time_seconds,
         c.end_time_seconds,
         c.rrf_rank,
         c.current_rank,
         q.must_have_json as must_have,
         q.optional_json as optional,
         q.exclusions_json as exclusions,
         count(distinct vr.id) filter (where vr.status = 'indexed') as frame_count
       from evaluation_candidates c
       join evaluation_runs r on r.id = c.run_id
       join evaluation_queries q on q.id = c.query_id
       join media_files f on f.id = c.file_id
         and f.deleted_at is null
         and f.index_generation = c.file_generation
       join video_scenes s on s.id = c.scene_id
         and s.index_generation = c.file_generation
       left join media_assets a on a.scene_id = c.scene_id and a.asset_type = 'video_frame'
       left join vector_refs vr on vr.asset_id = a.id and vr.collection_name = 'video_frame_vectors'
       where c.run_id = $1
         and r.status in ('ready_for_labeling', 'labeled', 'reported')
         and c.primary_pool = true
         and c.media_type = 'video'
       group by c.id, q.id
       order by c.id`,
      [runId],
    )
    const rows = result.rows
    if (rows.length < 60) throw new Error(`run has only ${rows.length} eligible current candidates`)
    const slots = groups.flatMap((group) =>
      Array.from({ length: 12 }, (_, index) => ({
        proposalId: `phase-f-${group}-${String(index + 1).padStart(2, '0')}`,
        group,
      })),
    )
    const selected = selectDiversePendingCandidates({
      slots,
      candidates: rows.map((row) => ({
        candidateId: row.source_candidate_id,
        queryText: row.query_text,
        eligibleGroups: groups.filter((group) => groupPredicate(group, row)),
        stableOrder: stableKey('phase-f-diversity', row),
      })),
      reviewedCandidateIds: new Set(),
      reviewedQueryTexts: [],
      minimumUniqueQueries: 50,
      maxPairsPerQuery: 2,
    })
    const rowsById = new Map(rows.map((row) => [row.source_candidate_id, row]))
    const proposals = slots.map((slot) => {
      const choice = selected.get(slot.proposalId)
      const row = choice ? rowsById.get(choice.candidateId) : undefined
      if (!row) throw new Error(`slot ${slot.proposalId} has no selected candidate`)
      return {
        proposal_id: slot.proposalId,
        source_evaluation_run_id: row.source_evaluation_run_id,
        source_candidate_id: row.source_candidate_id,
        query_text: row.query_text,
        candidate_key: row.candidate_key,
        file_id: row.file_id,
        scene_id: row.scene_id,
        start_time_seconds: Number(row.start_time_seconds),
        end_time_seconds: Number(row.end_time_seconds),
        proposed_group: slot.group,
        selection_basis: selectionBasis(slot.group, row),
        conditions: conditionsFor(row),
      }
    })
    const packet = vlmBlindCandidateReviewPacketSchema.parse({
      schema_version: 'phase-f-vlm-candidate-review-v1',
      proposals,
    })
    await writeFile(resolve(outputPath), `${JSON.stringify(packet, null, 2)}\n`, 'utf8')
    process.stdout.write(`wrote ${packet.proposals.length} proposals to ${resolve(outputPath)}\n`)
  } finally {
    await pool.end()
  }
}

function groupPredicate(group: VlmBlindSelectionGroup, row: CandidateRow) {
  const rank = row.rrf_rank ?? row.current_rank ?? Number.MAX_SAFE_INTEGER
  const duration = Number(row.end_time_seconds) - Number(row.start_time_seconds)
  if (group === 'insufficient_evidence') return Number(row.frame_count) <= 2 || duration <= 2
  if (group === 'exact_match') return rank <= 4
  if (group === 'partial_relevance') return rank >= 5 && rank <= 10
  if (group === 'exclusion_hit') {
    return asTextArray(row.exclusions, 'exclusions').length > 0 && rank >= 8
  }
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

function asTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    // 生成器只能复制 PostgreSQL 中的冻结条件。异常 JSON 必须中止生成，不能把
    // 损坏字段静默变成空数组，否则导出的建议包会丢失用户约束。
    throw new Error(`frozen ${field} must be a string array`)
  }
  return value
}

function stableKey(group: string, row: CandidateRow) {
  return createHash('sha256')
    .update(`${group}:${row.query_id}:${row.source_candidate_id}`)
    .digest('hex')
}

function selectionBasis(group: VlmBlindSelectionGroup, row: CandidateRow) {
  const rank = row.rrf_rank ?? row.current_rank
  if (group === 'insufficient_evidence') {
    return `本地抽样建议：当前独立索引帧 ${row.frame_count} 张，场景时长 ${(Number(row.end_time_seconds) - Number(row.start_time_seconds)).toFixed(1)} 秒；需人工确认是否真的证据不足。`
  }
  return `本地抽样建议：RRF 名次 ${rank ?? '无'}；组别仅为候选分层，需人工播放后确认。`
}

await main()
