'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, Clock3, Send, ShieldCheck, SlidersHorizontal, Square } from 'lucide-react'
import {
  createApiClient,
  type AgentRunDetail,
  type JobSummary,
} from '../lib/api-client'
import { Alert } from './ui/alert'
import { formatMediaType, formatStatus } from '../lib/display-labels'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { WorkspaceHeader } from './workspace-header'

const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'completed_with_errors',
  'cancelled',
  'expired',
])
// 只有这些状态会在后台自行推进，因此才需要定时读取 Server。等待用户选择或确认的
// 状态不会自行变化，继续轮询只会制造无意义的 HTTP 请求。
const pollingRunStatuses = new Set(['queued', 'extracting_intent', 'searching', 'ranking', 'cancel_requested'])
const terminalJobStatuses = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * 已经得到候选或进入导出确认后，用户可以直接发起下一轮检索。旧 Run 会保留为
 * 当前页面中的历史消息；仍在理解、检索或排序的 Run 则保持单请求串行，避免状态串线。
 */
function canStartNewSearch(run: AgentRunDetail | null) {
  if (!run) return true
  return terminalRunStatuses.has(run.status)
    || run.status === 'waiting_for_export_selection'
    || run.status === 'waiting_for_confirmation'
}

function runStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: '等待处理',
    extracting_intent: '理解请求',
    searching: '检索素材',
    ranking: '初步排序完成，正在进行智能重排',
    waiting_for_user_input: '等待补充信息',
    cancel_requested: '正在取消',
    waiting_for_export_selection: '请选择导出片段',
    waiting_for_confirmation: '等待确认导出',
    succeeded: '已完成',
    failed: '失败',
    timed_out: '执行超时',
    completed_with_errors: '部分完成',
    cancelled: '已取消',
    expired: '已过期',
    outcome_unknown: '外部结果未知',
  }
  return labels[status] ?? status
}

type AgentApiClient = Pick<
  ReturnType<typeof createApiClient>,
  | 'createAgentRun'
  | 'getAgentRun'
  | 'getAgentSettings'
  | 'selectAgentExport'
  | 'confirmAgentExport'
  | 'getJob'
  | 'retryUnknownAgentRun'
  | 'cancelAgentRun'
  | 'mediaContentUrl'
> & Partial<Pick<ReturnType<typeof createApiClient>, 'resumeAgentRun'>>

/**
 * Phase C 工作台只编排持久化 API。刷新或 Server 重启后，页面读取 PostgreSQL 中已经
 * 提交的 intent、候选和 Job，不会在浏览器重复调用 AgentIntent 或 SearchService。
 */
