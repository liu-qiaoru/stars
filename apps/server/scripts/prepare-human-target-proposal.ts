/**
 * 只读核对用户已描述的目标能否构成额外验收用例，不激活第七查询、不外发。
 * 原六查询及104条标签保持。新查询的相关性不能复用旧查询等级，缺失保持未标注。
 */
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { QdrantClient } from '@qdrant/js-client-rest'
import { createSettings } from '../src/config/settings.js'
import * as schema from '../src/database/schema.js'
import type { Database } from '../src/database/repositories.js'
import { SearchService } from '../src/search/search.service.js'
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service.js'
import { SearchQueryVectorService } from '../src/search/search-query-vector.service.js'
import { QueryExpansionService } from '../src/search/query-expansion.service.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'

loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const human = JSON.parse(await readFile(`${root}/human-evidence-clarification-2026-10-06.json`, 'utf8'))
const audit = JSON.parse(await readFile(`${root}/exclusion-review-identity-audit.json`, 'utf8'))
const target = audit.items.find((item: any) => item.review_id === 'exclusion-7')?.candidate_key
const explanation = human.explanations.find((item: any) => item.review_id === 'exclusion-7')?.explanation
if (!target || !explanation || human.labels_changed !== false) throw new Error('Human target source missing')
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: 'false', QUERY_EXPANSION_PROVIDER: 'none' })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on' })
const db = drizzle(pool, { schema }) as unknown as Database
const search = new SearchService(db, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Frozen corpus changed')
  const scope = frozen.cases.find((item: any) => item.id === 'exclusion').request
  const approvedFiles = new Set(frozen.cases.flatMap((item: any) => item.results.map((hit: any) => hit.file_id)))
  const observations = []
  // 原句来自用户已核验的动作与人物；同义试搜不加入筷子、红色或厨房等新要求。
  for (const query of ['穿毛衣的人从锅里盛饺子', '穿毛衣的人从锅中盛出饺子']) {
    const response = await search.search({ ...scope, query, query_expansion_mode: 'original', ranking_mode: 'rrf', limit: 20 })
    const results = response.results.map((hit, index) => ({ candidate_key: `video:${hit.scene_id}`,
      file_id: hit.file_id, asset_id: hit.asset_id, scene_id: hit.scene_id, rank: index + 1, sources: hit.reasons,
      file_in_original_frozen_materials: approvedFiles.has(hit.file_id) }))
    observations.push({ query, target_rank: results.find(hit => hit.candidate_key === target)?.rank ?? null, results })
  }
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Corpus changed during proposal')
  await writeFile(`${root}/human-target-proposal.json`, JSON.stringify({ status: 'proposal_only_not_authorized_for_dispatch',
    fingerprint: frozen.fingerprint, source: 'direct_human_observation_not_model_label', source_review_id: 'exclusion-7',
    human_explanation: explanation, target, observations, original_six_cases_unchanged: true,
    grades_assigned: 0, labels_changed: false, external_calls: 0,
    limitation: 'Local queries do not prove GLM will search autonomously; old query grades cannot label this new query.' }, null, 2))
  console.log(JSON.stringify({ external_calls: 0, grades_assigned: 0,
    observations: observations.map(row => ({ count: row.results.length, target_rank: row.target_rank,
      outside_frozen_files: row.results.filter(hit => !hit.file_in_original_frozen_materials).length })) }))
} finally { await pool.end() }
