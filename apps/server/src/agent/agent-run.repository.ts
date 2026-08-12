import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { AgentNextStep, AgentRunStatus } from './agent.types.js'
import type { Database } from '../database/repositories.js'
import {
  agentRunAuthorizations,
  agentRunCandidates,
  agentRunEvents,
  agentRunInputs,
  agentRunSteps,
  agentRuns,
} from '../database/schema.js'

const CLAIMABLE_STATUSES: AgentRunStatus[] = ['queued', 'extracting_intent', 'searching']

const ALLOWED_EXECUTOR_TRANSITIONS: Partial<Record<AgentRunStatus, AgentRunStatus[]>> = {
  extracting_intent: ['searching', 'waiting_for_user_input', 'failed', 'timed_out'],
  searching: [
    'waiting_for_export_selection',
    'succeeded',
    'failed',
    'timed_out',
    'completed_with_errors',
  ],
}

export interface AgentLeaseClaim {
  run: typeof agentRuns.$inferSelect
  step: typeof agentRunSteps.$inferSelect
}

/**
 * 原子创建 Agent run、本 run 授权和审计事件。
 *
 * HTTP 层只需等待这个短事务，不等待模型或检索，因此可以立即返回 run_id。
 * 任一写入失败都会整体回滚，不会留下没有授权事实的半成品 run。
 */
export async function createDurableAgentRun(
  db: Database,
  input: {
    prompt: string
    allowExternalText: boolean
    allowExternalVisual: boolean
    libraryIds: string[]
    mediaTypes: string[]
  },
  now = new Date(),
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const runId = randomUUID()
    const [run] = await tx
      .insert(agentRuns)
      .values({
        id: runId,
        status: 'queued',
        prompt: input.prompt,
        nextStep: 'extracting_intent',
        enforcedScopeJson: {
          library_ids: input.libraryIds,
          media_types: input.mediaTypes,
        },
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    await tx.insert(agentRunAuthorizations).values({
      id: randomUUID(),
      runId,
      allowExternalText: input.allowExternalText,
      allowExternalVisual: input.allowExternalVisual,
      textScopeJson: input.allowExternalText ? { fields: ['user_prompt'] } : { fields: [] },
      visualScopeJson: input.allowExternalVisual
        ? { fields: ['candidate_frames'] }
        : { fields: [] },
      grantedAt: now,
    })
    await tx.insert(agentRunEvents).values({
      id: randomUUID(),
      runId,
      eventType: 'run_queued',
      payloadJson: {
        next_step: 'extracting_intent',
        external_text_authorized: input.allowExternalText,
        external_visual_authorized: input.allowExternalVisual,
      },
      createdAt: now,
    })
    return run
  })
}

/**
 * 使用“先选候选，再条件 UPDATE ... RETURNING”领取一个 run。
 *
 * 多个 Server 可能同时读到同一候选，但只有同时匹配旧 status、lease_version
 * 和租约过期条件的更新能返回 1 行。步骤尝试与租约在同一短事务中写入。
 */
