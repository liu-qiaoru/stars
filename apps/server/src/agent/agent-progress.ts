/**
 * 将已持久化的步骤和安全轨迹投影为页面时间线。这里只解释执行事实，不调用模型。
 * 决策步骤与工具步骤分开：模型提出 search_media 不代表搜索已执行。
 */
export function buildAgentProgress(
  run: {
    status: string
    createdAt: Date
    updatedAt: Date
    finishedAt: Date | null
    enforcedScopeJson: unknown
  },
  steps: Array<{
    stepAttemptId: string
    stepKind: string
    status: string
    outputJson: unknown
    startedAt: Date
    finishedAt: Date | null
  }>,
  traces: Array<{
    spanId: string
    operation: string
    status: string
    startedAt: Date
    finishedAt: Date | null
    attributesJson: unknown
  }>,
  reranks: Array<{
    id: string
    status: string
    createdAt: Date
    dispatchedAt: Date | null
    finishedAt: Date | null
  }> = [],
) {
  const active = [
    'queued',
    'extracting_intent',
    'searching',
    'ranking',
    'cancel_requested',
  ].includes(run.status)
  const retrieval = Boolean(
    (run.enforcedScopeJson as { retrieval_agent?: boolean })?.retrieval_agent,
  )
  const items: Array<{
    id: string
    label: string
    status: string
    started_at: string
    finished_at: string | null
    parent_id: string | null
  }> = []
  const add = (
    id: string,
    label: string,
    status: string,
    start: Date,
    end: Date | null,
    parent: string | null = null,
  ) => {
    items.push({
      id,
      label,
      status,
      started_at: start.toISOString(),
      finished_at: end?.toISOString() ?? null,
      parent_id: parent,
    })
  }
  add('created', '创建任务', 'succeeded', run.createdAt, run.createdAt)
  let pending: string | null = null
  let searchCount = 0
  for (const step of steps) {
    const output = step.outputJson as {
      tool_status?: string
      retry?: boolean
      evidence_preparation?: string
      retrieval_state?: { pending?: { action: string } | null }
    } | null
    const tool = pending
    const skippedTool = tool && step.status === 'completed' && !output?.tool_status
    const label =
      step.stepKind === 'extracting_intent'
        ? '理解请求'
        : output?.evidence_preparation === 'scene_frames'
          ? '准备场景采样画面'
        : output?.evidence_preparation === 'matched_candidates'
          ? '准备搜索命中的图文证据'
        : skippedTool
          ? '检查执行限制'
          : !retrieval
            ? '执行检索'
            : output?.evidence_preparation === 'candidate_overviews'
              ? '准备候选画面概要'
            : tool === 'search_media'
              ? ++searchCount === 1
                ? '执行检索'
                : `补充检索（第 ${searchCount} 次）`
              : tool === 'inspect_segment_frames'
                ? '模型检查采样画面'
              : tool === 'get_segment_details_batch'
                ? '批量读取片段详情'
              : tool === 'get_segment_details'
                ? '读取片段详情'
                : '根据结果决定下一步'
    const status =
      output?.tool_status === 'failed' || output?.retry
        ? 'failed'
        : step.status === 'completed'
          ? 'succeeded'
          : step.status === 'running' && !active
            ? 'interrupted'
            : step.status
    add(step.stepAttemptId, label, status, step.startedAt, step.finishedAt)
    if (output?.retrieval_state) pending = output.retrieval_state.pending?.action ?? null
  }
  const operations: Record<string, string> = {
    retrieving: '检索素材',
    rrf: 'RRF 排名融合',
    ranking: '合并排序',
    rerank_candidates: 'Rerank 候选重排',
  }
  for (const trace of traces) {
    if (trace.operation === 'rerank_candidates' && reranks.length) continue
    const label = operations[trace.operation]
    if (!label) continue
    const parent =
      (trace.attributesJson as { step_attempt_id?: string } | null)?.step_attempt_id ?? null
    const step = steps.find((item) => item.stepAttemptId === parent)
    // 崩溃或失去租约的历史轨迹不能永远显示“进行中”；也不把未知结果伪装成成功。
    const interrupted = !active || (step && step.status !== 'running')
    add(
      trace.spanId,
      label,
      trace.status === 'running' && interrupted ? 'interrupted' : trace.status,
      trace.startedAt,
      trace.finishedAt,
      parent,
    )
  }
  for (const attempt of reranks) {
    // 证据准备与已派发的重排是两个事实，完成后也保留准备阶段，不依赖当前页面状态。
    add(
      `${attempt.id}:evidence`,
      '准备重排证据',
      attempt.dispatchedAt
        ? 'succeeded'
        : attempt.status === 'preparing_evidence' && active
          ? 'running'
          : attempt.status === 'failed'
            ? 'failed'
            : 'interrupted',
      attempt.createdAt,
      attempt.dispatchedAt ?? attempt.finishedAt,
    )
    if (attempt.dispatchedAt)
      add(
        `${attempt.id}:rerank`,
        'Rerank 候选重排',
        attempt.status === 'running' && !active ? 'interrupted' : attempt.status,
        attempt.dispatchedAt,
        attempt.finishedAt,
      )
  }
  const ending: Record<string, string> = {
    queued: '等待执行',
    waiting_for_user_input: '等待补充信息',
    waiting_for_export_selection: '等待选择导出素材',
    waiting_for_confirmation: '等待导出确认',
    cancel_requested: '正在取消，等待当前调用结束',
    cancelled: '任务已取消',
    succeeded: '任务完成',
    completed_with_errors: '任务结束，存在未完成项',
    failed: '任务失败',
    timed_out: '任务超时',
    outcome_unknown: '调用结果未知，等待处理',
  }
  if (ending[run.status])
    add(
      'run-state',
      ending[run.status],
      active ? 'running' : run.status === 'succeeded' ? 'succeeded' : 'stopped',
      run.finishedAt ?? run.updatedAt,
      run.finishedAt,
    )
  // 相同毫秒保持插入顺序，父步骤先于其内部搜索阶段。
  return items.sort((a, b) => a.started_at.localeCompare(b.started_at))
}
