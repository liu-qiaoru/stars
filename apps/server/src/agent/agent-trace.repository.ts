import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../database/repositories.js'
import { agentRunTraceSpans } from '../database/schema.js'

export type AgentTraceSpanStatus = 'succeeded' | 'failed' | 'outcome_unknown'

/**
 * 创建一个持久化 Trace Span（调用轨迹片段）。
 *
 * Span 只记录组件、操作、时间和安全摘要，用来回答“这次检索调用了谁、耗时多久、在哪
 * 失败”。调用方不得把 API Key、Base64 图片、大向量、本地绝对路径、完整 Caption、
 * 转录或模型隐藏思考写入摘要；这些内容既不需要排错，也不应扩大审计数据的暴露面。
 */
export async function startAgentTraceSpan(
  db: Database,
  input: {
    runId: string
    parentSpanId?: string
    component: string
    operation: string
    attemptNo?: number
    externalCallStatus?: 'not_dispatched' | 'dispatched'
    requestSummaryJson?: Record<string, unknown>
    attributesJson?: Record<string, unknown>
  },
  now = new Date(),
) {
  const [span] = await db
    .insert(agentRunTraceSpans)
    .values({
      id: randomUUID(),
      runId: input.runId,
      spanId: randomUUID(),
      parentSpanId: input.parentSpanId,
      component: input.component,
      operation: input.operation,
      status: 'running',
      attemptNo: input.attemptNo ?? 1,
      externalCallStatus: input.externalCallStatus ?? 'not_dispatched',
      requestSummaryJson: input.requestSummaryJson ?? {},
      attributesJson: input.attributesJson ?? {},
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return span
}

/**
 * 完成一个仍处于 running 的 Span，并以毫秒保存耗时。
 *
 * 条件更新让重复回调只有第一次能完成记录；返回 undefined 表示该 Span 已结束或不存在，
 * 调用方不能覆盖先前的成功、失败或 outcome_unknown（外部调用结果不明）事实。
 */
export async function finishAgentTraceSpan(
  db: Database,
  input: {
    runId: string
    spanId: string
    status: AgentTraceSpanStatus
    externalCallStatus?: 'not_dispatched' | 'completed' | 'failed' | 'outcome_unknown'
    responseSummaryJson?: Record<string, unknown>
    errorCode?: string
    errorMessage?: string
    attributesJson?: Record<string, unknown>
  },
  now = new Date(),
) {
  const [existing] = await db
    .select({ startedAt: agentRunTraceSpans.startedAt })
    .from(agentRunTraceSpans)
    .where(
      and(
        eq(agentRunTraceSpans.runId, input.runId),
        eq(agentRunTraceSpans.spanId, input.spanId),
        eq(agentRunTraceSpans.status, 'running'),
      ),
    )
    .limit(1)
  if (!existing) return undefined

  const [span] = await db
    .update(agentRunTraceSpans)
    .set({
      status: input.status,
      externalCallStatus: input.externalCallStatus,
      responseSummaryJson: input.responseSummaryJson,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      attributesJson: input.attributesJson,
      finishedAt: now,
      durationMs: Math.max(0, now.getTime() - existing.startedAt.getTime()),
      updatedAt: now,
    })
    .where(
      and(
        eq(agentRunTraceSpans.runId, input.runId),
        eq(agentRunTraceSpans.spanId, input.spanId),
        eq(agentRunTraceSpans.status, 'running'),
      ),
    )
    .returning()
  return span
}
