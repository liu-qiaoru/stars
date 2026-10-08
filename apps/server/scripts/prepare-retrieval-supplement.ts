/** 零外发补搜预检：只读生产索引；查询由人工开发方案指定，不冒充GLM自主决策或质量通过。 */
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
import { selectRetrievalCandidatePlan } from '../src/agent/retrieval-selection.policy.js'
import { extendRetrievalReviewPool } from '../src/agent/retrieval-review-pool.js'
import { corpusFingerprint } from './retrieval-quality-corpus.js'

loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const frozen = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: 'false', QUERY_EXPANSION_PROVIDER: 'none' })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const db = drizzle(pool, { schema }) as unknown as Database
const search = new SearchService(db, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
const testCase = frozen.cases.find((row: any) => row.id === 'cat')
const key = (row: any) => row.scene_id ? `video:${row.scene_id}` : `image:${row.asset_id}`
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Frozen corpus changed')
  const baseline: string[] = testCase.results.map(key)
  const queries = [{ step_id: 'frozen-baseline', query: testCase.query, candidate_keys: baseline,
    ranks: baseline.map((candidate_key, index) => ({ candidate_key, rank: index + 1, sources: [] as string[] })) }]
  const observations: any[] = []
  // 这两个查询保留猫、趴卧动作和猫爬架上的位置关系；不是实际Agent必选动作。
  for (const [index, query] of ['小猫趴卧在猫爬架平台上', '猫趴在猫爬架顶层平台上'].entries()) {
    const step = `local-cat-gap-${index + 1}`
    const started = performance.now()
    const response = await search.search({ ...testCase.request, query })
    queries.push({ step_id: step, query, candidate_keys: response.results.map(key),
      ranks: response.results.map((row: any, i: number) => ({ candidate_key: key(row), rank: i + 1, sources: row.reasons })) })
    observations.push({ step_id: step, query, latency_ms: Math.round(performance.now() - started),
      results: response.results.map((row: any, i: number) => ({ candidate_key: key(row), file_id: row.file_id,
        asset_id: row.asset_id, scene_id: row.scene_id ?? null, media_type: row.media_type, rank: i + 1, sources: row.reasons })) })
  }
  const plan = selectRetrievalCandidatePlan({ query: testCase.query,
    scope: { search_scope: testCase.scope, media_types: testCase.request.media_types, library_ids: testCase.request.library_ids },
    baseline, queries, fingerprint: frozen.fingerprint, configuration_fingerprint: '', stop_reason: 'partial' }, { evaluation: true })
  const added = plan.candidate_keys.filter(candidate => !baseline.includes(candidate))
  const candidates = []
  for (const candidate of added) {
    const source = observations.find(row => row.results.some((hit: any) => hit.candidate_key === candidate))
    const hit = source.results.find((row: any) => row.candidate_key === candidate)
    const file = (await pool.query('select index_generation,library_id from media_files where id=$1 and deleted_at is null', [hit.file_id])).rows[0]
    if (!file) throw new Error('Local candidate changed')
    candidates.push({ candidate_key: candidate, file_id: hit.file_id, file_generation: file.index_generation,
      asset_id: hit.asset_id, scene_id: hit.scene_id, media_type: hit.media_type, library_id: file.library_id,
      source_step_id: source.step_id, source_query: source.query, rank: hit.rank, origin: 'local_search_preflight' })
  }
  const extension = { fingerprint: frozen.fingerprint, cases: [{ id: 'cat', original_query: testCase.query, candidates }] }
  const generations = new Map<string, number>((await pool.query('select id,index_generation from media_files where deleted_at is null')).rows.map(row => [row.id, row.index_generation]))
  extendRetrievalReviewPool(frozen.cases.map((row: any) => ({ id: row.id, query: row.query, scope: row.scope,
    media_types: row.request.media_types, library_ids: row.request.library_ids, candidate_keys: row.results.map(key) })), extension, frozen.fingerprint, generations)
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Corpus changed during preflight')
  // 保留真实Agent清单：本地预检不能覆盖未来真实来源，已有文件则必须人工检查差异。
  try { await readFile(`${root}/review-extension.json`); throw new Error('Existing extension must not be overwritten') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await writeFile(`${root}/review-extension.json`, JSON.stringify(extension, null, 2))
  await writeFile(`${root}/supplement-local-preflight.json`, JSON.stringify({ query: testCase.query, fingerprint: frozen.fingerprint,
    missing_condition: '趴在猫爬架上的动作与位置关系仍缺少支持；文字缺失不是反证',
    provenance: 'local_search_preflight_not_model_decision', observations, queries, selection: plan,
    baseline_candidate_keys: baseline, selected_new_candidates: added, external_calls: 0, quality_accepted: false }, null, 2))
  console.log(JSON.stringify({ local_searches: observations.length, selected_new_candidates: added.length, external_calls: 0, quality_accepted: false }))
} finally { await pool.end() }
