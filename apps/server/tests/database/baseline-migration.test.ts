import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, test } from 'vitest'

let client: PGlite | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

describe('database migration chain', () => {
  test('keeps the Phase 7 baseline immutable and appends the Agent V1 Phase A migration', async () => {
    const migrationFiles = (await readdir(resolve('drizzle')))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    const metadataFiles = (await readdir(resolve('drizzle/meta'))).sort()

    expect(migrationFiles).toEqual(['0000_final_baseline.sql', '0001_agent_v1_phase_a.sql'])
    expect(metadataFiles).toEqual(['0000_snapshot.json', '0001_snapshot.json', '_journal.json'])
    const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      '0000_final_baseline',
      '0001_agent_v1_phase_a',
    ])

    const sql = await readFile(resolve('drizzle', migrationFiles[0]!), 'utf8')
    expect(sql).not.toMatch(
      /\bocr\b|video_segment|video_segment_vectors|verify_multi_frame_search/i,
    )
    expect(sql).toContain('CREATE TABLE "video_scenes"')
    expect(sql).toContain('CREATE TABLE "evaluation_candidates"')
    expect(sql).toContain('GENERATED ALWAYS AS (to_tsvector')
    expect(sql).toContain('USING gin ("text_tsv")')
    expect(sql).toContain(
      'CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","priority" DESC NULLS LAST,"created_at")',
    )
  })

  test('creates the final 15-table schema directly in a fresh PGlite database', async () => {
    client = new PGlite()
    const sql = await readFile(resolve('drizzle/0000_final_baseline.sql'), 'utf8')
    await client.exec(sql)

    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'agent_run_events',
      'agent_runs',
      'agent_tool_calls',
      'evaluation_candidates',
      'evaluation_judgments',
      'evaluation_queries',
      'evaluation_runs',
      'evaluation_sets',
      'evaluation_versions',
      'jobs',
      'libraries',
      'media_assets',
      'media_files',
      'vector_refs',
      'video_scenes',
    ])
  })

  test('applies 0001 after the immutable baseline and creates the 20-table Agent V1 schema', async () => {
    client = new PGlite()
    for (const file of ['0000_final_baseline.sql', '0001_agent_v1_phase_a.sql']) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'agent_run_authorizations',
      'agent_run_candidates',
      'agent_run_events',
      'agent_run_inputs',
      'agent_run_steps',
      'agent_runs',
      'agent_side_effects',
      'agent_tool_calls',
      'evaluation_candidates',
      'evaluation_judgments',
      'evaluation_queries',
      'evaluation_runs',
      'evaluation_sets',
      'evaluation_versions',
      'jobs',
      'libraries',
      'media_assets',
      'media_files',
      'vector_refs',
      'video_scenes',
    ])
    const columns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='agent_runs' order by column_name",
    )
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'lease_owner',
        'lease_expires_at',
        'lease_version',
        'next_step',
        'waiting_expires_at',
      ]),
    )
  })
})
