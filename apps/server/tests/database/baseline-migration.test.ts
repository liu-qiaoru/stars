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
  test('keeps the Phase 7 baseline immutable and appends Agent V1 migrations', async () => {
    const migrationFiles = (await readdir(resolve('drizzle')))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    const metadataFiles = (await readdir(resolve('drizzle/meta'))).sort()

    expect(migrationFiles).toEqual([
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
      '0003_happy_morlun.sql',
      '0004_mute_meggan.sql',
      '0005_friendly_mister_sinister.sql',
      '0006_new_ghost_rider.sql',
      '0007_phase_e_shadow_usage_reconciliation.sql',
      '0008_strong_karen_page.sql',
      '0009_phase_f_vlm_blind_candidate_review.sql',
      '0010_phase_f_candidate_packet_identity.sql',
      '0011_phase_f_candidate_replacement_lineage.sql',
      '0012_phase_f_human_condition_labeling.sql',
      '0013_phase_f_real_vlm_capability.sql',
      '0014_flawless_shaman.sql',
    ])
    expect(metadataFiles).toEqual([
      '0000_snapshot.json',
      '0001_snapshot.json',
      '0002_snapshot.json',
      '0003_snapshot.json',
      '0004_snapshot.json',
      '0005_snapshot.json',
      '0006_snapshot.json',
      '0007_snapshot.json',
      '0008_snapshot.json',
      '0009_snapshot.json',
      '0010_snapshot.json',
      '0011_snapshot.json',
      '0012_snapshot.json',
      '0013_snapshot.json',
      '0014_snapshot.json',
      '_journal.json',
    ])
    const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      '0000_final_baseline',
      '0001_agent_v1_phase_a',
      '0002_agent_v1_phase_d_candidate_evidence',
      '0003_happy_morlun',
      '0004_mute_meggan',
      '0005_friendly_mister_sinister',
      '0006_new_ghost_rider',
      '0007_phase_e_shadow_usage_reconciliation',
      '0008_strong_karen_page',
      '0009_phase_f_vlm_blind_candidate_review',
      '0010_phase_f_candidate_packet_identity',
      '0011_phase_f_candidate_replacement_lineage',
      '0012_phase_f_human_condition_labeling',
      '0013_phase_f_real_vlm_capability',
      '0014_flawless_shaman',
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

  test('applies Phase D as an additive migration and creates only candidate_evidence', async () => {
    client = new PGlite()
    for (const file of [
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
    ]) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
    expect(tables.rows).toHaveLength(21)
    expect(tables.rows.map((row) => row.tablename)).toContain('candidate_evidence')
    const evidenceColumns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='candidate_evidence'",
    )
    expect(evidenceColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'manifest_json',
        'input_sha256',
        'artifact_sha256',
        'artifact_path',
        'retention_class',
        'expires_at',
        'frozen_at',
      ]),
    )
  })

  test('applies Phase E additively and creates only normalized shadow rerank facts', async () => {
    client = new PGlite()
    for (const file of [
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
      '0003_happy_morlun.sql',
    ]) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }
    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
    expect(tables.rows).toHaveLength(24)
    expect(tables.rows.map((row) => row.tablename)).toEqual(
      expect.arrayContaining([
        'evaluation_shadow_runs',
        'evaluation_shadow_attempts',
        'evaluation_shadow_rankings',
      ]),
    )
  })

  test('applies smoke preflight migrations without rewriting Phase E history', async () => {
    client = new PGlite()
    for (const file of [
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
      '0003_happy_morlun.sql',
      '0004_mute_meggan.sql',
      '0005_friendly_mister_sinister.sql',
      '0006_new_ghost_rider.sql',
      '0007_phase_e_shadow_usage_reconciliation.sql',
      '0008_strong_karen_page.sql',
    ]) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const columns = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
       from information_schema.columns
       where table_name='evaluation_shadow_runs'
         and column_name in ('input_tokens', 'output_tokens', 'total_tokens', 'latency_ms', 'billed_cost_cny', 'estimated_cost_cny')
       order by column_name`,
    )
    expect(columns.rows).toEqual([
      { column_name: 'billed_cost_cny', is_nullable: 'YES' },
      { column_name: 'estimated_cost_cny', is_nullable: 'YES' },
      { column_name: 'input_tokens', is_nullable: 'YES' },
      { column_name: 'latency_ms', is_nullable: 'YES' },
      { column_name: 'output_tokens', is_nullable: 'YES' },
      { column_name: 'total_tokens', is_nullable: 'YES' },
    ])
    const attemptColumns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='evaluation_shadow_attempts'",
    )
    expect(attemptColumns.rows.map((row) => row.column_name)).toContain('estimated_cost_cny')
    const reconciliationConstraints = await client.query<{ constraint_name: string }>(
      `select constraint_name
       from information_schema.table_constraints
       where table_name='evaluation_shadow_usage_reconciliations'
       order by constraint_name`,
    )
    const constraintNames = reconciliationConstraints.rows.map((row) => row.constraint_name)
    expect(constraintNames).toContain('evaluation_shadow_usage_reconciliations_pkey')
    // PostgreSQL 标识符最多 63 字节，自动生成的外键名称会被稳定截断。
    expect(
      constraintNames.some((name) =>
        name.startsWith('evaluation_shadow_usage_reconciliations_attempt_id_evaluation_'),
      ),
    ).toBe(true)
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef
       from pg_indexes
       where tablename in ('evaluation_shadow_runs', 'evaluation_shadow_usage_reconciliations')`,
    )
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: 'evaluation_shadow_usage_reconciliations_attempt_unique',
          indexdef: expect.stringContaining('UNIQUE'),
        }),
        expect.objectContaining({
          indexname: 'evaluation_shadow_runs_identity_unique',
          indexdef: expect.stringContaining('execution_number'),
        }),
      ]),
    )
  })

  test('adds only normalized Phase F candidate-review facts after Phase E', async () => {
    client = new PGlite()
    for (const file of [
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
      '0003_happy_morlun.sql',
      '0004_mute_meggan.sql',
      '0005_friendly_mister_sinister.sql',
      '0006_new_ghost_rider.sql',
      '0007_phase_e_shadow_usage_reconciliation.sql',
      '0008_strong_karen_page.sql',
      '0009_phase_f_vlm_blind_candidate_review.sql',
      '0010_phase_f_candidate_packet_identity.sql',
      '0011_phase_f_candidate_replacement_lineage.sql',
    ]) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }
    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public' and tablename like 'evaluation_vlm_blind_%'
       order by tablename`,
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'evaluation_vlm_blind_cases',
      'evaluation_vlm_blind_conditions',
      'evaluation_vlm_blind_datasets',
    ])
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where tablename in (
         'evaluation_vlm_blind_datasets',
         'evaluation_vlm_blind_cases',
         'evaluation_vlm_blind_conditions'
       )`,
    )
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: 'evaluation_vlm_blind_datasets_proposal_fingerprint_unique',
          indexdef: expect.stringContaining('UNIQUE'),
        }),
        expect.objectContaining({
          indexname: 'evaluation_vlm_blind_cases_dataset_candidate_unique',
          indexdef: expect.stringContaining('UNIQUE'),
        }),
        expect.objectContaining({
          indexname: 'evaluation_vlm_blind_cases_replaces_unique',
          indexdef: expect.stringContaining('UNIQUE'),
        }),
        expect.objectContaining({
          indexname: 'evaluation_vlm_blind_conditions_case_condition_unique',
          indexdef: expect.stringContaining('UNIQUE'),
        }),
      ]),
    )
  })

  test('adds independent Phase F labeling and fake-run facts without reopening candidates', async () => {
    client = new PGlite()
    for (const file of [
      '0000_final_baseline.sql',
      '0001_agent_v1_phase_a.sql',
      '0002_agent_v1_phase_d_candidate_evidence.sql',
      '0003_happy_morlun.sql',
      '0004_mute_meggan.sql',
      '0005_friendly_mister_sinister.sql',
      '0006_new_ghost_rider.sql',
      '0007_phase_e_shadow_usage_reconciliation.sql',
      '0008_strong_karen_page.sql',
      '0009_phase_f_vlm_blind_candidate_review.sql',
      '0010_phase_f_candidate_packet_identity.sql',
      '0011_phase_f_candidate_replacement_lineage.sql',
      '0012_phase_f_human_condition_labeling.sql',
    ]) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='public' and tablename like 'evaluation_vlm_blind_%' order by tablename`,
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual(
      expect.arrayContaining([
        'evaluation_vlm_blind_labeling_sessions',
        'evaluation_vlm_blind_fake_runs',
        'evaluation_vlm_blind_fake_results',
      ]),
    )
    const conditionColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name='evaluation_vlm_blind_conditions'`,
    )
    expect(conditionColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['first_labeled_at', 'second_labeled_at', 'final_labeled_at']),
    )
  })

  test('adds real Phase F authorization, run, attempt and result facts without changing media tables', async () => {
    client = new PGlite()
    const migrationFiles = (await readdir(resolve('drizzle')))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    for (const file of migrationFiles) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='public' and tablename like 'evaluation_vlm_blind_%' order by tablename`,
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual(
      expect.arrayContaining([
        'evaluation_vlm_blind_visual_authorizations',
        'evaluation_vlm_blind_real_runs',
        'evaluation_vlm_blind_real_attempts',
        'evaluation_vlm_blind_real_results',
      ]),
    )
    const mediaTableCount = await client.query<{ count: number }>(
      `select count(*)::int as count from pg_tables where schemaname='public' and tablename in ('media_files', 'media_assets', 'vector_refs', 'video_scenes')`,
    )
    expect(mediaTableCount.rows[0]?.count).toBe(4)
  })

  test('adds product Rerank facts without rewriting Agent RRF candidates or media tables', async () => {
    client = new PGlite()
    const migrationFiles = (await readdir(resolve('drizzle')))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    for (const file of migrationFiles) {
      await client.exec(await readFile(resolve('drizzle', file), 'utf8'))
    }

    const rerankTables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='public' and tablename like 'agent_rerank_%' order by tablename`,
    )
    expect(rerankTables.rows.map((row) => row.tablename)).toEqual([
      'agent_rerank_feedback',
      'agent_rerank_rankings',
      'agent_rerank_runs',
    ])
    const candidateColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name='agent_run_candidates' order by column_name`,
    )
    expect(candidateColumns.rows.map((row) => row.column_name)).not.toContain('rerank_rank')
    const mediaTableCount = await client.query<{ count: number }>(
      `select count(*)::int as count from pg_tables where schemaname='public' and tablename in ('media_files', 'media_assets', 'vector_refs', 'video_scenes')`,
    )
    expect(mediaTableCount.rows[0]?.count).toBe(4)
  })
})