export async function claimNextAgentRun(
  db: Database,
  input: { leaseOwner: string; leaseDurationMs: number; now?: Date },
): Promise<AgentLeaseClaim | undefined> {
  const now = input.now ?? new Date()
  const [candidate] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, CLAIMABLE_STATUSES),
        lte(agentRuns.nextAttemptAt, now),
        or(
          isNull(agentRuns.leaseOwner),
          isNull(agentRuns.leaseExpiresAt),
          lte(agentRuns.leaseExpiresAt, now),
        ),
        // dispatched 表示外部请求可能已计费。这种 run 只能由恢复扫描转成
        // outcome_unknown，普通 claim 不得再次调用 Provider。
        or(isNull(agentRuns.externalCallStatus), ne(agentRuns.externalCallStatus, 'dispatched')),
      ),
    )
    .orderBy(asc(agentRuns.nextAttemptAt), asc(agentRuns.createdAt))
    .limit(1)

  if (!candidate) {
    return undefined
  }

  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const stepAttemptId = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)
    const [claimed] = await tx
      .update(agentRuns)
      .set({
        status: candidate.nextStep,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        leaseVersion: sql`${agentRuns.leaseVersion} + 1`,
        attemptCount: sql`${agentRuns.attemptCount} + 1`,
        currentStepAttemptId: stepAttemptId,
        externalCallStatus: 'not_dispatched',
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, candidate.id),
          eq(agentRuns.status, candidate.status),
          eq(agentRuns.leaseVersion, candidate.leaseVersion),
          or(
            isNull(agentRuns.leaseOwner),
            isNull(agentRuns.leaseExpiresAt),
            lte(agentRuns.leaseExpiresAt, now),
          ),
          or(isNull(agentRuns.externalCallStatus), ne(agentRuns.externalCallStatus, 'dispatched')),
        ),
      )
      .returning()

    if (!claimed) {
      return undefined
    }

    if (candidate.currentStepAttemptId) {
      // 直接接管未派发的过期租约时，旧尝试已经永久失去写权。
      // 同一事务把它标成 lease_expired，避免审计页出现两个 running 步骤。
      await tx
        .update(agentRunSteps)
        .set({
          status: 'lease_expired',
          errorCode: 'AGENT_LEASE_EXPIRED',
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRunSteps.runId, candidate.id),
            eq(agentRunSteps.stepAttemptId, candidate.currentStepAttemptId),
            eq(agentRunSteps.status, 'running'),
            ne(agentRunSteps.externalCallStatus, 'dispatched'),
          ),
        )
    }

    const [step] = await tx
      .insert(agentRunSteps)
      .values({
        id: randomUUID(),
        runId: claimed.id,
        stepAttemptId,
        stepKind: claimed.nextStep,
        status: 'running',
        externalCallStatus: 'not_dispatched',
        inputJson: { prompt: claimed.prompt, enforced_scope: claimed.enforcedScopeJson },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return { run: claimed, step }
  })
}

/** 在外部请求发出前持久化 dispatched，使崩溃恢复不会重复计费。 */
export async function markAgentExternalCallDispatched(
  db: Database,
  input: {
    runId: string
    leaseOwner: string
    leaseVersion: number
    stepAttemptId: string
    currentStatus: AgentRunStatus
    inputFingerprint: string
  },
  now = new Date(),
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const [run] = await tx
      .update(agentRuns)
      .set({ externalCallStatus: 'dispatched', updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, input.currentStatus),
          eq(agentRuns.leaseOwner, input.leaseOwner),
          eq(agentRuns.leaseVersion, input.leaseVersion),
          eq(agentRuns.currentStepAttemptId, input.stepAttemptId),
        ),
      )
      .returning()
    if (!run) {
      return undefined
    }

    const [step] = await tx
      .update(agentRunSteps)
      .set({
        externalCallStatus: 'dispatched',
        inputFingerprint: input.inputFingerprint,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRunSteps.runId, input.runId),
          eq(agentRunSteps.stepAttemptId, input.stepAttemptId),
          eq(agentRunSteps.status, 'running'),
        ),
      )
      .returning()
    if (!step) {
      throw new Error('Claimed Agent step disappeared before external dispatch')
    }
    return { run, step }
  })
}

/**
 * 保存一步规范化输出并推进状态。
 *
 * WHERE 中的 owner + version + status + step_attempt_id 是完整写权证明。
 * 更新 0 行不是可忽略错误，而是告诉调用方丢弃过期结果。
 */
