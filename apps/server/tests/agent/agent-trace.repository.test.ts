import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import {
  finishAgentTraceSpan,
  startAgentTraceSpan,
} from '../../src/agent/agent-trace.repository.js'
import { createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import { agentRunTraceSpans } from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

describe('Agent Trace 持久化仓库', () => {
  test('保存安全请求摘要、父子关系和毫秒耗时，且已完成 Span 不会被覆盖', async () => {
    const testDb = await createTestDatabase()
    try {
      const startedAt = new Date('2026-08-21T02:00:00.000Z')
      const run = await createDurableAgentRun(
        testDb.db,
        {
          prompt: '找海边日落的视频',
          allowExternalText: true,
          allowExternalVisual: true,
          libraryIds: [],
          mediaTypes: ['video'],
        },
        startedAt,
      )
      const parent = await startAgentTraceSpan(
        testDb.db,
        {
          runId: run.id,
          component: 'agent',
          operation: 'search_and_rerank',
          requestSummaryJson: { media_types: ['video'] },
        },
        startedAt,
      )
      const child = await startAgentTraceSpan(
        testDb.db,
        {
          runId: run.id,
          parentSpanId: parent.spanId,
          component: 'search-service',
          operation: 'hybrid_search',
          requestSummaryJson: { query_length: 9, limit: 20 },
        },
        new Date(startedAt.getTime() + 5),
      )
      const finishedAt = new Date(startedAt.getTime() + 25)
      await expect(
        finishAgentTraceSpan(
          testDb.db,
          {
            runId: run.id,
            spanId: child.spanId,
            status: 'succeeded',
            responseSummaryJson: { candidate_count: 20 },
          },
          finishedAt,
        ),
      ).resolves.toMatchObject({ status: 'succeeded', durationMs: 20 })
      await expect(
        finishAgentTraceSpan(
          testDb.db,
          { runId: run.id, spanId: child.spanId, status: 'failed', errorCode: 'LATE_WRITE' },
          new Date(finishedAt.getTime() + 1),
        ),
      ).resolves.toBeUndefined()

      await expect(
        testDb.db
          .select()
          .from(agentRunTraceSpans)
          .where(eq(agentRunTraceSpans.runId, run.id)),
      ).resolves.toEqual([
        expect.objectContaining({
          spanId: parent.spanId,
          parentSpanId: null,
          status: 'running',
        }),
        expect.objectContaining({
          spanId: child.spanId,
          parentSpanId: parent.spanId,
          status: 'succeeded',
          durationMs: 20,
          responseSummaryJson: { candidate_count: 20 },
        }),
      ])
    } finally {
      await testDb.close()
    }
  })
})
