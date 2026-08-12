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
  expireWaitingAgentRuns,
  finalizeCancelledAgentRuns,
  markAgentExternalCallDispatched,
  recoverExpiredAgentRuns,
  timeoutActiveAgentRuns,
} from './agent-run.repository.js'
import { AGENT_STEP_HANDLER, type AgentStepHandler } from './agent.types.js'

/**
 * NestJS 内的 Agent run 执行器。它定时扫描 PostgreSQL，一次最多领取一个 run；
 * Python Worker 不读取这些状态，也不决定 Agent 的下一步。
 *
 * Phase A 默认处理器未就绪，执行器只做过期/恢复维护。Phase B 提供 AgentIntent
 * handler 后，prepare 只构造请求，Executor 先提交 dispatched，再在事务外执行网络调用。
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
    let activeContext: { runId: string; stepAttemptId: string; leaseVersion: number } | undefined
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
        await timeoutActiveAgentRuns(this.db, {
          activityTimeoutMs: this.settings.agentActivityTimeoutMs,
          now: new Date(now.getTime() + this.settings.agentActivityTimeoutMs),
        })
        // JavaScript Promise 不能强制终止任意底层调用。这里明确不再 await，也不提交其
        // 迟到结果；catch 只防止迟到异常成为未处理拒绝，真正状态已持久化为 timed_out。
        void executePromise.catch((lateError: unknown) => {
          const message = lateError instanceof Error ? lateError.message : String(lateError)
          this.logger.warn(
            `Discarded late timed-out Agent error run_id=${claim.run.id} step_attempt_id=${claim.step.stepAttemptId} lease_version=${claim.run.leaseVersion} error=${message}`,
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
        },
        new Date(),
      )
      if (!committed) {
        this.logger.warn(
          `Discarded stale Agent result for run=${claim.run.id} lease_version=${claim.run.leaseVersion}`,
        )
      }
    } catch (error) {
      // Phase B 将按“明确失败”与“结果不明”分类提交错误。Phase A 不吞错，
      // 先保留租约和步骤尝试，让恢复扫描根据 dispatched 事实做安全决定。
      const message = error instanceof Error ? error.message : String(error)
      const identity = activeContext
        ? ` run_id=${activeContext.runId} step_attempt_id=${activeContext.stepAttemptId} lease_version=${activeContext.leaseVersion}`
        : ''
      this.logger.error(`Agent executor iteration failed:${identity} error=${message}`)
    } finally {
      this.isRunning = false
    }
  }
}

/** Phase A 不会伪造 AgentIntent 结果；没有 Phase B handler 时 capabilities 明确不可用。 */
@Injectable()
export class PhaseAPendingAgentStepHandler implements AgentStepHandler {
  isReady() {
    return false
  }

  async prepare(): Promise<never> {
    throw new Error('Agent V1 Phase B step handler is not implemented')
  }
}
