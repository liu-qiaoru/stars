import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { agentSearchProgress } from '../../src/agent/agent-search-progress.js'
import { createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import { agentRuns, agentRunTraceSpans } from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

test('进度立即持久化；取消后拒绝迟到成功与新阶段', async () => {
  const { db, close } = await createTestDatabase()
  try {
    const run = await createDurableAgentRun(db, {
      prompt: 'test',
      allowExternalText: true,
      allowExternalVisual: false,
      libraryIds: [],
      mediaTypes: ['audio'],
    })
    await db
      .update(agentRuns)
      .set({
        status: 'searching',
        leaseOwner: 'test',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 60000),
      })
      .where(eq(agentRuns.id, run.id))
    const notify = agentSearchProgress(db, {
      runId: run.id,
      prompt: 'test',
      step: 'searching',
      stepAttemptId: randomUUID(),
      leaseOwner: 'test',
      leaseVersion: 1,
      enforcedScope: {},
    })
    await notify('retrieving', 'running')
    expect((await db.select().from(agentRunTraceSpans))[0]?.status).toBe('running')
    await notify('retrieving', 'succeeded')
    await notify('rrf', 'running')
    await db.update(agentRuns).set({ status: 'cancel_requested' }).where(eq(agentRuns.id, run.id))
    await expect(notify('rrf', 'succeeded')).rejects.toThrow('执行权已失效')
    await expect(notify('ranking', 'running')).rejects.toThrow('执行权已失效')
    const rows = await db.select().from(agentRunTraceSpans)
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'running'])
    expect(rows.every((row) => Object.keys(row.requestSummaryJson as object).length === 0)).toBe(
      true,
    )
  } finally {
    await close()
  }
})
