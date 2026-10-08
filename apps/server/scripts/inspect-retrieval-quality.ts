/** 只读复核指定历史任务、素材版本和人工标注规模；不会重放模型或写生产数据库。 */
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
loadEnvFile('../../.env')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
const ids = ['c5f74a73-c716-4e63-b8b0-94edac8fa966', '6fda3200-d8eb-4166-8a5a-3f5d0119ebb0']
try {
  await pool.query('BEGIN READ ONLY')
  const runs = (await pool.query('select id,prompt,status,enforced_scope_json from agent_runs where id=any($1::uuid[])', [ids])).rows
  const steps = (await pool.query('select run_id,step_kind,status,external_call_status,output_json from agent_run_steps where run_id=any($1::uuid[]) order by created_at', [ids])).rows
  const candidates = (await pool.query('select id,run_id,candidate_key,file_id,file_generation,asset_id,scene_id,rank,retrieval_json from agent_run_candidates where run_id=any($1::uuid[]) order by run_id,rank', [ids])).rows
  const rankings = (await pool.query('select r.agent_run_id,r.status,r.external_call_status,r.total_tokens,r.estimated_cost_cny,r.billed_cost_cny,k.candidate_id,k.rerank_rank from agent_rerank_runs r left join agent_rerank_rankings k on k.rerank_run_id=r.id where r.agent_run_id=any($1::uuid[]) order by r.agent_run_id,k.rerank_rank', [ids])).rows
  const tables = (await pool.query("select table_name from information_schema.tables where table_schema='public' and (table_name like '%label%' or table_name like '%evaluation%') order by table_name")).rows
  const index = (await pool.query("select library_id,media_type,index_generation,index_status,count(*)::int from media_files where deleted_at is null group by library_id,media_type,index_generation,index_status order by library_id,media_type,index_generation")).rows
  const queries = (await pool.query('select q.*,v.status as version_status from evaluation_queries q join evaluation_versions v on v.id=q.version_id order by q.id')).rows
  const labels = (await pool.query('select c.query_id,c.candidate_key,c.file_id,c.file_generation,c.scene_id,j.relevance,j.unjudgeable,c.run_id from evaluation_judgments j join evaluation_candidates c on c.id=j.candidate_id')).rows
  await pool.query('COMMIT')
  await writeFile('../../.scratch/retrieval-quality/history.json', JSON.stringify({ runs, steps, candidates, rankings, tables, index, queries, labels }, null, 2))
  console.log(JSON.stringify({ found_runs: runs.map(r => ({ id: r.id, status: r.status })), candidate_counts: ids.map(id => ({ id, count: candidates.filter(c => c.run_id === id).length })), label_tables: tables }))
} finally { await pool.end() }
