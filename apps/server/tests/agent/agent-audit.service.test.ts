import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { AgentAuditService } from '../../src/agent/agent-audit.service.js'
import { createDurableAgentRun } from '../../src/agent/agent-run.repository.js'
import { startAgentTraceSpan } from '../../src/agent/agent-trace.repository.js'
import {
  agentRerankRankings,
  agentRerankRuns,
  agentRunCandidates,
} from '../../src/database/schema.js'
import { createTestDatabase } from '../database/test-db.js'

describe('Agent 内部审计读取', () => {
  test('同一路由返回原查询、Agent 行为、Trace、RRF 和 Rerank，且不包含本地路径', async () => {
    const testDb = await createTestDatabase()
    try {
      const run = await createDurableAgentRun(testDb.db, {
        prompt: '找海边日落的视频',
        allowExternalText: true,
        allowExternalVisual: true,
        libraryIds: [],
        mediaTypes: ['video'],
      })
      const candidateId = randomUUID()
      await testDb.db.insert(agentRunCandidates).values({
        id: candidateId,
        runId: run.id,
        candidateKey: 'video:33333333-3333-4333-8333-333333333333',
        fileId: '11111111-1111-4111-8111-111111111111',
        fileGeneration: 1,
        assetId: '22222222-2222-4222-8222-222222222222',
        sceneId: '33333333-3333-4333-8333-333333333333',
        sceneStartSeconds: '10',
        sceneEndSeconds: '30',
        rank: 1,
        retrievalJson: { rrf_score: 0.0328, reasons: ['vector_match'] },
      })
      const rerankRunId = randomUUID()
      await testDb.db.insert(agentRerankRuns).values({
        id: rerankRunId,
        agentRunId: run.id,
        attemptNo: 1,
        completionStatus: 'succeeded',
        protocolVersion: 'qwen3-vl-rerank-product-v1',
        status: 'succeeded',
        externalCallStatus: 'completed',
        maxCostCny: '0.216',
      })
      await testDb.db.insert(agentRerankRankings).values({
        id: randomUUID(),
        rerankRunId,
        candidateId,
        candidateKey: 'video:33333333-3333-4333-8333-333333333333',
        rrfRank: 1,
        rerankRank: 1,
        relevanceScore: '0.91',
      })
      await startAgentTraceSpan(testDb.db, {
        runId: run.id,
        component: 'search-service',
        operation: 'hybrid_search',
        requestSummaryJson: { limit: 20 },
      })

      const service = new AgentAuditService(testDb.db)
      const detail = await service.getRun(run.id)

      expect(detail).toMatchObject({
        run: { id: run.id, query: '找海边日落的视频' },
        trace: [expect.objectContaining({ operation: 'hybrid_search' })],
        rrf_results: [expect.objectContaining({
          file_id: '11111111-1111-4111-8111-111111111111',
          scene_start_seconds: 10,
          scene_end_seconds: 30,
          rrf_rank: 1,
        })],
        rerank_attempts: [
          expect.objectContaining({
            attempt_no: 1,
            rankings: [expect.objectContaining({ rerank_rank: 1, relevance_score: 0.91 })],
          }),
        ],
      })
      expect(JSON.stringify(detail)).not.toContain('/Users/')
      await expect(service.listRuns('10')).resolves.toMatchObject({
        runs: [expect.objectContaining({ id: run.id, query: '找海边日落的视频' })],
      })
    } finally {
      await testDb.close()
    }
  })
})
