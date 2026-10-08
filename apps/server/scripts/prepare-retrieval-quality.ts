/**
 * 冻结本次验收的真实只读搜索结果、索引身份和可复用标签。不会创建生产任务、改索引或外发。
 * 该快照供隔离 PGlite 执行链验收使用；素材路径仅留在当前进程，不写进报告。
 */
import { corpusFingerprint } from './retrieval-quality-corpus.js'
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { writeFile, readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { QdrantClient } from '@qdrant/js-client-rest'
import { createSettings } from '../src/config/settings.js'
import * as schema from '../src/database/schema.js'
import { SearchService } from '../src/search/search.service.js'
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service.js'
import { SearchQueryVectorService } from '../src/search/search-query-vector.service.js'
import { QueryExpansionService } from '../src/search/query-expansion.service.js'
import type { Database } from '../src/database/repositories.js'
loadEnvFile('../../.env')
const settings = createSettings(process.env)
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const db = drizzle(pool, { schema }) as unknown as Database
const search = new SearchService(db, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)

const definitions = [
  { id: 'cat', query: '小猫趴在猫爬架上', category: 'action_and_position', scope: 'visual' },
  { id: 'action', query: '有人用筷子从分格餐盒里夹食物', category: 'action', scope: 'visual' },
  { id: 'position', query: '人物旁边挂着衣服', category: 'position', scope: 'visual' },
  { id: 'exclusion', query: '有人在厨房灶台前操作，不要空厨房', category: 'exclusion', scope: 'visual' },
  { id: 'multi', query: '戴白色耳机的人坐在绿色沙发上抱臂', category: 'multiple_conditions', scope: 'visual' },
  { id: 'empty', query: 'qxacceptanceempty20261005', category: 'empty_result', scope: 'spoken' },
] as const
try {
  const fingerprint = await corpusFingerprint(pool)
  const history = JSON.parse(await readFile('../../.scratch/retrieval-quality/history.json', 'utf8'))
  const cases = []
  for (const definition of definitions) {
    const query = history.queries.find((item: any) => item.query_text === definition.query && item.version_status === 'frozen')
    const labels = history.labels.filter((item: any) => item.query_id === query?.id && !item.unjudgeable && item.relevance !== null)
    const request = { query: definition.query, search_scope: definition.scope,
      media_types: definition.scope === 'spoken' ? ['video', 'audio'] as const : ['image', 'video'] as const,
      library_ids: [], limit: 20, offset: 0, query_expansion_mode: 'original' as const, ranking_mode: 'rrf' as const, include_diagnostics: false }
    const started = performance.now()
    const result = await search.search({ ...request, media_types: [...request.media_types] })
    cases.push({ ...definition, request, results: result.results, latency_ms: Math.round(performance.now() - started),
      source_query_id: query?.id ?? null, target: query?.target_scene_id ? `video:${query.target_scene_id}` : null,
      reusable_labels: labels, label_provenance: 'existing_evaluation_judgments_requires_human_confirmation' })
    console.log(JSON.stringify({ case_id: definition.id, candidates: result.results.length, reusable_label_rows: labels.length }))
  }
  if (fingerprint !== await corpusFingerprint(pool)) throw new Error('Index changed during freeze; no accepted snapshot')
  const snapshot = { protocol: 'retrieval-quality-v2', fingerprint, frozen_at: new Date().toISOString(),
    models: { caption_search: settings.captionSearchEnabled, query_expansion: 'original', ranking: 'rrf', initial_limit: 20 }, cases }
  await writeFile('../../.scratch/retrieval-quality/frozen.json', JSON.stringify(snapshot, null, 2))
} finally { await pool.end() }