export async function commitAgentStep(
  db: Database,
  input: {
    runId: string
    leaseOwner: string
    leaseVersion: number
    stepAttemptId: string
    currentStatus: AgentRunStatus
    transition: {
      status: AgentRunStatus
      nextStep?: AgentNextStep
      waitingStepId?: string
      waitingExpiresAt?: Date
    }
    outputJson: unknown
  },
  now = new Date(),
) {
  if (!ALLOWED_EXECUTOR_TRANSITIONS[input.currentStatus]?.includes(input.transition.status)) {
    throw new Error(
      `Illegal Agent transition: ${input.currentStatus} -> ${input.transition.status}`,
    )
  }
  if (
    input.transition.status === 'waiting_for_user_input' &&
    (!input.transition.waitingStepId ||
      !input.transition.waitingExpiresAt ||
      input.transition.nextStep !== 'searching')
  ) {
    throw new Error(
      'waiting_for_user_input requires waitingStepId, waitingExpiresAt and nextStep=searching',
    )
  }
  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const terminal = [
      'succeeded',
      'failed',
      'timed_out',
      'completed_with_errors',
      'cancelled',
      'expired',
    ].includes(input.transition.status)
    const [run] = await tx
      .update(agentRuns)
      .set({
        status: input.transition.status,
        nextStep: input.transition.nextStep,
        leaseOwner: null,
        leaseExpiresAt: null,
        currentStepAttemptId: null,
        externalCallStatus: null,
        waitingStepId: input.transition.waitingStepId ?? null,
        waitingExpiresAt: input.transition.waitingExpiresAt ?? null,
        updatedAt: now,
        finishedAt: terminal ? now : null,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, input.currentStatus),
          eq(agentRuns.leaseOwner, input.leaseOwner),
          eq(agentRuns.leaseVersion, input.leaseVersion),
          eq(agentRuns.currentStepAttemptId, input.stepAttemptId),
        ),
      )
      .returning()
    if (!run) {
      return undefined
    }

    const [step] = await tx
      .update(agentRunSteps)
      .set({
        status: 'completed',
        outputJson: input.outputJson,
        // completed 只表示“已派发的外部调用拿到合法结果”。纯本地步骤继续保留
        // not_dispatched，避免审计页把 SearchService 等本地工作误报成云端调用。
        externalCallStatus: sql`case when ${agentRunSteps.externalCallStatus} = 'dispatched' then 'completed' else ${agentRunSteps.externalCallStatus} end`,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRunSteps.runId, input.runId),
          eq(agentRunSteps.stepAttemptId, input.stepAttemptId),
          eq(agentRunSteps.status, 'running'),
        ),
      )
      .returning()
    if (!step) {
      throw new Error('Claimed Agent step disappeared before commit')
    }
    await tx.insert(agentRunEvents).values({
      id: randomUUID(),
      runId: input.runId,
      eventType: 'step_committed',
      payloadJson: {
        step_attempt_id: input.stepAttemptId,
        next_status: input.transition.status,
      },
      createdAt: now,
    })
    return run
  })
}

/**
 * 恢复过期租约：未派发的尝试可回到 queued；已派发的外部请求只能进入
 * outcome_unknown。每次更新仍匹配旧 owner/version/过期时间，避免恢复扫描误伤已续租的 run。
 */
export async function recoverExpiredAgentRuns(db: Database, now = new Date()) {
  const expired = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['extracting_intent', 'searching']),
        lte(agentRuns.leaseExpiresAt, now),
      ),
    )
  let requeued = 0
  let outcomeUnknown = 0

  for (const candidate of expired) {
    const unknown = candidate.externalCallStatus === 'dispatched'
    const nextStatus = unknown ? 'outcome_unknown' : 'queued'
    const updated = await db.transaction(async (transaction) => {
      const tx = transaction as Database
      const [run] = await tx
        .update(agentRuns)
        .set({
          status: nextStatus,
          leaseOwner: null,
          leaseExpiresAt: null,
          currentStepAttemptId: unknown ? candidate.currentStepAttemptId : null,
          externalCallStatus: unknown ? 'outcome_unknown' : null,
          errorCode: unknown ? 'AGENT_EXTERNAL_OUTCOME_UNKNOWN' : null,
          errorMessage: unknown ? '外部请求已派发，但 Server 未收到可确认的结果。' : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, candidate.id),
            eq(agentRuns.status, candidate.status),
            eq(agentRuns.leaseVersion, candidate.leaseVersion),
            eq(agentRuns.leaseOwner, candidate.leaseOwner!),
            lte(agentRuns.leaseExpiresAt, now),
          ),
        )
        .returning()
      if (!run) return false

      if (candidate.currentStepAttemptId) {
        const [step] = await tx
          .update(agentRunSteps)
          .set({
            status: unknown ? 'outcome_unknown' : 'lease_expired',
            externalCallStatus: unknown
              ? 'outcome_unknown'
              : (candidate.externalCallStatus ?? 'not_dispatched'),
            errorCode: unknown ? 'AGENT_EXTERNAL_OUTCOME_UNKNOWN' : 'AGENT_LEASE_EXPIRED',
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(agentRunSteps.stepAttemptId, candidate.currentStepAttemptId))
          .returning()
        if (!step) {
          throw new Error('Expired Agent run lost its current step before recovery')
        }
      }
      await tx.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: candidate.id,
        eventType: unknown ? 'external_outcome_unknown' : 'lease_expired_requeued',
        payloadJson: {
          step_attempt_id: candidate.currentStepAttemptId,
          lease_version: candidate.leaseVersion,
        },
        createdAt: now,
      })
      return true
    })
    if (!updated) {
      continue
    }
    if (unknown) {
      outcomeUnknown += 1
    } else {
      requeued += 1
    }
  }

  return { requeued, outcomeUnknown }
}

