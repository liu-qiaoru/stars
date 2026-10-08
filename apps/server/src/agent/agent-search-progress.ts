import { and, eq, gt } from 'drizzle-orm'
import type { Database } from '../database/repositories.js'
import { agentRuns } from '../database/schema.js'
import type { SearchService } from '../search/search.service.js'
import type { AgentStepHandler } from './agent.types.js'
import { AgentStepExecutionError } from './agent.types.js'
import { finishAgentTraceSpan, startAgentTraceSpan } from './agent-trace.repository.js'

/**
 * 将 SearchService 的真实阶段写入已有轨迹表，供任务详情轮询读取。
 * 每次写入核对执行租约；取消、超时或接管后不再开始新阶段，也不接受迟到的成功记录。
 * 只保存步骤身份和阶段名称，不保存查询、素材文字、路径或模型思考。
 */
export function agentSearchProgress(
  db: Database,
  input: Parameters<AgentStepHandler['prepare']>[0],
): NonNullable<NonNullable<Parameters<SearchService['search']>[1]>['onProgress']> {
  const spans = new Map<string, string>()
  return async (phase, status) => {
    // 在短事务中锁住任务行，避免核对租约之后、写轨迹之前被取消或接管。
    await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.status, 'searching'),
            eq(agentRuns.leaseOwner, input.leaseOwner),
            eq(agentRuns.leaseVersion, input.leaseVersion),
            gt(agentRuns.leaseExpiresAt, new Date()),
          ),
        )
        .for('update')
      if (!run)
        throw new AgentStepExecutionError(
          'AGENT_PROGRESS_LEASE_LOST',
          '执行权已失效，停止更新检索进度。',
        )
      if (status === 'running') {
        const span = await startAgentTraceSpan(tx as unknown as Database, {
          runId: input.runId,
          component: 'search-service',
          operation: phase,
          attributesJson: { step_attempt_id: input.stepAttemptId },
        })
        spans.set(phase, span.spanId)
      } else {
        const spanId = spans.get(phase)
        if (spanId)
          await finishAgentTraceSpan(tx as unknown as Database, {
            runId: input.runId,
            spanId,
            status,
          })
      }
    })
  }
}
