import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  agentRerankFeedback,
  agentRerankRankings,
  agentRerankRuns,
  agentRunAuthorizations,
  agentRunCandidates,
  agentRunEvents,
  agentRunSteps,
  agentRunTraceSpans,
  agentRuns,
  agentToolCalls,
} from '../database/schema.js'

/**
 * 内部审计读取模型。
 *
 * 普通 `/agent/runs/:id` 只返回最终 Rerank 结果；本服务集中读取原查询、Agent 步骤、
 * Trace、不可变 RRF 候选和每次 Rerank 尝试，供本地排错与回溯。它是只读模块，
 * 不重放 Agent、搜索或模型调用，也不返回 API Key、证据 Base64 和本地文件路径。
 */
@Injectable()
export class AgentAuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listRuns(rawLimit?: string) {
    const parsed = Number(rawLimit ?? 50)
    const limit = Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : 50
    const rows = await this.db
      .select({
        id: agentRuns.id,
        query: agentRuns.prompt,
        status: agentRuns.status,
        attemptCount: agentRuns.attemptCount,
        errorCode: agentRuns.errorCode,
        createdAt: agentRuns.createdAt,
        updatedAt: agentRuns.updatedAt,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
    return {
      runs: rows.map((row) => ({
        id: row.id,
        query: row.query,
        status: row.status,
        attempt_count: row.attemptCount,
        error_code: row.errorCode,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
        finished_at: row.finishedAt?.toISOString() ?? null,
      })),
    }
  }

  async getRun(runId: string) {
    const [run] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    if (!run) throw new NotFoundException('Agent audit run not found')

    const [authorizations, steps, events, candidates, rerankRuns, traces, toolCalls] =
      await Promise.all([
        this.db
          .select()
          .from(agentRunAuthorizations)
          .where(eq(agentRunAuthorizations.runId, runId)),
        this.db
          .select()
          .from(agentRunSteps)
          .where(eq(agentRunSteps.runId, runId))
          .orderBy(asc(agentRunSteps.createdAt)),
        this.db
          .select()
          .from(agentRunEvents)
          .where(eq(agentRunEvents.runId, runId))
          .orderBy(asc(agentRunEvents.createdAt)),
        this.db
          .select()
          .from(agentRunCandidates)
          .where(eq(agentRunCandidates.runId, runId))
          .orderBy(asc(agentRunCandidates.rank)),
        this.db
          .select()
          .from(agentRerankRuns)
          .where(eq(agentRerankRuns.agentRunId, runId))
          .orderBy(asc(agentRerankRuns.attemptNo)),
        this.db
          .select()
          .from(agentRunTraceSpans)
          .where(eq(agentRunTraceSpans.runId, runId))
          .orderBy(asc(agentRunTraceSpans.startedAt)),
        this.db
          .select()
          .from(agentToolCalls)
          .where(eq(agentToolCalls.runId, runId))
          .orderBy(asc(agentToolCalls.createdAt)),
      ])
    const rerankIds = rerankRuns.map((item) => item.id)
    const [rankings, feedback] = rerankIds.length
      ? await Promise.all([
          this.db
            .select()
            .from(agentRerankRankings)
            .where(inArray(agentRerankRankings.rerankRunId, rerankIds))
            .orderBy(asc(agentRerankRankings.rrfRank)),
          this.db
            .select()
            .from(agentRerankFeedback)
            .where(inArray(agentRerankFeedback.rerankRunId, rerankIds)),
        ])
      : [[], []]

    return {
      run: {
        id: run.id,
        query: run.prompt,
        status: run.status,
        next_step: run.nextStep,
        enforced_scope: run.enforcedScopeJson,
        attempt_count: run.attemptCount,
        error:
          run.errorCode === null
            ? null
            : { code: run.errorCode, message: run.errorMessage },
        created_at: run.createdAt.toISOString(),
        updated_at: run.updatedAt.toISOString(),
        finished_at: run.finishedAt?.toISOString() ?? null,
      },
      authorizations: authorizations.map((item) => ({
        allow_external_text: item.allowExternalText,
        allow_external_visual: item.allowExternalVisual,
        text_scope: item.textScopeJson,
        visual_scope: item.visualScopeJson,
        granted_at: item.grantedAt.toISOString(),
      })),
      agent_behavior: {
        steps: steps.map((item) => ({
          step_attempt_id: item.stepAttemptId,
          step: item.stepKind,
          status: item.status,
          external_call_status: item.externalCallStatus,
          input_fingerprint: item.inputFingerprint,
          input: item.inputJson,
          output: item.outputJson,
          error: item.errorCode ? { code: item.errorCode, message: item.errorMessage } : null,
          started_at: item.startedAt.toISOString(),
          finished_at: item.finishedAt?.toISOString() ?? null,
        })),
        events: events.map((item) => ({
          id: item.id,
          type: item.eventType,
          tool_call_id: item.toolCallId,
          payload: item.payloadJson,
          created_at: item.createdAt.toISOString(),
        })),
        tool_calls: toolCalls.map((item) => ({
          id: item.toolCallId,
          name: item.toolName,
          status: item.status,
          input: item.inputJson,
          output: item.outputJson,
          created_at: item.createdAt.toISOString(),
        })),
      },
      trace: traces.map((item) => ({
        span_id: item.spanId,
        parent_span_id: item.parentSpanId,
        component: item.component,
        operation: item.operation,
        status: item.status,
        attempt_no: item.attemptNo,
        duration_ms: item.durationMs,
        external_call_status: item.externalCallStatus,
        request_summary: item.requestSummaryJson,
        response_summary: item.responseSummaryJson,
        error: item.errorCode ? { code: item.errorCode, message: item.errorMessage } : null,
        attributes: item.attributesJson,
        started_at: item.startedAt.toISOString(),
        finished_at: item.finishedAt?.toISOString() ?? null,
      })),
      rrf_results: candidates.map((item) => ({
        candidate_id: item.id,
        candidate_key: item.candidateKey,
        file_id: item.fileId,
        file_generation: item.fileGeneration,
        asset_id: item.assetId,
        scene_id: item.sceneId,
        scene_start_seconds:
          item.sceneStartSeconds === null ? null : Number(item.sceneStartSeconds),
        scene_end_seconds: item.sceneEndSeconds === null ? null : Number(item.sceneEndSeconds),
        rrf_rank: item.rank,
        retrieval: item.retrievalJson,
      })),
      rerank_attempts: rerankRuns.map((attempt) => ({
        id: attempt.id,
        attempt_no: attempt.attemptNo,
        status: attempt.status,
        completion_status: attempt.completionStatus,
        external_call_status: attempt.externalCallStatus,
        provider: attempt.provider,
        requested_model: attempt.requestedModel,
        provider_request_id: attempt.providerRequestId,
        request_bytes: attempt.requestBytes,
        total_tokens: attempt.totalTokens,
        estimated_cost_cny:
          attempt.estimatedCostCny === null ? null : Number(attempt.estimatedCostCny),
        latency_ms: attempt.latencyMs,
        error:
          attempt.errorCode === null
            ? null
            : { code: attempt.errorCode, message: attempt.errorMessage },
        rankings: rankings
          .filter((item) => item.rerankRunId === attempt.id)
          .map((item) => ({
            candidate_id: item.candidateId,
            candidate_key: item.candidateKey,
            rrf_rank: item.rrfRank,
            rerank_rank: item.rerankRank,
            relevance_score:
              item.relevanceScore === null ? null : Number(item.relevanceScore),
          })),
        feedback: feedback.find((item) => item.rerankRunId === attempt.id)?.verdict ?? null,
        created_at: attempt.createdAt.toISOString(),
        dispatched_at: attempt.dispatchedAt?.toISOString() ?? null,
        finished_at: attempt.finishedAt?.toISOString() ?? null,
      })),
    }
  }
}
