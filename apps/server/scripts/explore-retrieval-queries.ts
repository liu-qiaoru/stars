/** 用户要求尝试其他词条的零外发预检。
 * 生产数据库只读，搜索只调用本地向量模型与Qdrant；不创建Agent任务、不改冻结验收集。
 * 新查询不能继承旧查询的人工相关性标签。描述关键词缺失仅记为不确定，绝不标不相关。
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
const root = '../../.scratch/deepseek-matched-retrieval'
const frozen = JSON.parse(await readFile('../../.scratch/retrieval-quality/frozen.json', 'utf8'))
const extension = JSON.parse(await readFile('../../.scratch/retrieval-quality/review-extension.json', 'utf8'))
const approved = new Set<string>([...frozen.cases.flatMap((c: any) => c.results.map(key)), ...extension.cases.flatMap((c: any) => c.candidates.map((r: any) => r.candidate_key))])
const definitions = [
  { id: 'cat-floor', query: '小猫趴在地板上，猫爬架在它旁边', probe: '地板上趴卧的小猫，旁边有猫爬架',
    clues: [{ condition: '地板上的位置', words: ['地板', '地面'] }, { condition: '趴卧动作', words: ['趴', '卧', '躺'] }] },
  { id: 'sofa-phone', query: '戴白色耳机的人坐在绿色沙发上，手里拿着手机，不要抱臂', probe: '坐在绿色沙发、戴白色耳机的人拿着手机，排除双臂交叉',
    clues: [{ condition: '拿手机', words: ['手机'] }, { condition: '排除抱臂', words: ['抱臂', '交叉'] }] },
  { id: 'stove-stirring', query: '有人在厨房里搅拌灶台上的锅，不要只有餐桌或空厨房', probe: '有人在厨房搅拌炉灶上的锅，排除只有餐桌或无人的厨房',
    clues: [{ condition: '搅拌动作', words: ['搅拌', '翻炒'] }, { condition: '灶台', words: ['灶台', '炉灶', '炉子'] }] },
  { id: 'dumpling-chopsticks', query: '有人用筷子夹起饺子，饺子还没有送入口中', probe: '有人用筷子夹着饺子，未送入口中',
    clues: [{ condition: '饺子', words: ['饺子'] }, { condition: '筷子夹起', words: ['筷子'] }] },
] as const
// original显式跳过外部扩展；再关闭外部总开关，避免实验意外继承生产外发配置。
const settings = createSettings({ ...process.env, ALLOW_EXTERNAL_LLM: 'false', QUERY_EXPANSION_PROVIDER: 'none' })
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 })
const db = drizzle(pool, { schema }) as unknown as Database
const search = new SearchService(db, new QdrantClient({ url: settings.qdrantUrl, checkCompatibility: false }),
  new SearchQueryVectorService(new ModelGatewayService(settings)), new QueryExpansionService(settings), settings)
function key(row: any): string { return row.scene_id ? `video:${row.scene_id}` : `image:${row.asset_id}` }

try {
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Frozen corpus changed; stop exploration')
  await writeFile(`${root}/new-query-plan.json`, JSON.stringify({ purpose: 'local_query_exploration_not_agent_decision',
    maximum_local_searches: 8, maximum_results_per_search: 20, maximum_external_calls: 0,
    fingerprint: frozen.fingerprint, definitions, no_old_label_reuse_for_changed_query: true }, null, 2), { flag: 'wx' })
  const cases = []
  for (const definition of definitions) {
    const observations = []
    for (const query of [definition.query, definition.probe]) {
      const start = performance.now()
      const result = await search.search({ query, search_scope: 'visual', media_types: ['image', 'video'], library_ids: [],
        limit: 20, offset: 0, query_expansion_mode: 'original', ranking_mode: 'rrf', include_diagnostics: false })
      const results = []
      for (const [index, hit] of result.results.entries()) {
        // SearchService同时支持旧混排与RRF；只有RRF响应拥有逐通道实际命中身份。
        const sourceMatches = 'source_matches' in hit ? hit.source_matches : []
        const sourceIds = sourceMatches?.filter(row => row.source !== 'vector_match').map(row => row.asset_id) ?? []
        const assetRows = sourceIds.length ? (await pool.query('select id,text_content from media_assets where id=any($1::uuid[])', [sourceIds])).rows : []
        // 正文只保存有界本地审核副本，不进入普通日志。没有文字不推断画面没有条件。
        const previews = assetRows.slice(0, 2).map(row => ({ asset_id: row.id, preview: [...(row.text_content ?? '')].slice(0, 240).join('') }))
        results.push({ candidate_key: key(hit), rank: index + 1, file_id: hit.file_id, asset_id: hit.asset_id, scene_id: hit.scene_id,
          source_matches: sourceMatches, sources: hit.reasons, in_prior_media_approved_pool: approved.has(key(hit)),
          local_text_previews: previews, lexical_clues_only: definition.clues.map(clue => ({ condition: clue.condition,
            mentioned: previews.some(row => clue.words.some(word => row.preview.includes(word))), semantic_status: 'not_judged' })) })
      }
      observations.push({ query, latency_ms: Math.round(performance.now() - start), results })
    }
    const base = observations[0]!, probe = observations[1]!
    const baseKeys = base.results.map(row => row.candidate_key), probeKeys = probe.results.map(row => row.candidate_key)
    const report = { ...definition, observations, proposed_probe_origin: 'developer_local_query_not_autonomous_model',
      added: probeKeys.filter(id => !baseKeys.includes(id)), lost: baseKeys.filter(id => !probeKeys.includes(id)),
      rank_changes: baseKeys.filter(id => probeKeys.includes(id)).map(id => ({ candidate_key: id, baseline_rank: baseKeys.indexOf(id) + 1, probe_rank: probeKeys.indexOf(id) + 1 })),
      human_labels: null, quality_accepted: false }
    cases.push(report)
    console.log(JSON.stringify({ id: definition.id, baseline: baseKeys.length, probe: probeKeys.length, added: report.added.length,
      outside_prior_approved_pool: base.results.filter(row => !row.in_prior_media_approved_pool).length, external_calls: 0 }))
  }
  if (await corpusFingerprint(pool) !== frozen.fingerprint) throw new Error('Corpus changed during exploration')
  await writeFile(`${root}/new-query-results.json`, JSON.stringify({ fingerprint: frozen.fingerprint, external_calls: 0, local_searches: 8,
    fixed_acceptance_suite_unchanged: true, truth: 'not_labelled_for_these_new_queries', quality_accepted: false, cases }, null, 2), { flag: 'wx' })
} finally { await pool.end() }