/**
 * 终止超过活动执行上限的纯本地步骤。已 dispatched 的外部请求不能在结果未知时
 * 伪装成普通超时；它继续由租约恢复转为 outcome_unknown，避免自动重复计费。
 */
export async function timeoutActiveAgentRuns(
  db: Database,
  input: { activityTimeoutMs: number; now?: Date },
) {
  const now = input.now ?? new Date()
  const startedBefore = new Date(now.getTime() - input.activityTimeoutMs)
  const candidates = await db
    .select({ run: agentRuns, step: agentRunSteps })
    .from(agentRuns)
    .innerJoin(
      agentRunSteps,
      and(
        eq(agentRunSteps.runId, agentRuns.id),
        eq(agentRunSteps.stepAttemptId, agentRuns.currentStepAttemptId),
      ),
    )
    .where(
      and(
        inArray(agentRuns.status, ['extracting_intent', 'searching']),
        eq(agentRunSteps.status, 'running'),
        lte(agentRunSteps.startedAt, startedBefore),
        ne(agentRunSteps.externalCallStatus, 'dispatched'),
      ),
    )
  let timedOut = 0
  for (const candidate of candidates) {
    const updated = await db.transaction(async (transaction) => {
      const tx = transaction as Database
      const [run] = await tx
        .update(agentRuns)
        .set({
          status: 'timed_out',
          leaseOwner: null,
          leaseExpiresAt: null,
          currentStepAttemptId: null,
          externalCallStatus: null,
          errorCode: 'AGENT_ACTIVITY_TIMED_OUT',
          errorMessage: 'Agent 活动执行时间超过配置上限。',
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, candidate.run.id),
            eq(agentRuns.status, candidate.run.status),
            eq(agentRuns.leaseVersion, candidate.run.leaseVersion),
            eq(agentRuns.currentStepAttemptId, candidate.step.stepAttemptId),
          ),
        )
        .returning()
      if (!run) return false
      const [step] = await tx
        .update(agentRunSteps)
        .set({
          status: 'timed_out',
          errorCode: 'AGENT_ACTIVITY_TIMED_OUT',
          errorMessage: 'Agent 活动执行时间超过配置上限。',
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRunSteps.stepAttemptId, candidate.step.stepAttemptId),
            eq(agentRunSteps.status, 'running'),
          ),
        )
        .returning()
      if (!step) {
        throw new Error('Timed out Agent run lost its current step before commit')
      }
      await tx.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: candidate.run.id,
        eventType: 'run_timed_out',
        payloadJson: {
          step_attempt_id: candidate.step.stepAttemptId,
          activity_timeout_ms: input.activityTimeoutMs,
        },
        createdAt: now,
      })
      return true
    })
    if (updated) timedOut += 1
  }
  return timedOut
}

