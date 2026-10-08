/** 重跑冻结原文搜索以核对当前检索服务/索引顺序；只读、关闭外部扩展，不覆盖冻结快照。 */
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
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: 'false', QUERY_EXPANSION_PROVIDER: 'none' })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const db = drizzle(pool, { schema }) as unknown as Database
const search = new SearchService(db, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
const identities = (rows: any[]) => rows.map(row => [row.file_id, row.asset_id, row.scene_id ?? null])
try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint || settings.captionSearchEnabled !== frozen.models.caption_search)
    throw new Error('Frozen index or configuration changed')
  const cases = []
  for (const row of frozen.cases) {
    const current = await search.search(row.request)
    const matches = JSON.stringify(identities(current.results)) === JSON.stringify(identities(row.results))
    cases.push({ id: row.id, count: current.results.length, identities_match_in_order: matches,
      current_identities: identities(current.results) })
  }
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Index changed during verification')
  const report = { fingerprint: frozen.fingerprint, verified_at: new Date().toISOString(), cases,
    accepted: cases.every(row => row.identities_match_in_order), external_calls: 0,
    note: 'Current raw-query candidate order only; not semantic quality or full recall' }
  await writeFile(`${root}/current-index-verification.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ accepted: report.accepted, cases: cases.map(({ current_identities, ...row }) => row), external_calls: 0 }))
  if (!report.accepted) process.exitCode = 1
} finally { await pool.end() }