export function AgentWorkspace({ apiClient }: { apiClient?: AgentApiClient }) {
  // Agent 页有配置读取和状态轮询两个 Effect；一次挂载内复用默认 Client，避免状态
  // 更新时改变依赖对象并重新启动请求。props 注入的 fake Client 仍用于自动化测试。
  const defaultClient = useMemo(() => createApiClient(), [])
  const client = apiClient ?? defaultClient
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<AgentRunDetail | null>(null)
  // Server 中的每次 Run 仍是独立且可审计的。Web 只在当前页面会话中保留
  // 已完成 Run 的快照，用于构成连续 Chat 流，不会把多次查询伪装成一个 Server Run。
  const [previousRuns, setPreviousRuns] = useState<AgentRunDetail[]>([])
  const [job, setJob] = useState<JobSummary | null>(null)
  const [visualAuthorized, setVisualAuthorized] = useState(false)
  const [sceneAuthorized, setSceneAuthorized] = useState(false)
  const [sceneAvailable, setSceneAvailable] = useState(false)
  const [matchedAuthorized, setMatchedAuthorized] = useState(false)
  const [matchedAvailable, setMatchedAvailable] = useState(false)
  const [decisionModel, setDecisionModel] = useState('glm-5.3')
  const [mediaTextAuthorized, setMediaTextAuthorized] = useState(false)
  const [clarification, setClarification] = useState('')
  const [agentAvailable, setAgentAvailable] = useState(false)
  const [legacyWorkflow, setLegacyWorkflow] = useState(false)
  const [searchScope, setSearchScope] = useState<'auto' | 'visual' | 'spoken' | 'all'>('auto')
  const [rerankAvailable, setRerankAvailable] = useState(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(2_000)
  const [unknownActionPending, setUnknownActionPending] = useState(false)
  const [statusMessage, setStatusMessage] = useState(
    '输入目标后，智能助手会搜索、读取已有证据，并按缺口补充搜索。',
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedCandidate = useMemo(
    () => run?.candidates?.find((candidate) => candidate.candidate_key === selectedKey) ?? null,
    [run, selectedKey],
  )
  const [startSeconds, setStartSeconds] = useState('')
  const [endSeconds, setEndSeconds] = useState('')
  const [confirmation, setConfirmation] = useState<{
    waiting_step_id: string
    tool_call_id: string
    preview: {
      candidate_key: string
      file_id: string
      scene_id: string
      start_time_seconds: number
      end_time_seconds: number
      output_format: 'mp4'
    }
  } | null>(null)
  const [exportActionError, setExportActionError] = useState<string | null>(null)
  const composerFormRef = useRef<HTMLFormElement>(null)
  const conversationEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void client
      .getAgentSettings({ signal: controller.signal })
      .then((settings) => {
        setDecisionModel(settings.model)
        setSceneAvailable(Boolean(settings.capabilities.scene_inspection_available))
        setMatchedAvailable(Boolean(settings.capabilities.matched_evidence_available))
        setPollIntervalMs(settings.editable.web_poll_interval_ms)
        setRerankAvailable(settings.capabilities.rerank_available)
        setAgentAvailable(settings.capabilities.external_text_available)
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setStatusMessage(
            error instanceof Error ? `读取轮询配置失败：${error.message}` : '读取轮询配置失败。',
          )
        }
      })
    return () => controller.abort()
  }, [client])

  useEffect(() => {
    const persistedRunId = window.localStorage.getItem('agent:last-run-id')
    if (!persistedRunId) return
    const controller = new AbortController()
    void client
      .getAgentRun(persistedRunId, { signal: controller.signal })
      .then(async (persistedRun) => {
        setRun(persistedRun)
        setVisualAuthorized(Boolean(persistedRun.authorization?.allow_external_visual))
        setSceneAuthorized(Boolean(persistedRun.authorization?.allow_external_scene_visual))
        setMatchedAuthorized(Boolean(persistedRun.authorization?.allow_external_retrieval_visual))
        setMediaTextAuthorized(Boolean(persistedRun.authorization?.allow_external_media_text))
        restoreConfirmation(persistedRun)
        if (persistedRun.export_job?.id) {
          setJob(await client.getJob(persistedRun.export_job.id, { signal: controller.signal }))
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          // 网络失败或 Server 重启不代表持久化 run 已消失；保留 run_id 供下一次挂载恢复。
          setStatusMessage(
            error instanceof Error ? `恢复 run 失败：${error.message}` : '恢复 run 失败。',
          )
        }
      })
    return () => controller.abort()
  }, [client])

  const refreshPersistedState = useCallback(
    async (signal?: AbortSignal) => {
      if (!run) return
      // run 与导出 Job 是两个独立生命周期：run 终态后不再重复读取它，
      // 但 queued/running Job 仍继续轮询，直到 Worker 写入终态。
      const nextRun = pollingRunStatuses.has(run.status)
        ? await client.getAgentRun(run.id, { signal })
        : run
      if (nextRun !== run) setRun(nextRun)
      const jobId = nextRun.export_job?.id ?? job?.id
      if (jobId && (!job || !terminalJobStatuses.has(job.status))) {
        setJob(await client.getJob(jobId, { signal }))
      }
    },
    [client, job, run],
  )

  useEffect(() => {
    if (!run) return
    const runDone = !pollingRunStatuses.has(run.status)
    const jobDone = !job || terminalJobStatuses.has(job.status)
    if (runDone && jobDone) return
    let disposed = false
    let timerId: number | undefined
    let requestController: AbortController | undefined
    const poll = async () => {
      if (disposed || document.visibilityState === 'hidden') return
      requestController?.abort()
      requestController = new AbortController()
      try {
        await refreshPersistedState(requestController.signal)
      } catch (pollError) {
        if (!(pollError instanceof DOMException && pollError.name === 'AbortError')) {
          setStatusMessage(
            pollError instanceof Error ? `状态刷新失败：${pollError.message}` : '状态刷新失败。',
          )
        }
      } finally {
        if (!disposed) timerId = window.setTimeout(poll, pollIntervalMs)
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (timerId) window.clearTimeout(timerId)
        void poll()
      } else {
        // 页面隐藏不仅停止下一轮，也取消正在等待的 run/Job HTTP 请求。
        requestController?.abort()
      }
    }
    timerId = window.setTimeout(poll, pollIntervalMs)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      requestController?.abort()
      if (timerId) window.clearTimeout(timerId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [job, pollIntervalMs, refreshPersistedState, run])

  async function startRun() {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || !canStartNewSearch(run)) return
    setStatusMessage('正在创建检索任务。')
    try {
      const created = await client.createAgentRun({
        prompt: trimmedPrompt,
        allow_external_text: true,
        allow_external_visual: visualAuthorized,
        allow_external_media_text: !legacyWorkflow && mediaTextAuthorized,
        ...(!legacyWorkflow && matchedAuthorized ? { allow_external_retrieval_visual: true } : {}),
        ...(!legacyWorkflow && sceneAuthorized ? { allow_external_scene_visual: true } : {}),
        workflow: legacyWorkflow ? 'legacy' : 'retrieval_agent',
        ...(!legacyWorkflow && searchScope !== 'auto' ? { search_scope: searchScope } : {}),
        // 新检索流程支持语音素材；旧视觉重排仍只接收图片和视频。
        media_types: legacyWorkflow || searchScope === 'visual' ? ['image', 'video'] : searchScope === 'spoken' ? ['video', 'audio'] : ['image', 'video', 'audio'],
      })
      const detail = await client.getAgentRun(created.run_id)
      // 只有新 Run 确认创建成功后才归档旧 Run。创建失败时保留原结果和导出操作，
      // 防止同一轮消息同时出现在“历史”和“当前”两个位置。
      if (run) {
        setPreviousRuns((current) => (
          current.some((item) => item.id === run.id) ? current : [...current, run]
        ))
      }
      window.localStorage.setItem('agent:last-run-id', created.run_id)
      setRun(detail)
      setPrompt('')
      setJob(null)
      setSelectedKey(null)
      setConfirmation(null)
      setExportActionError(null)
      setStatusMessage(`检索任务已创建：${runStatusLabel(created.status)}`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? `创建检索失败：${error.message}` : '创建检索失败。')
    }
  }

  useEffect(() => {
    // 新的用户请求、状态更新或结果返回后，把对话末尾移入可见区域。
    // 使用即时滚动，避免强制动画对减少动效用户造成干扰。
    if (!run && previousRuns.length === 0) return
    if (typeof conversationEndRef.current?.scrollIntoView === 'function') {
      conversationEndRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [previousRuns.length, run?.id, run?.status])

  function chooseCandidate(candidate: NonNullable<AgentRunDetail['candidates']>[number]) {
    setSelectedKey(candidate.candidate_key)
    setStartSeconds(String(candidate.scene_start_seconds ?? 0))
    setEndSeconds(String(candidate.scene_end_seconds ?? 0))
    setConfirmation(null)
    setExportActionError(null)
  }

  async function previewExport() {
    if (!run || !selectedCandidate || run.status !== 'waiting_for_export_selection') return
    setExportActionError(null)
    try {
      const result = await client.selectAgentExport(run.id, {
        candidate_key: selectedCandidate.candidate_key,
        start_time_seconds: Number(startSeconds),
        end_time_seconds: Number(endSeconds),
        output_format: 'mp4',
      })
      setConfirmation({
        waiting_step_id: result.waiting_step_id,
        tool_call_id: result.tool_call_id,
        preview: result.preview,
      })
      setRun(await client.getAgentRun(run.id))
      setStatusMessage('服务端已重新校验候选与时间范围，请确认导出。')
    } catch (error) {
      // 即使页面状态与 Server 在极短时间内发生竞态，也要在导出区域明确反馈，不能只让
      // 请求以未处理异常结束。Server 仍是状态和范围校验的最终事实来源。
      setExportActionError(
        error instanceof Error ? `无法生成导出预览：${error.message}` : '无法生成导出预览。',
      )
    }
  }

  async function confirmExport() {
    if (!run || !confirmation) return
    const result = await client.confirmAgentExport(run.id, {
      waiting_step_id: confirmation.waiting_step_id,
      tool_call_id: confirmation.tool_call_id,
      client_request_id: crypto.randomUUID(),
    })
    const [nextRun, nextJob] = await Promise.all([
      client.getAgentRun(run.id),
      client.getJob(result.job_id),
    ])
    setRun(nextRun)
    setJob(nextJob)
    setStatusMessage('智能检索任务已确认；视频片段仍由后台任务进程独立导出。')
  }

  function restoreConfirmation(detail: AgentRunDetail) {
    if (detail.status !== 'waiting_for_confirmation' || !detail.waiting_step_id) return
    const pending = detail.tool_calls.find(
      (toolCall) => toolCall.requires_confirmation && toolCall.preview,
    )
    if (!pending?.preview) return
    setSelectedKey(pending.preview.candidate_key)
    setStartSeconds(String(pending.preview.start_time_seconds))
    setEndSeconds(String(pending.preview.end_time_seconds))
    setConfirmation({
      waiting_step_id: detail.waiting_step_id,
      tool_call_id: pending.tool_call_id,
      preview: pending.preview,
    })
  }

  async function retryUnknown() {
    const stepAttemptId = run?.steps?.at(-1)?.step_attempt_id
    if (!run || !stepAttemptId || unknownActionPending) return
    setUnknownActionPending(true)
    try {
      await client.retryUnknownAgentRun(run.id, {
        step_attempt_id: stepAttemptId,
        client_request_id: crypto.randomUUID(),
      })
      setRun(await client.getAgentRun(run.id))
      setStatusMessage('已由用户授权重新执行；这会创建一次新的外部请求尝试。')
    } finally {
      setUnknownActionPending(false)
    }
  }

  /** 放弃只把当前 run 写成 cancelled，不会再次调用 RightAPI。 */
  async function abandonUnknown() {
    if (!run || unknownActionPending) return
    setUnknownActionPending(true)
    try {
      await client.cancelAgentRun(run.id, {
        client_request_id: crypto.randomUUID(),
        reason: run.status === 'outcome_unknown' ? '用户放弃结果未知的任务' : '用户取消任务',
      })
      setRun(await client.getAgentRun(run.id))
      setStatusMessage('已请求取消本次任务，不会再安排新的动作。')
    } finally {
      setUnknownActionPending(false)
    }
  }

  async function resumeRetrieval() {
    if (!run?.waiting_step_id || !client.resumeAgentRun || (!run.retrieval?.awaiting_rerank_authorization && !run.retrieval?.awaiting_scene_authorization && !run.retrieval?.awaiting_retrieval_visual_authorization && !clarification.trim())) return
    try {
      await client.resumeAgentRun(run.id, { waiting_step_id: run.waiting_step_id,
        client_request_id: crypto.randomUUID(), response: run.retrieval?.awaiting_retrieval_visual_authorization ? '判断命中图文' : run.retrieval?.awaiting_scene_authorization ? '检查场景画面' : run.retrieval?.awaiting_rerank_authorization ? '开始最终重排' : clarification, allow_external_media_text: mediaTextAuthorized, allow_external_visual: visualAuthorized, ...(matchedAvailable ? { allow_external_retrieval_visual: matchedAuthorized } : {}), ...(sceneAvailable ? { allow_external_scene_visual: sceneAuthorized } : {}) })
      setRun(await client.getAgentRun(run.id)); setClarification('')
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : '恢复失败。') }
  }

  const runBusy = !canStartNewSearch(run)
  const runProcessing = Boolean(run && pollingRunStatuses.has(run.status))
  const conversationEmpty = !run && previousRuns.length === 0

  return (
    <section className={conversationEmpty ? 'agent-chat-shell agent-chat-shell-empty' : 'agent-chat-shell'}>
      <WorkspaceHeader
        icon={Bot}
        title="智能检索"
        description="继续描述你要找的内容，每次结果都会保留在当前对话中。"
      />

      <div className="agent-chat-stream" aria-label="检索对话">
        {conversationEmpty ? (
          <div className="agent-chat-empty">
            <span className="agent-chat-empty-icon"><Bot aria-hidden="true" size={22} /></span>
            <h2>今天想找什么素材？</h2>
            <p>可以描述画面、人物、动作或语音内容。</p>
            <div className="agent-chat-suggestions" aria-label="检索示例">
              {['找到海边日落的视频', '查找有红色汽车的画面', '找到提到产品上线的视频'].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        ) : null}

        {previousRuns.map((previousRun) => (
          <ArchivedAgentTurn key={previousRun.id} run={previousRun} client={client} />
        ))}

        {run ? (
          <article className="agent-chat-turn" aria-label={`检索：${run.prompt}`}>
            <div className="agent-user-message">
              <p>{run.prompt}</p>
            </div>

            <div className="agent-assistant-message">
              <header className="agent-response-header">
                <span className="agent-response-avatar"><Bot aria-hidden="true" size={17} /></span>
                <div>
                  <strong>智能检索</strong>
                  <p>{run.summary ?? statusMessage}</p>
                </div>
                <div className="agent-response-actions">
                  <Badge>{runStatusLabel(run.status)}</Badge>
                  {runProcessing && run.status !== 'cancel_requested' ? <Button className="agent-cancel-action" type="button" variant="ghost" size="sm" onClick={() => void abandonUnknown()}><Square size={12} aria-hidden="true" />取消任务</Button> : null}
                </div>
              </header>

              {runProcessing ? <AgentProcessingState status={run.status} retrieval={run.workflow === 'retrieval_agent' || Boolean(run.retrieval)} /> : null}

              <AgentRunProgress key={run.id} run={run} />

              <div className="agent-run-overview">
                <div><span>识别意图</span><strong>{run.intent?.goal ?? '等待识别'}</strong></div>
                <div>
                  <span>检索范围</span>
                  <strong>
                    {run.resolved_scope
                      ? `${formatSearchScope(run.resolved_scope.search_scope)}，${run.resolved_scope.media_types.map(formatMediaType).join('、')}`
                      : '等待解析'}
                  </strong>
                </div>
              </div>

              {run.error ? <Alert>{run.error.code}：{run.error.message}</Alert> : null}

              {run.status === 'waiting_for_user_input' ? (
                <div className="agent-inline-action-panel">
                  <p>{run.clarification_question ?? '请补充检索要求。'}</p>
                  {!run.retrieval?.awaiting_rerank_authorization && !run.retrieval?.awaiting_scene_authorization && !run.retrieval?.awaiting_retrieval_visual_authorization ? <><Label htmlFor="agent-clarification">补充要求</Label>
                  <Textarea id="agent-clarification" value={clarification} onChange={event => setClarification(event.target.value)} />
                  <label><input type="checkbox" checked={mediaTextAuthorized} onChange={event => setMediaTextAuthorized(event.target.checked)} />允许向 RightAPI {decisionModel} 发送候选标识、媒体信息、画面描述与相关转录（不含图片和路径）</label></> : null}
                  <label><input type="checkbox" aria-label="允许最终图片重排" checked={visualAuthorized} disabled={!rerankAvailable} onChange={event => setVisualAuthorized(event.target.checked)} />允许向阿里云百炼发送完整查询与候选派生图片，用于最终重排</label>
                  {run.retrieval?.awaiting_scene_authorization ? <label><input type="checkbox" aria-label="允许本任务场景看图" checked={sceneAuthorized} disabled={!sceneAvailable} onChange={event => setSceneAuthorized(event.target.checked)} />允许向RightAPI deepseek-v4-flash发送最多3个候选、每个最多3张采样图；不包含路径或原视频</label> : null}
                  {run.retrieval?.awaiting_retrieval_visual_authorization ? <label><input type="checkbox" aria-label="允许本任务命中图文判断" checked={matchedAuthorized} disabled={!matchedAvailable} onChange={event => setMatchedAuthorized(event.target.checked)} />允许向RightAPI DeepSeek发送最多20个候选、每候选一张搜索命中图；文字仍需单独授权，不包含路径或原视频</label> : null}
                  <Button type="button" disabled={run.retrieval?.awaiting_retrieval_visual_authorization ? !matchedAuthorized || !matchedAvailable : run.retrieval?.awaiting_scene_authorization ? !sceneAuthorized || !sceneAvailable : run.retrieval?.awaiting_rerank_authorization ? !visualAuthorized || !rerankAvailable : !clarification.trim()} onClick={() => void resumeRetrieval()}>{run.retrieval?.awaiting_retrieval_visual_authorization ? '授权并判断命中图文' : run.retrieval?.awaiting_scene_authorization ? '授权并检查场景画面' : run.retrieval?.awaiting_rerank_authorization ? '授权并开始最终重排' : '补充并继续'}</Button>
                  <Button type="button" variant="outline" onClick={() => void abandonUnknown()}>取消任务</Button>
                </div>
              ) : null}
              {run.retrieval ? <AgentRetrievalActivity key={`retrieval-${run.id}`} run={run} runProcessing={runProcessing} /> : null}


              {run.status === 'outcome_unknown' ? (
                <div className="agent-inline-action-panel">
                  <p>上一次外部请求的结果未知。重新执行可能产生重复请求和费用，放弃不会再次调用外部服务。</p>
                  <div>
                    <Button type="button" disabled={unknownActionPending} onClick={() => void retryUnknown()}>重新执行</Button>
                    <Button type="button" variant="outline" disabled={unknownActionPending} onClick={() => void abandonUnknown()}>放弃本次任务</Button>
                  </div>
                </div>
              ) : null}

              {run.conditions?.length ? (
                <div className="agent-condition-list" aria-label="识别到的检索条件">
                  {run.conditions.map((condition) => (
                    <span key={condition.condition_id}>{condition.source_text}<small>{conditionKindLabel(condition.kind)}</small></span>
                  ))}
                </div>
              ) : null}

              <section className="agent-result-section" aria-label="检索结果">
                <div className="agent-result-heading">
                  <div><h2>检索结果</h2><p>{run.retrieval?.final_rerank_status === 'not_completed' ? '以下为保留的原文搜索基线，未经最终图片重排。' : run.retrieval?.rerank_not_applicable ? '只读文本结果，没有可用于图片重排的场景画面。' : '只展示最终重排后的顺序；排序不代表已经满足全部条件。'}</p></div>
                  {run.candidates?.length ? <strong>{run.candidates.length} 条</strong> : null}
                </div>
                {run.candidates?.length ? (
                  <div className="agent-result-grid">
                    {run.candidates.map((candidate) => {
                      const isSelected = selectedKey === candidate.candidate_key
                      const canSelectForExport = run.status === 'waiting_for_export_selection'
                        && isExportableVideoCandidate(candidate)
                      return (
                        <article key={candidate.candidate_key} className={isSelected ? 'agent-result-card agent-result-selected' : 'agent-result-card'}>
                          <CandidateMedia candidate={candidate} client={client} />
                          <div className="agent-result-copy">
                            <div><strong>结果 {candidate.rank}</strong><Badge>{run.retrieval ? '检索候选' : '智能重排'}</Badge></div>
                            <p>{formatCandidateRange(candidate)}</p>
                            {canSelectForExport ? (
                              <Button
                                type="button"
                                variant={isSelected ? 'default' : 'outline'}
                                aria-pressed={isSelected}
                                aria-label={`选择候选 ${candidate.rank}，${formatCandidateRange(candidate)}`}
                                onClick={() => chooseCandidate(candidate)}
                              >
                                {isSelected ? '已选择' : '选择片段'}
                              </Button>
                            ) : null}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                ) : <p className="agent-result-empty">{run.status === 'waiting_for_user_input' ? '补充信息后继续检索。' : run.status === 'cancel_requested' ? '正在取消，不再安排新动作。' : run.status === 'cancelled' ? '任务已取消，不再安排新动作。' : runProcessing ? (run.workflow === 'retrieval_agent' ? '正在检索并核对已有证据。' : '正在检索和排序。') : '本次没有找到符合条件的内容。'}</p>}
              </section>

              {selectedCandidate ? (
                <section className="agent-export-panel" aria-label="导出参数预览">
                  <div className="agent-result-heading"><div><h2>导出片段</h2><p>时间必须位于当前视频场景内，格式固定为 MP4。</p></div></div>
                  <div className="agent-export-fields">
                    <div><Label htmlFor="export-start">开始时间（秒）</Label><Input id="export-start" type="number" step="0.01" min={selectedCandidate.scene_start_seconds ?? 0} max={selectedCandidate.scene_end_seconds ?? undefined} value={startSeconds} disabled={Boolean(confirmation) || run.status !== 'waiting_for_export_selection'} onChange={(event) => { setStartSeconds(event.target.value); setExportActionError(null) }} /></div>
                    <div><Label htmlFor="export-end">结束时间（秒）</Label><Input id="export-end" type="number" step="0.01" min={selectedCandidate.scene_start_seconds ?? 0} max={selectedCandidate.scene_end_seconds ?? undefined} value={endSeconds} disabled={Boolean(confirmation) || run.status !== 'waiting_for_export_selection'} onChange={(event) => { setEndSeconds(event.target.value); setExportActionError(null) }} /></div>
                  </div>
                  {run.status === 'waiting_for_export_selection' && !confirmation ? (
                    <Button type="button" variant="outline" onClick={() => void previewExport()}><Clock3 aria-hidden="true" size={16} />生成确认预览</Button>
                  ) : null}
                  {exportActionError ? <Alert>{exportActionError}</Alert> : null}
                  {confirmation ? (
                    <div className="agent-confirmation-panel">
                      <p>服务端已确认 {confirmation.preview.start_time_seconds} 至 {confirmation.preview.end_time_seconds} 秒，格式为 {confirmation.preview.output_format.toUpperCase()}。</p>
                      <small>确认后只会导出这组参数。</small>
                      <Button type="button" onClick={() => void confirmExport()}><ShieldCheck aria-hidden="true" size={16} />确认并创建导出任务</Button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {job ? (
                <div className="agent-job-status" aria-live="polite">
                  <div><strong>导出任务</strong><p>检索已结束，视频片段仍在后台处理。</p></div>
                  <Badge>{formatStatus(job.status)}</Badge><span>{job.progress}%</span>
                  {job.error_message ? <Alert>{job.error_message}</Alert> : null}
                </div>
              ) : null}


            </div>
          </article>
        ) : null}
        <div className="agent-conversation-end" ref={conversationEndRef} />
      </div>

      <div className="agent-composer-dock">
        <form
          ref={composerFormRef}
          className="agent-chat-composer"
          onSubmit={(event) => { event.preventDefault(); void startRun() }}
        >
          <Label className="sr-only" htmlFor="agent-prompt">完整用户请求</Label>
          <Textarea
            id="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                composerFormRef.current?.requestSubmit()
              }
            }}
            placeholder={runBusy ? '当前检索完成后可以继续提问' : '描述你要找的图片或视频'}
            required
          />
          <div className="agent-composer-toolbar">
            {/* 两条流程共用独立图片授权；素材文字授权仅用于多轮决策，必须主动勾选。 */}
            <details className="agent-search-settings">
              <summary><SlidersHorizontal size={14} aria-hidden="true" /><span>检索设置</span><span className="agent-search-mode">{legacyWorkflow ? '检索与导出' : '多轮检索'}</span><ChevronDown size={12} aria-hidden="true" /></summary>
              <div className="agent-search-settings-body">
                <fieldset className="agent-workflow-options">
                  <legend>检索方式</legend>
                  <label className="agent-setting-option">
                    <input type="radio" name="agent-workflow" aria-label="多轮检索" checked={!legacyWorkflow} onChange={() => setLegacyWorkflow(false)} />
                    <span><strong>多轮检索</strong><small>根据已授权的命中图文判断缺口并继续搜索，最后重排候选，暂不支持导出。</small></span>
                  </label>
                  <label className="agent-setting-option">
                    <input type="radio" name="agent-workflow" aria-label="检索与导出" checked={legacyWorkflow} onChange={() => setLegacyWorkflow(true)} />
                    <span><strong>检索与导出</strong><small>搜索一次并重排候选；导出片段前仍需选择和确认。</small></span>
                  </label>
                </fieldset>
                {!legacyWorkflow ? <label className="agent-setting-option">检索内容范围
                  <select aria-label="检索内容范围" value={searchScope} onChange={event => setSearchScope(event.target.value as typeof searchScope)}>
                    <option value="auto">根据问题判断</option><option value="visual">只检索画面</option><option value="spoken">只检索转录中的词语</option><option value="all">画面与转录</option>
                  </select>
                </label> : null}
                <label className="agent-setting-option" htmlFor="agent-rerank-authorization">
                  <input id="agent-rerank-authorization" aria-label="允许智能重排" type="checkbox" checked={visualAuthorized} disabled={!rerankAvailable} onChange={event => setVisualAuthorized(event.target.checked)} />
                  <span><strong>允许智能重排</strong><small>将查询和候选派生图片发送至阿里云百炼。</small></span>
                </label>
                {!legacyWorkflow ? <label className="agent-setting-option">
                  <input type="checkbox" aria-label="允许发送素材文字用于多轮判断" checked={mediaTextAuthorized} onChange={event => setMediaTextAuthorized(event.target.checked)} />
                  <span><strong>允许发送素材文字用于多轮判断</strong><small>仅发送已有描述与相关转录，不包含图片和路径。</small></span>
                </label> : null}
                {!legacyWorkflow && matchedAvailable ? <label className="agent-setting-option"><input type="checkbox" aria-label="允许发送搜索命中图" checked={matchedAuthorized} onChange={event => setMatchedAuthorized(event.target.checked)} /><span><strong>允许命中图文判断</strong><small>向RightAPI DeepSeek发送最多20个候选，每候选一张实际命中图；用于判断缺口与是否补搜。</small></span></label> : null}
                {!legacyWorkflow && sceneAvailable ? <label className="agent-setting-option"><input type="checkbox" aria-label="允许发送场景采样图" checked={sceneAuthorized} onChange={event => setSceneAuthorized(event.target.checked)} /><span><strong>允许场景看图</strong><small>向RightAPI deepseek-v4-flash发送最多3个候选，每个最多3帧；采样帧不能核实连续动作。</small></span></label> : null}
              </div>
            </details>
            <Button type="submit" aria-label="发送检索请求" disabled={!prompt.trim() || !(legacyWorkflow ? rerankAvailable && visualAuthorized : agentAvailable) || runBusy}>
              <Send aria-hidden="true" size={17} /><span>检索</span>
            </Button>
          </div>
          <details className="agent-authorization-details">
            <summary>数据与费用说明</summary>
            <p>提交即允许将本次用户输入发送至 RightAPI {decisionModel}。素材文字需要单独勾选，未勾选会暂停等待授权；命中图文判断需单独图片授权，每次最多20个候选、每个一张命中图；额外场景看图另行授权，最多3个候选、每个3帧；不发送路径或原视频。模型决策可能多次调用并产生费用，受调用次数与时间上限约束。</p>
            {legacyWorkflow ? <p>本次查询会向阿里云百炼北京地域发送完整查询和最多 20 张候选派生图片。按最高 ¥0.216 预留，结果未知时不会自动重试。</p> : null}
            {!rerankAvailable ? <p>当前部署未启用智能重排。</p> : null}
          </details>
          <p className="agent-composer-status" role="status" aria-live="polite">{statusMessage}</p>
        </form>
      </div>
    </section>
  )
}

type AgentCandidate = NonNullable<AgentRunDetail['candidates']>[number]

/**
 * 已完成的 Run 作为历史对话保留在页面中。默认只显示前 4 条媒体结果，
 * 避免用户连续检索后同时创建大量 video 元素；需要时可在原对话中展开。
 */
function ArchivedAgentTurn({ run, client }: { run: AgentRunDetail; client: AgentApiClient }) {
  const [showAll, setShowAll] = useState(false)
  const candidates = run.candidates ?? []
  const visibleCandidates = showAll ? candidates : candidates.slice(0, 4)
  return (
    <article className="agent-chat-turn agent-chat-turn-archived" aria-label={`历史检索：${run.prompt}`}>
      <div className="agent-user-message"><p>{run.prompt}</p></div>
      <div className="agent-assistant-message">
        <header className="agent-response-header">
          <span className="agent-response-avatar"><Bot aria-hidden="true" size={17} /></span>
          <div><strong>智能检索</strong><p>{run.summary ?? '本次检索已完成。'}</p></div>
          <Badge>{runStatusLabel(run.status)}</Badge>
        </header>
        {visibleCandidates.length ? (
          <div className="agent-result-grid agent-result-grid-archived">
            {visibleCandidates.map((candidate) => (
              <article key={candidate.candidate_key} className="agent-result-card">
                <CandidateMedia candidate={candidate} client={client} />
                <div className="agent-result-copy"><div><strong>结果 {candidate.rank}</strong></div><p>{formatCandidateRange(candidate)}</p></div>
              </article>
            ))}
          </div>
        ) : <p className="agent-result-empty">本次没有找到符合条件的内容。</p>}
        {candidates.length > 4 ? (
          <button className="agent-history-toggle" type="button" onClick={() => setShowAll((value) => !value)}>
            {showAll ? '收起其余结果' : `查看全部 ${candidates.length} 条结果`}
          </button>
        ) : null}
      </div>
    </article>
  )
}

/**
 * 把服务端已保存的检索记录整理成按需展开的只读面板，不发起搜索或模型请求。
 * 结果采用原因、未完成排序和失效提示始终可见；长日志留在有高度上限的区域内。
 * 以任务 ID 作为组件 key，新任务默认收起，同一任务轮询不会重置用户的开合选择。
 */
function AgentRetrievalActivity({ run, runProcessing }: { run: AgentRunDetail; runProcessing: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (!run.retrieval) return null
  const pendingLabels: Record<string, string> = {
    search_media: '准备补充搜索', inspect_segment_frames: '准备检查场景采样画面',
    get_segment_details_batch: '准备批量读取必要详情', get_segment_details: '准备读取详情',
  }
  // 任务的等待/取消状态优先于尚未清除的 pending 动作，避免误报还会继续执行。
  const current = run.status === 'cancel_requested' ? '正在取消，不再安排新动作'
    : run.status === 'waiting_for_user_input' ? '等待补充信息'
    : run.status === 'outcome_unknown' ? '外部请求结果未知'
    : !runProcessing ? '已停止执行'
    : pendingLabels[run.retrieval.pending ?? ''] ?? '根据已有结果决策'

  return <div className="agent-retrieval-activity" aria-label="工具执行与证据">
    <div className="agent-retrieval-notices">
      {run.retrieval.result_mode === 'baseline' ? <Alert>当前采用原文基线。原因：{retrievalFallbackLabel(run.retrieval.fallback_reason)}。本次增强结果未采用。</Alert> : null}
      {run.retrieval.final_rerank_status === 'not_completed' ? <p>最终图片重排未完成；保留原文搜索顺序，未验证全部条件。未知外发不会自动重放。</p> : null}
      {run.retrieval.result_mode === 'enhanced' ? <Alert>当前采用增强名单，质量资格仅覆盖本次冻结查询与素材版本。</Alert> : null}
      {run.retrieval.visual_verification?.status === 'unverified' ? <p>画面核实状态：{run.retrieval.visual_verification.reason === 'sampled_frames' ? '模型已检查采样帧，仍未人工核实；不能证明连续动作。' : '未核实，仅有文字线索。'}</p> : null}
      {run.retrieval.unavailable_candidates?.map(candidate => <Alert key={candidate.candidate_key}>候选 {candidate.candidate_key} 当前已过期或无法读取，已从预览结果移除；下方保留的是历史判断。</Alert>)}
    </div>
    <details className="agent-retrieval-log" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="agent-retrieval-log-heading"><SlidersHorizontal size={14} aria-hidden="true" />检索过程</span>
        <span className="agent-retrieval-log-state" role="status">{current}</span>
        <span className="agent-retrieval-log-count">{run.retrieval.tool_calls} 次工具操作</span>
        <span className="agent-retrieval-log-toggle">{expanded ? '收起' : '查看详情'}<ChevronDown size={14} aria-hidden="true" /></span>
      </summary>
      <div className="agent-retrieval-log-body" role="region" aria-label="检索详细记录" tabIndex={0}>
          <section className="agent-retrieval-log-section">
            <h3>执行记录</h3>
            <p>已消耗 {run.retrieval.tool_calls} 个工具操作额度（批量详情按候选逐个计数）。</p>
            {run.retrieval.matched_evidence ? <p>已准备{run.retrieval.matched_evidence.candidate_keys.length}个候选的实际命中图文；准备完成不代表已经外发或检查。获得独立授权且费用允许后，DeepSeek在同一次请求中判断缺口与下一步。视频单帧不能核实连续动作，描述和转录均保留来源。</p> : null}
            {run.retrieval.overview_budget ? <p>已准备 {run.retrieval.overview_budget.inspected}/{run.retrieval.overview_budget.maximum_candidates} 个候选概要，每个最多 {run.retrieval.overview_budget.maximum_characters_per_candidate} 字符。概要仅帮助选择下一步，截断内容不能证明条件不存在。</p> : null}
            {run.steps?.filter(step => step.tool_status).map(step => <p key={step.step_attempt_id}>{step.action === 'search_media' ? '搜索素材' : '读取详情'}：{step.tool_status === 'succeeded' ? '执行成功' : '执行失败'}</p>)}
            {run.retrieval.queries.map(query => <p key={query.step_id}>搜索「{query.query}」：{query.candidate_keys.length} 个候选</p>)}
          </section>
          {run.retrieval.gaps?.length ? <section className="agent-retrieval-log-section">
            <h3>条件缺口与下一步</h3>
            {run.retrieval.gaps?.map(item => <div key={item.step_id}>
              <p>缺口条件：{item.gap.condition_ids.map(id => run.conditions?.find(condition => condition.condition_id === id)?.source_text ?? '未知条件').join('；')}</p>
              <p>{item.gap.missing_evidence}；下一步{item.action === 'search_media' ? '补搜' : '读取详情'}：{item.gap.next_step_reason}</p>
              {item.gap.checked.some(row => row.evidence_level === 'overview') ? <p>本次缺口引用了画面描述概要，尚不等于读取完整详情。</p> : null}
            </div>)}
          </section> : null}
          <section className="agent-retrieval-log-section">
            <h3>结束原因与核实边界</h3>
            {run.retrieval.stop_reason ? <p>增强停止原因：{retrievalStopLabel(run.retrieval.stop_reason)}</p> : null}
            {run.retrieval.stop_basis ? <>
              <p>停止涉及条件：{run.retrieval.stop_basis.condition_ids.map(id => run.conditions?.find(condition => condition.condition_id === id)?.source_text ?? '未知条件').join('；') || '没有待确认条件'}</p>
              <p>不再补搜：{run.retrieval.stop_basis.search.reason}</p>
              <p>不再读取详情：{run.retrieval.stop_basis.detail.reason}</p>
              <p>停止依据是模型的行动意见；程序已检查身份与预算，不代表语义判断或检索质量已通过。</p>
            </> : null}
            {run.retrieval.budget ? <p>搜索 {run.retrieval.budget.searches}/{run.retrieval.budget.limits.maximum_searches}；详情 {run.retrieval.budget.details}/{run.retrieval.budget.limits.maximum_details}；决策 {run.retrieval.model_calls}/{run.retrieval.budget.limits.maximum_models}；工具总计 {run.retrieval.tool_calls}/{run.retrieval.budget.limits.maximum_tools}。</p> : null}
            {run.retrieval.stop_reason === 'tool_limit' ? <p>预算停止不代表原始条件已确认；请同时查看缺口判断与最终重排状态。</p> : null}
            {run.retrieval.matched_evidence ? <p>判断依据为本次实际命中的文字和已授权发送的命中帧；图片准备完成不代表模型已检查。模型可能误认对象、位置或动作；单帧和最终图片排序均不保证全部条件或连续动作满足。</p> : <p>判断依据仅为已有描述与转录；描述可能误认对象、位置或动作。文字支持不代表画面条件已核实，未检查连续视频动作；最终图片排序也不保证全部条件满足。</p>}
          </section>
          {Object.keys(run.retrieval.scene_inspections ?? {}).length || run.retrieval.assessments?.length ? <section className="agent-retrieval-log-section">
            <h3>候选判断与证据</h3>
            {Object.entries(run.retrieval.scene_inspections ?? {}).map(([key, inspection]) => <div key={key}><p>场景画面检查：{key}，{inspection.frames.length}张采样图；{inspection.status === 'observed' ? '观察已返回' : '已准备，尚未取得观察'}。</p>{inspection.normalizations?.length ? <p>程序保留不确定：采样图不能排除整个场景出现目标，也不能核实连续动作。</p> : null}{inspection.observation ? <><p>{inspection.observation.summary}（模型意见，非人工标签）</p>{inspection.observation.conditions.map(item => <p key={item.condition_id}>{run.conditions?.find(c => c.condition_id === item.condition_id)?.source_text}：{item.observation}；{item.status === 'unknown' ? '仍不确定' : '模型观察判断'}</p>)}</> : null}</div>)}
            {run.retrieval.assessments?.map(assessment => <div key={assessment.candidate_key}>
              <strong>{assessment.candidate_key}</strong>
              {assessment.conditions.map(condition => <p key={condition.condition_id}>{run.conditions?.find(item => item.condition_id === condition.condition_id)?.source_text}：{condition.status === 'satisfied' ? run.retrieval?.matched_evidence ? '命中图文支持（模型判断）' : '文字线索支持（模型判断）' : condition.status === 'not_satisfied' ? run.retrieval?.matched_evidence ? '命中图文不支持（模型判断）' : '文字线索不支持（模型判断）' : '证据不足，仍不确定'}</p>)}
              {run.retrieval?.details[assessment.candidate_key]?.evidence.map(evidence => <p key={evidence.evidence_id}>{evidence.source === 'pre_generated_caption' ? '预生成画面描述' : evidence.source === 'transcript' ? '转录' : evidence.source === 'scene_visual_observation' ? '采样画面观察（模型意见）' : '媒体信息'}：{evidence.text} {evidence.start_seconds !== null ? `（${evidence.start_seconds}–${evidence.end_seconds} 秒）` : ''}{evidence.crosses_scene_boundary ? '；跨越场景边界' : ''}{evidence.truncated ? '；内容已截断' : ''}</p>)}
            </div>)}
          </section> : null}
      </div>
    </details>
  </div>
}

/** 运行详情默认收起，原生展开面板保留用户开合选择；轮询只更新条目，不重置面板。 */
function AgentRunProgress({ run }: { run: AgentRunDetail }) {
  const [expanded, setExpanded] = useState(false)
  const labels: Record<string, string> = {
    running: '进行中', succeeded: '已完成', failed: '失败', outcome_unknown: '结果未知',
    lease_expired: '执行中断', interrupted: '执行中断', stopped: '已停止或等待处理',
    cancelled: '已取消', timed_out: '超时',
  }
  const current = [...(run.progress ?? [])].reverse().find(item => item.status === 'running')
  return <details className="agent-run-meta agent-run-progress" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="agent-run-progress-heading"><Clock3 size={14} aria-hidden="true" /><span>运行详情</span></span>
      {current && !expanded ? <span className="agent-run-progress-current">{current.label}</span> : null}
      <ChevronDown className="agent-run-progress-chevron" size={14} aria-hidden="true" />
    </summary>
    <ol aria-label="Agent 执行步骤" aria-live="polite" aria-relevant="additions text">
      {run.progress?.map(item => <li key={item.id} className={item.parent_id ? 'agent-run-progress-child' : undefined} data-status={item.status}>
        <span className="agent-run-progress-dot" data-status={item.status} aria-hidden="true">
          {item.status === 'succeeded' ? <Check size={10} strokeWidth={2.5} /> : null}
        </span>
        <div className="agent-run-progress-content"><div className="agent-run-progress-line"><strong>{item.label}</strong><span className="agent-run-progress-status">{labels[item.status] ?? item.status}</span></div>
          <small><time dateTime={item.started_at}>{new Date(item.started_at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            {item.finished_at ? ` · 耗时 ${Math.max(0, new Date(item.finished_at).getTime() - new Date(item.started_at).getTime()) / 1000} 秒` : ''}
          </small>
        </div>
      </li>)}
    </ol>
    {!run.progress?.length ? <p>等待服务端提供步骤记录。</p> : null}
    <p className="agent-run-progress-id">任务编号：{run.id}</p>
  </details>
}

/**
 * 加载提示只映射 Server 已返回的真实 Run 状态，不伪造百分比。三个圆点提供持续反馈，
 * 阶段文字则让用户知道系统是在理解请求、查找素材，还是比较最终候选。
 */
function AgentProcessingState({ status, retrieval = false }: { status: string; retrieval?: boolean }) {
  const phases = retrieval ? ['理解请求', '搜索与读取详情', '按缺口补搜或完成'] : ['理解请求', '检索素材', '智能重排']
  const phaseIndex = status === 'ranking' ? 2 : status === 'searching' ? 1 : 0
  const messages: Record<string, string> = {
    queued: '请求已进入队列，马上开始处理',
    cancel_requested: '正在等待当前执行释放，不会安排新动作',
    extracting_intent: '正在理解画面、人物、动作和语音条件',
    searching: retrieval ? '正在根据已有结果选择或执行下一步工具' : '正在素材库中查找匹配内容',
    ranking: '正在比较候选并生成最终顺序',
  }

  return (
    <div className="agent-processing" role="status" aria-label="检索进行中" aria-live="polite">
      <div className="agent-processing-message">
        <span className="agent-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        <strong>{messages[status] ?? '正在处理本次检索'}</strong>
      </div>
      <div className="agent-processing-phases" aria-hidden="true">
        {phases.map((phase, index) => (
          <span
            className={index === phaseIndex ? 'agent-processing-phase-active' : index < phaseIndex ? 'agent-processing-phase-done' : undefined}
            key={phase}
          >
            <i />{phase}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 候选媒体统一通过 Server 的受控 content API 读取，不向浏览器暴露本地路径。 */
function CandidateMedia({ candidate, client }: { candidate: AgentCandidate; client: AgentApiClient }) {
  const mediaUrl = client.mediaContentUrl(candidate.file_id, {
    startTimeSeconds: candidate.scene_start_seconds,
    endTimeSeconds: candidate.scene_end_seconds,
  })
  const mediaType = candidate.candidate_key.split(':')[0]
  if (mediaType === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={`检索结果 ${candidate.rank}`} loading="lazy" src={mediaUrl} />
  }
  if (mediaType === 'audio') {
    return <audio aria-label={`播放音频候选 ${candidate.rank}`} controls preload="metadata" src={mediaUrl} />
  }
  return (
    <video
      aria-label={`播放候选 ${candidate.rank}，${formatCandidateRange(candidate)}`}
      controls
      playsInline
      preload="metadata"
      src={mediaUrl}
    />
  )
}

function formatCandidateRange(candidate: AgentCandidate) {
  if (candidate.scene_start_seconds === null || candidate.scene_end_seconds === null) return '完整图片'
  return `场景 ${candidate.scene_start_seconds} 至 ${candidate.scene_end_seconds} 秒`
}

/** 只有带稳定场景和完整时间边界的视频候选才能进入 Server 的片段导出协议。 */
function isExportableVideoCandidate(candidate: AgentCandidate) {
  return candidate.candidate_key.startsWith('video:')
    && Boolean(candidate.scene_id)
    && candidate.scene_start_seconds !== null
    && candidate.scene_end_seconds !== null
}

/** 把服务端稳定枚举转换为产品文案；原始值仍保留在 API 与审计数据中。 */
function formatSearchScope(scope: string) {
  const labels: Record<string, string> = {
    visual: '画面内容',
    spoken: '语音内容',
    all: '画面与语音',
  }
  return labels[scope] ?? '全部内容'
}

function conditionKindLabel(kind: string) {
  const labels: Record<string, string> = {
    must_have: '必须满足',
    optional: '可选条件',
    exclusion: '排除条件',
  }
  return labels[kind] ?? kind
}

/** 程序停止原因与模型判断分开显示，调用限制不能被包装成检索成功。 */
function retrievalStopLabel(reason: string) {
  const labels: Record<string, string> = { found: '文字线索已找到（模型判断）', visual_evidence_unverified: '文字规划已结束，画面条件尚未核实', partial: '部分完成', no_results: '未找到候选', insufficient_evidence: '证据不足', conditions_not_met: '候选未满足条件', no_progress: '没有有效进展', repeated_call: '重复调用已停止', tool_limit: '增强检查预算已用完', cost_limit: '费用预留不足，已停止增强并保留基线', context_limit: '决策文字超过安全长度，已保留基线', model_limit: '达到模型调用上限', step_limit: '达到执行步骤上限', time_limit: '达到任务时间上限', clarification_limit: '达到澄清次数上限', tool_timeout: '工具调用超时', overview_timeout: '候选概要准备超时，已保留基线', scene_inspection_unavailable: '场景看图未启用，保留基线', scene_inspection_limit: '场景看图额度已用完', scene_preparation_failed: '采样画面准备失败，保留基线', scene_evidence_changed: '采样画面来源发生变化，停止外发', scene_observation_failed: '场景观察失败，保留基线', matched_evidence_failed: '命中图文准备失败，保留基线', matched_evidence_changed: '命中图文版本改变，停止外发', matched_evidence_unavailable: '命中图文服务不可用，保留基线', model_configuration_changed: '模型配置改变，旧任务停止增强', tool_failed: '工具调用失败', model_failed: '模型调用失败' }
  return labels[reason] ?? reason
}

/** 保底状态是可核查的产品事实，不能用任务成功掩盖增强未验收。 */
function retrievalFallbackLabel(reason?: string) {
  return ({ quality_not_accepted: '增强质量尚未验收', selection_invalidated: '授权等待期间候选失效，停止外发并保留基线', enhanced_candidate_unavailable: '增强候选已经失效', quality_suite_incomplete: '完整冻结查询集尚未验收', quality_context_changed: '查询、素材版本或配置与验收记录不一致', quality_record_unavailable: '无法读取有效质量记录', external_outcome_unknown: '外部请求结果未知，停止后续调用',
    failed: '增强调用失败', timed_out: '执行超时' } as Record<string, string>)[reason ?? ''] ?? retrievalStopLabel(reason ?? 'insufficient_evidence')
}