/** 读取 run 的规范化恢复事实，不依赖 Provider 原始消息或隐藏思考过程。 */
export async function getDurableAgentRun(db: Database, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) {
    return undefined
  }
  const [authorization] = await db
    .select()
    .from(agentRunAuthorizations)
    .where(eq(agentRunAuthorizations.runId, runId))
    .limit(1)
  const steps = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.createdAt))
  const events = await db
    .select()
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId))
    .orderBy(asc(agentRunEvents.createdAt))
  const candidates = await db
    .select()
    .from(agentRunCandidates)
    .where(eq(agentRunCandidates.runId, runId))
    .orderBy(asc(agentRunCandidates.rank))
  return { run, authorization, steps, events, candidates }
}

type UserInputResult =
  | { kind: 'accepted' | 'duplicate'; run: typeof agentRuns.$inferSelect }
  | { kind: 'not_found' | 'invalid_state' | 'step_mismatch' | 'expired' }

/**
 * 幂等键只能重放完全相同的用户动作。若同一个 client_request_id 被复用于另一种
 * 动作或不同目标步骤，返回状态冲突，避免把一次取消误认成一次澄清已成功。
 */
function matchesStoredInput(
  stored: typeof agentRunInputs.$inferSelect,
  expected: { inputType: string; stepAttemptId?: string; waitingStepId?: string },
) {
  return (
    stored.inputType === expected.inputType &&
    (expected.stepAttemptId === undefined || stored.stepAttemptId === expected.stepAttemptId) &&
    (expected.waitingStepId === undefined || stored.waitingStepId === expected.waitingStepId)
  )
}

/**
 * 保存澄清输入并把同一 run 重新排队。client_request_id 的唯一约束保证
 * 用户或浏览器重试时不会写入两份澄清事实。
 */
export async function resumeWaitingAgentRun(
  db: Database,
  input: {
    runId: string
    waitingStepId: string
    clientRequestId: string
    response: string
  },
  now = new Date(),
): Promise<UserInputResult> {
  const [existingInput] = await db
    .select()
    .from(agentRunInputs)
    .where(
      and(
        eq(agentRunInputs.runId, input.runId),
        eq(agentRunInputs.clientRequestId, input.clientRequestId),
      ),
    )
    .limit(1)
  if (existingInput) {
    if (
      !matchesStoredInput(existingInput, {
        inputType: 'clarification',
        waitingStepId: input.waitingStepId,
      })
    ) {
      return { kind: 'invalid_state' }
    }
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
    return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
  }

  const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
  if (!current) return { kind: 'not_found' }
  if (current.status !== 'waiting_for_user_input') return { kind: 'invalid_state' }
  if (current.waitingStepId !== input.waitingStepId) return { kind: 'step_mismatch' }
  if (!current.waitingExpiresAt || current.waitingExpiresAt <= now) {
    await db
      .update(agentRuns)
      .set({
        status: 'expired',
        errorCode: 'AGENT_WAITING_EXPIRED',
        errorMessage: '等待用户输入已超过保留期。',
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, 'waiting_for_user_input'),
          eq(agentRuns.waitingStepId, input.waitingStepId),
        ),
      )
    return { kind: 'expired' }
  }

  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const [saved] = await tx
      .insert(agentRunInputs)
      .values({
        id: randomUUID(),
        runId: input.runId,
        waitingStepId: input.waitingStepId,
        clientRequestId: input.clientRequestId,
        inputType: 'clarification',
        responseJson: { response: input.response },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!saved) {
      const [stored] = await tx
        .select()
        .from(agentRunInputs)
        .where(
          and(
            eq(agentRunInputs.runId, input.runId),
            eq(agentRunInputs.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1)
      if (
        !stored ||
        !matchesStoredInput(stored, {
          inputType: 'clarification',
          waitingStepId: input.waitingStepId,
        })
      ) {
        return { kind: 'invalid_state' }
      }
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
      return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
    }
    const [run] = await tx
      .update(agentRuns)
      .set({
        status: 'queued',
        // Phase A 的澄清点位于 AgentIntent 之后。恢复必须继续搜索，不能因调用方
        // 遗漏 next_step 而再次外发用户原文做第二轮意图识别。
        nextStep: 'searching',
        waitingStepId: null,
        waitingExpiresAt: null,
        nextAttemptAt: now,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, 'waiting_for_user_input'),
          eq(agentRuns.waitingStepId, input.waitingStepId),
          gt(agentRuns.waitingExpiresAt, now),
        ),
      )
      .returning()
    if (!run) {
      throw new Error('Agent waiting state changed while clarification was being saved')
    }
    await tx.insert(agentRunEvents).values({
      id: randomUUID(),
      runId: input.runId,
      eventType: 'user_input_received',
      payloadJson: { waiting_step_id: input.waitingStepId },
      createdAt: now,
    })
    return { kind: 'accepted', run }
  })
}

