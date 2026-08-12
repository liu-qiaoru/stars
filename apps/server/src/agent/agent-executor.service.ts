import { randomUUID } from 'node:crypto'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import type { Database } from '../database/repositories.js'
import {
  claimNextAgentRun,
  commitAgentStep,
  commitAgentStepFailure,
  expireWaitingAgentRuns,
  finalizeCancelledAgentRuns,
  markAgentExternalCallDispatched,
  recoverExpiredAgentRuns,
  timeoutActiveAgentRuns,
} from './agent-run.repository.js'
import {
  AGENT_STEP_HANDLER,
  AgentStepExecutionError,
  type AgentRunStatus,
  type AgentStepHandler,
} from './agent.types.js'

/**
 * NestJS 内的 Agent run 执行器。它定时扫描 PostgreSQL，一次最多领取一个 run；
 * Python Worker 不读取这些状态，也不决定 Agent 的下一步。
 *
 * Phase B handler 的 prepare 只构造请求；Executor 先提交 dispatched，再在事务外
 * 执行网络调用。这样崩溃恢复能区分“尚未发送”和“结果未知”，避免静默重放计费请求。
 */
@Injectable()
export class AgentExecutorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentExecutorService.name)
  private readonly leaseOwner = `server-${randomUUID()}`
  private timer: ReturnType<typeof setInterval> | undefined
  private isRunning = false

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AGENT_STEP_HANDLER) private readonly stepHandler: AgentStepHandler,
  ) {}

  onApplicationBootstrap() {
    if (!this.settings.agentExecutorEnabled) return
    void this.runOnce()
    this.timer = setInterval(() => void this.runOnce(), this.settings.agentExecutorIntervalMs)
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async runOnce(now = new Date()) {
    if (this.isRunning) return
    this.isRunning = true
    let activeContext:
      | {
          runId: string
          stepAttemptId: string
          leaseVersion: number
          currentStatus: AgentRunStatus
        }
      | undefined
    try {
      await expireWaitingAgentRuns(this.db, now)
      await finalizeCancelledAgentRuns(this.db, now)
      await timeoutActiveAgentRuns(this.db, {
        activityTimeoutMs: this.settings.agentActivityTimeoutMs,
        now,
      })
      await recoverExpiredAgentRuns(this.db, now)
      if (!this.stepHandler.isReady()) return

      const claim = await claimNextAgentRun(this.db, {
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.settings.agentLeaseDurationMs,
        now,
      })
      if (!claim) return
      activeContext = {
        runId: claim.run.id,
        stepAttemptId: claim.step.stepAttemptId,
        leaseVersion: claim.run.leaseVersion,
        currentStatus: claim.run.status as AgentRunStatus,
      }

      const prepared = await this.stepHandler.prepare({
        runId: claim.run.id,
        prompt: claim.run.prompt,
        step: claim.run.nextStep as 'extracting_intent' | 'searching',
        stepAttemptId: claim.step.stepAttemptId,
        leaseOwner: this.leaseOwner,
        leaseVersion: claim.run.leaseVersion,
        enforcedScope: claim.run.enforcedScopeJson,
      })
      if (prepared.external) {
        if (!prepared.inputFingerprint) {
          throw new Error('External Agent step requires an input fingerprint before dispatch')
        }
        const dispatched = await markAgentExternalCallDispatched(
          this.db,
          {
            runId: claim.run.id,
            leaseOwner: this.leaseOwner,
            leaseVersion: claim.run.leaseVersion,
            stepAttemptId: claim.step.stepAttemptId,
            currentStatus: claim.run.status as 'extracting_intent' | 'searching',
            inputFingerprint: prepared.inputFingerprint,
          },
          now,
        )
        if (!dispatched) return
      }

      // execute 可能等待 Provider 或 SearchService，此时没有打开的数据库事务或行锁。
      // Promise.race 让当前执行器自身也能执行硬超时；否则 isRunning 会阻止同实例的
      // 下一次维护扫描，单 Server 部署中的挂起调用就可能永远停留在活动态。
      const executePromise = prepared.execute()
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const execution = await Promise.race([
        executePromise.then((result) => ({ kind: 'completed' as const, result })),
        new Promise<{ kind: 'timed_out' }>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve({ kind: 'timed_out' }),
            this.settings.agentActivityTimeoutMs,
          )
        }),
      ])
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (execution.kind === 'timed_out') {
        if (prepared.external) {
          await commitAgentStepFailure(
            this.db,
            {
              ...activeContext,
              leaseOwner: this.leaseOwner,
              errorCode: 'AGENT_EXTERNAL_OUTCOME_UNKNOWN',
              errorMessage: '外部请求已派发，但活动硬超时前未收到可确认的响应。',
              outcomeUnknown: true,
            },
            new Date(now.getTime() + this.settings.agentActivityTimeoutMs),
          )
        } else {
          await timeoutActiveAgentRuns(this.db, {
            activityTimeoutMs: this.settings.agentActivityTimeoutMs,
            now: new Date(now.getTime() + this.settings.agentActivityTimeoutMs),
          })
        }
        // JavaScript Promise 不能强制终止任意底层调用。这里明确不再 await，也不提交其
        // 迟到结果；外部步骤已是 outcome_unknown，本地步骤已是 timed_out。
        void executePromise.catch(() => {
          this.logger.warn(
            `Discarded late timed-out Agent error run_id=${claim.run.id} step_attempt_id=${claim.step.stepAttemptId} lease_version=${claim.run.leaseVersion}`,
          )
        })
        return
      }
      const result = execution.result
      const committed = await commitAgentStep(
        this.db,
        {
          runId: claim.run.id,
          leaseOwner: this.leaseOwner,
          leaseVersion: claim.run.leaseVersion,
          stepAttemptId: claim.step.stepAttemptId,
          currentStatus: claim.run.status as 'extracting_intent' | 'searching',
          transition: result.transition,
          outputJson: result.outputJson,
          candidates: result.candidates,
        },
        new Date(),
      )
      if (!committed) {
        this.logger.warn(
          `Discarded stale Agent result for run=${claim.run.id} lease_version=${claim.run.leaseVersion}`,
        )
      }
    } catch (error) {
      const stepError =
        error instanceof AgentStepExecutionError
          ? error
          : new AgentStepExecutionError(
              'AGENT_STEP_INTERNAL_ERROR',
              'Agent 步骤发生未分类的内部错误。',
            )
      if (activeContext) {
        await commitAgentStepFailure(this.db, {
          ...activeContext,
          leaseOwner: this.leaseOwner,
          errorCode: stepError.code,
          errorMessage: stepError.message,
          outcomeUnknown: stepError.outcomeUnknown,
        })
      }
      // 日志只包含稳定身份和脱敏错误码。不得输出 Provider 原始体、密钥、本地路径或媒体文本。
      const identity = activeContext
        ? ` run_id=${activeContext.runId} step_attempt_id=${activeContext.stepAttemptId} lease_version=${activeContext.leaseVersion}`
        : ''
      this.logger.error(`Agent executor iteration failed:${identity} code=${stepError.code}`)
    } finally {
      this.isRunning = false
    }
  }
}