/** queued/等待态尚无外部调用，可立即 cancelled；活动步骤先记 cancel_requested。 */
export async function cancelDurableAgentRun(
  db: Database,
  input: { runId: string; clientRequestId: string; reason?: string },
  now = new Date(),
): Promise<UserInputResult> {
  const [existingInput] = await db
    .select()
    .from(agentRunInputs)
    .where(
      and(
        eq(agentRunInputs.runId, input.runId),
        eq(agentRunInputs.clientRequestId, input.clientRequestId),
      ),
    )
    .limit(1)
  if (existingInput) {
    if (!matchesStoredInput(existingInput, { inputType: 'cancel' })) {
      return { kind: 'invalid_state' }
    }
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
    return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
  }
  const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
  if (!current) return { kind: 'not_found' }
  const immediatelyCancellable = [
    'queued',
    'waiting_for_user_input',
    'waiting_for_export_selection',
    'waiting_for_confirmation',
  ].includes(current.status)
  if (!immediatelyCancellable && !['extracting_intent', 'searching'].includes(current.status)) {
    return { kind: 'invalid_state' }
  }

  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const [saved] = await tx
      .insert(agentRunInputs)
      .values({
        id: randomUUID(),
        runId: input.runId,
        clientRequestId: input.clientRequestId,
        inputType: 'cancel',
        responseJson: { reason: input.reason ?? null },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!saved) {
      const [stored] = await tx
        .select()
        .from(agentRunInputs)
        .where(
          and(
            eq(agentRunInputs.runId, input.runId),
            eq(agentRunInputs.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1)
      if (!stored || !matchesStoredInput(stored, { inputType: 'cancel' })) {
        return { kind: 'invalid_state' }
      }
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
      return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
    }
    const [run] = await tx
      .update(agentRuns)
      .set({
        status: immediatelyCancellable ? 'cancelled' : 'cancel_requested',
        cancelReason: input.reason ?? null,
        waitingStepId: null,
        waitingExpiresAt: null,
        finishedAt: immediatelyCancellable ? now : null,
        updatedAt: now,
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, current.status)))
      .returning()
    if (!run) throw new Error('Agent state changed while cancellation was being saved')
    await tx.insert(agentRunEvents).values({
      id: randomUUID(),
      runId: input.runId,
      eventType: immediatelyCancellable ? 'run_cancelled' : 'cancel_requested',
      payloadJson: { reason: input.reason ?? null },
      createdAt: now,
    })
    return { kind: 'accepted', run }
  })
}

/** outcome_unknown 必须经过独立用户授权才能创建新步骤尝试。 */
export async function retryUnknownAgentRun(
  db: Database,
  input: { runId: string; stepAttemptId: string; clientRequestId: string },
  now = new Date(),
): Promise<UserInputResult> {
  const [existingInput] = await db
    .select()
    .from(agentRunInputs)
    .where(
      and(
        eq(agentRunInputs.runId, input.runId),
        eq(agentRunInputs.clientRequestId, input.clientRequestId),
      ),
    )
    .limit(1)
  if (existingInput) {
    if (
      !matchesStoredInput(existingInput, {
        inputType: 'retry_unknown',
        stepAttemptId: input.stepAttemptId,
      })
    ) {
      return { kind: 'invalid_state' }
    }
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
    return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
  }
  const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
  if (!current) return { kind: 'not_found' }
  if (current.status !== 'outcome_unknown') return { kind: 'invalid_state' }
  if (current.currentStepAttemptId !== input.stepAttemptId) return { kind: 'step_mismatch' }

  return db.transaction(async (transaction) => {
    const tx = transaction as Database
    const [saved] = await tx
      .insert(agentRunInputs)
      .values({
        id: randomUUID(),
        runId: input.runId,
        stepAttemptId: input.stepAttemptId,
        clientRequestId: input.clientRequestId,
        inputType: 'retry_unknown',
        responseJson: { authorized: true },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!saved) {
      const [stored] = await tx
        .select()
        .from(agentRunInputs)
        .where(
          and(
            eq(agentRunInputs.runId, input.runId),
            eq(agentRunInputs.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1)
      if (
        !stored ||
        !matchesStoredInput(stored, {
          inputType: 'retry_unknown',
          stepAttemptId: input.stepAttemptId,
        })
      ) {
        return { kind: 'invalid_state' }
      }
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).limit(1)
      return run ? { kind: 'duplicate', run } : { kind: 'not_found' }
    }
    const [run] = await tx
      .update(agentRuns)
      .set({
        status: 'queued',
        currentStepAttemptId: null,
        externalCallStatus: null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, 'outcome_unknown'),
          eq(agentRuns.currentStepAttemptId, input.stepAttemptId),
        ),
      )
      .returning()
    if (!run) throw new Error('Agent outcome_unknown state changed while retry was being saved')
    await tx.insert(agentRunEvents).values({
      id: randomUUID(),
      runId: input.runId,
      eventType: 'unknown_retry_authorized',
      payloadJson: { previous_step_attempt_id: input.stepAttemptId },
      createdAt: now,
    })
    return { kind: 'accepted', run }
  })
}

/** 将到期等待态明确转为 expired，保留 run 和已有审计事实。 */
export async function expireWaitingAgentRuns(db: Database, now = new Date()) {
  const rows = await db
    .update(agentRuns)
    .set({
      status: 'expired',
      errorCode: 'AGENT_WAITING_EXPIRED',
      errorMessage: '等待用户操作已超过保留期。',
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(agentRuns.status, [
          'waiting_for_user_input',
          'waiting_for_export_selection',
          'waiting_for_confirmation',
        ]),
        lte(agentRuns.waitingExpiresAt, now),
      ),
    )
    .returning()
  return rows.length
}

/**
 * 活动步骤取消先写 cancel_requested，使原执行器的 status 条件提交立即失效。
 * 等旧租约到期后再清理租约并转成 cancelled，避免把“已请求停止”误报成“已安全停止”。
 */
export async function finalizeCancelledAgentRuns(db: Database, now = new Date()) {
  const candidates = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, 'cancel_requested'),
        or(isNull(agentRuns.leaseExpiresAt), lte(agentRuns.leaseExpiresAt, now)),
      ),
    )
  let finalized = 0
  for (const candidate of candidates) {
    const updated = await db.transaction(async (transaction) => {
      const tx = transaction as Database
      const [run] = await tx
        .update(agentRuns)
        .set({
          status: 'cancelled',
          leaseOwner: null,
          leaseExpiresAt: null,
          currentStepAttemptId: null,
          externalCallStatus: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, candidate.id),
            eq(agentRuns.status, 'cancel_requested'),
            eq(agentRuns.leaseVersion, candidate.leaseVersion),
            or(isNull(agentRuns.leaseExpiresAt), lte(agentRuns.leaseExpiresAt, now)),
          ),
        )
        .returning()
      if (!run) return false
      if (candidate.currentStepAttemptId) {
        await tx
          .update(agentRunSteps)
          .set({
            status: 'cancelled',
            errorCode: 'AGENT_CANCELLED',
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentRunSteps.stepAttemptId, candidate.currentStepAttemptId),
              eq(agentRunSteps.status, 'running'),
            ),
          )
      }
      await tx.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: candidate.id,
        eventType: 'run_cancelled',
        payloadJson: { reason: candidate.cancelReason },
        createdAt: now,
      })
      return true
    })
    if (updated) finalized += 1
  }
  return finalized
}
