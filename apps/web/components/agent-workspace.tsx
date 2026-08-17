'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Clock3, Send, ShieldCheck, Sparkles } from 'lucide-react'
import {
  createApiClient,
  type AgentRerankRun,
  type AgentRunDetail,
  type JobSummary,
} from '../lib/api-client'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { CandidateEvidencePanel } from './candidate-evidence-panel'

const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'completed_with_errors',
  'cancelled',
  'expired',
])
const terminalJobStatuses = new Set(['succeeded', 'failed', 'cancelled'])
const terminalRerankStatuses = new Set(['succeeded', 'failed', 'outcome_unknown', 'not_applicable'])

type AgentApiClient = Pick<
  ReturnType<typeof createApiClient>,
  | 'createAgentRun'
  | 'getAgentRun'
  | 'startAgentRerank'
  | 'getAgentRerank'
  | 'saveAgentRerankFeedback'
  | 'getAgentSettings'
  | 'selectAgentExport'
  | 'confirmAgentExport'
  | 'getJob'
  | 'retryUnknownAgentRun'
  | 'cancelAgentRun'
  | 'mediaContentUrl'
  | 'createCandidateEvidence'
  | 'listCandidateEvidence'
  | 'cancelCandidateEvidence'
  | 'candidateEvidenceArtifactUrl'
>

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
  const [job, setJob] = useState<JobSummary | null>(null)
  const [rerank, setRerank] = useState<AgentRerankRun | null>(null)
  const [rerankEnabled, setRerankEnabled] = useState(false)
  const [rerankAvailable, setRerankAvailable] = useState(false)
  const rerankStartPending = useRef(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(2_000)
  const [unknownActionPending, setUnknownActionPending] = useState(false)
  const [statusMessage, setStatusMessage] = useState(
    '输入请求后，Agent 会先识别一次意图并执行一次原文搜索。',
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

  useEffect(() => {
    const controller = new AbortController()
    void client
      .getAgentSettings({ signal: controller.signal })
      .then((settings) => {
        setPollIntervalMs(settings.editable.web_poll_interval_ms)
        setRerankAvailable(settings.capabilities.rerank_available)
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
        const persistedRerank = await client.getAgentRerank(persistedRun.id, {
          signal: controller.signal,
        })
        setRerank(persistedRerank)
        setRerankEnabled(Boolean(persistedRerank))
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
      const nextRun = terminalRunStatuses.has(run.status)
        ? run
        : await client.getAgentRun(run.id, { signal })
      if (nextRun !== run) setRun(nextRun)
      const nextRerank = await client.getAgentRerank(nextRun.id, { signal })
      if (nextRerank) setRerank(nextRerank)
      const jobId = nextRun.export_job?.id ?? job?.id
      if (jobId && (!job || !terminalJobStatuses.has(job.status))) {
        setJob(await client.getJob(jobId, { signal }))
      }
    },
    [client, job, run],
  )

  useEffect(() => {
    if (!run) return
    const runDone = terminalRunStatuses.has(run.status)
    const jobDone = !job || terminalJobStatuses.has(job.status)
    const rerankDone =
      !rerankEnabled || (rerank !== null && terminalRerankStatuses.has(rerank.status))
    if (runDone && jobDone && rerankDone) return
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
  }, [job, pollIntervalMs, refreshPersistedState, rerank, rerankEnabled, run])

  useEffect(() => {
    if (
      !run ||
      !rerankEnabled ||
      rerank ||
      rerankStartPending.current ||
      !['waiting_for_export_selection', 'succeeded'].includes(run.status)
    ) {
      return
    }
    rerankStartPending.current = true
    setStatusMessage('RRF 已返回；正在准备 20 张派生 PNG 并启动 Rerank…')
    void client
      .startAgentRerank(run.id, { confirmed: true, max_cost_cny: 0.216 })
      .then((result) => setRerank(result))
      .catch((error: unknown) => {
        setStatusMessage(
          error instanceof Error ? `Rerank 启动失败：${error.message}` : 'Rerank 启动失败。',
        )
      })
      .finally(() => {
        rerankStartPending.current = false
      })
  }, [client, rerank, rerankEnabled, run])

  async function startRun() {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return
    setStatusMessage('正在创建持久化 run…')
    const created = await client.createAgentRun({
      prompt: trimmedPrompt,
      allow_external_text: true,
      allow_external_visual: rerankEnabled,
      // 空数组在 Server 协议中表示“无额外限制”，但浏览器显式列出 V1 支持范围，
      // 让后续导出守卫和页面展示都不依赖隐式默认值。
      media_types: rerankEnabled ? ['image', 'video'] : ['image', 'video', 'audio'],
    })
    const detail = await client.getAgentRun(created.run_id)
    window.localStorage.setItem('agent:last-run-id', created.run_id)
    setRun(detail)
    setJob(null)
    setRerank(null)
    rerankStartPending.current = false
    setSelectedKey(null)
    setConfirmation(null)
    setStatusMessage(`run 已创建：${created.status}`)
  }

  function chooseCandidate(candidate: NonNullable<AgentRunDetail['candidates']>[number]) {
    setSelectedKey(candidate.candidate_key)
    setStartSeconds(String(candidate.scene_start_seconds ?? 0))
    setEndSeconds(String(candidate.scene_end_seconds ?? 0))
    setConfirmation(null)
  }

  async function previewExport() {
    if (!run || !selectedCandidate) return
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
    setStatusMessage('Server 已重新校验候选与时间范围，请确认导出。')
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
    setStatusMessage('Agent run 已完成确认；导出 Job 仍由 Worker 独立执行。')
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
        reason: '用户放弃结果未知的任务',
      })
      setRun(await client.getAgentRun(run.id))
      setStatusMessage('本次任务已放弃，不会重新调用 RightAPI。')
    } finally {
      setUnknownActionPending(false)
    }
  }

  async function saveRerankFeedback(verdict: 'rerank_better' | 'rrf_better' | 'same') {
    if (!rerank) return
    const updated = await client.saveAgentRerankFeedback(rerank.id, { verdict })
    setRerank(updated)
    setStatusMessage('Rerank 对比反馈已保存，可改选。')
  }

  return (
    <section className="mx-auto max-w-5xl space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-lg bg-[var(--canvas-soft)]">
              <Bot aria-hidden="true" size={22} />
            </span>
            <div>
              <p className="eyebrow">Agent V1 · Experimental Rerank</p>
              <CardTitle className="text-2xl">检索与安全导出</CardTitle>
            </div>
          </div>
          <CardDescription>RRF 始终先返回；Rerank 仅在本次查询显式开启时执行。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void startRun()
            }}
          >
            <Label htmlFor="agent-prompt">完整用户请求</Label>
            <Textarea
              id="agent-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="查找红色汽车经过桥下的视频，并导出合适片段"
              required
            />
            <div className="rounded-lg border border-[var(--hairline)] p-3">
              <div className="flex items-start gap-3">
                <input
                  id="agent-rerank"
                  className="mt-1 size-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  type="checkbox"
                  checked={rerankEnabled}
                  disabled={!rerankAvailable}
                  onChange={(event) => setRerankEnabled(event.target.checked)}
                />
                <div>
                  <Label htmlFor="agent-rerank">为本次查询开启实验性 Rerank</Label>
                  <p className="mt-1 text-xs text-[var(--mute)]">
                    开启后会向 DashScope 北京地域发送完整查询和 RRF Top-20 的派生 PNG； 单次最多 20
                    张，按最高 ¥0.216 预留，不自动重试未知结果。
                  </p>
                  {!rerankAvailable ? (
                    <p className="mt-1 text-xs text-[var(--mute)]">当前部署未启用产品 Rerank。</p>
                  ) : null}
                </div>
              </div>
            </div>
            <Button type="submit">
              <Send aria-hidden="true" size={16} />
              启动任务
            </Button>
          </form>
          <p className="mt-4 text-sm text-[var(--mute)]" role="status" aria-live="polite">
            {statusMessage}
          </p>
        </CardContent>
      </Card>

      {run ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>Run 状态</CardTitle>
                <Badge>{run.status}</Badge>
              </div>
              <CardDescription>run_id: {run.id}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm font-medium text-[var(--ink)]">识别意图</p>
                <p className="text-sm text-[var(--mute)]">{run.intent?.goal ?? '等待识别'}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--ink)]">Server enforced scope</p>
                <p className="text-sm text-[var(--mute)]">
                  {run.resolved_scope
                    ? `${run.resolved_scope.search_scope} · ${run.resolved_scope.media_types.join(', ')}`
                    : '等待解析'}
                </p>
              </div>
              {run.error ? (
                <Alert>
                  {run.error.code}：{run.error.message}
                </Alert>
              ) : null}
              {run.status === 'outcome_unknown' ? (
                <div className="space-y-3 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] p-4 md:col-span-2">
                  <p className="text-sm text-[var(--ink)]">
                    上一次外部请求可能已经被模型处理。重新执行可能产生重复请求和费用；放弃只结束本次任务，
                    不会再次调用 RightAPI。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={unknownActionPending}
                      onClick={() => void retryUnknown()}
                    >
                      重新执行
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={unknownActionPending}
                      onClick={() => void abandonUnknown()}
                    >
                      放弃本次任务
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {run.candidates?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>RRF 结果</CardTitle>
                <CardDescription>
                  RRF（倒数排名融合）只按多个召回通道的名次合并；分数不是相关概率。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="grid gap-2 sm:grid-cols-2">
                  {run.candidates.map((candidate) => (
                    <li
                      key={candidate.candidate_key}
                      className="rounded-lg border border-[var(--hairline)] bg-white p-3"
                    >
                      <strong>RRF {candidate.rank}</strong>
                      <p className="truncate text-xs text-[var(--mute)]">
                        {candidate.candidate_key}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}

          {rerankEnabled ? (
            <Card aria-live="polite">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles aria-hidden="true" size={18} />
                      Rerank 结果
                    </CardTitle>
                    <CardDescription>
                      与上方同一次查询的 RRF 基线对照；相关分数只在本次 Top-20 内用于排序。
                    </CardDescription>
                  </div>
                  <Badge>{rerank?.status ?? '等待 RRF Top-20'}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {rerank?.status === 'succeeded' ? (
                  <>
                    <ol className="grid gap-2 sm:grid-cols-2">
                      {rerank.rankings
                        .filter((item) => item.rerank_rank !== null)
                        .sort((left, right) => left.rerank_rank! - right.rerank_rank!)
                        .map((item) => {
                          const candidate = run.candidates?.find(
                            (entry) => entry.candidate_key === item.candidate_key,
                          )
                          const mediaUrl = candidate
                            ? client.mediaContentUrl(candidate.file_id, {
                                startTimeSeconds: candidate.scene_start_seconds,
                                endTimeSeconds: candidate.scene_end_seconds,
                              })
                            : null
                          return (
                            <li
                              key={item.candidate_key}
                              className="overflow-hidden rounded-lg border border-[var(--hairline)] bg-white"
                            >
                              {mediaUrl && candidate ? (
                                candidate.scene_id ? (
                                  <video
                                    aria-label={`播放 Rerank 候选 ${item.rerank_rank}`}
                                    className="aspect-video w-full bg-black object-contain"
                                    controls
                                    playsInline
                                    preload="metadata"
                                    src={mediaUrl}
                                  />
                                ) : (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    alt={`Rerank 候选 ${item.rerank_rank}，尚未人工审核`}
                                    className="aspect-video w-full bg-black object-contain"
                                    loading="lazy"
                                    src={mediaUrl}
                                  />
                                )
                              ) : null}
                              <div className="p-3">
                                <strong>Rerank {item.rerank_rank}</strong>
                                <p className="text-sm text-[var(--mute)]">
                                  原 RRF {item.rrf_rank} · 分数 {item.relevance_score ?? '—'}
                                </p>
                                <p className="truncate text-xs text-[var(--mute)]">
                                  {item.candidate_key}
                                </p>
                              </div>
                            </li>
                          )
                        })}
                    </ol>
                    <fieldset className="rounded-lg border border-[var(--hairline)] p-4">
                      <legend className="px-1 text-sm font-medium">哪组结果更好？</legend>
                      <div className="flex flex-wrap gap-2">
                        {[
                          ['rerank_better', 'Rerank 更好'],
                          ['rrf_better', 'RRF 更好'],
                          ['same', '差不多'],
                        ].map(([value, label]) => (
                          <Button
                            key={value}
                            type="button"
                            variant={rerank.feedback === value ? 'default' : 'outline'}
                            aria-pressed={rerank.feedback === value}
                            onClick={() =>
                              void saveRerankFeedback(
                                value as 'rerank_better' | 'rrf_better' | 'same',
                              )
                            }
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </fieldset>
                  </>
                ) : rerank?.error ? (
                  <Alert>
                    {rerank.error.code}：{rerank.error.message}
                  </Alert>
                ) : (
                  <p className="text-sm text-[var(--mute)]">
                    RRF 结果可先使用；Rerank 正在等待派生 PNG 或模型响应。
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {run.conditions?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>条件与验证边界</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {run.conditions.map((condition) => (
                  <div
                    key={condition.condition_id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--hairline)] p-3"
                  >
                    <span>{condition.source_text}</span>
                    <Badge>未验证条件</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>RRF 候选详情</CardTitle>
              <CardDescription>RRF（倒数排名融合）分数只表示排序，不是相关概率。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {run.candidates?.length ? (
                run.candidates.map((candidate) => {
                  const isSelected = selectedKey === candidate.candidate_key
                  // 媒体时间片段放在 URL fragment（#t=start,end）中，由浏览器把同一个
                  // 原视频定位到候选场景；Server 仍通过支持 Range 的 content API 分段供流。
                  const mediaUrl = client.mediaContentUrl(candidate.file_id, {
                    startTimeSeconds: candidate.scene_start_seconds,
                    endTimeSeconds: candidate.scene_end_seconds,
                  })
                  // 旧 run 的 retrieval 尚未保存 media_type；只对历史数据回退到 Server
                  // 生成的 candidate_key 前缀，新 run 始终使用显式字段。
                  const candidateMediaType =
                    candidate.retrieval.media_type ?? candidate.candidate_key.split(':')[0]

                  return (
                    <article
                      key={candidate.candidate_key}
                      className={`overflow-hidden rounded-lg border bg-white ${
                        isSelected
                          ? 'border-[var(--primary)] ring-2 ring-[var(--ring)]'
                          : 'border-[var(--hairline)]'
                      }`}
                    >
                      {candidateMediaType === 'image' ? (
                        // 原图经受控 content API 读取；alt 只描述候选身份，不声称图片内容已审核。
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt={`RRF 候选 ${candidate.rank}，尚未审核`}
                          className="aspect-video w-full bg-black object-contain"
                          loading="lazy"
                          src={mediaUrl}
                        />
                      ) : candidateMediaType === 'audio' ? (
                        <audio
                          aria-label={`播放音频候选 ${candidate.rank}`}
                          className="w-full p-4"
                          controls
                          preload="metadata"
                          src={mediaUrl}
                        />
                      ) : (
                        <video
                          aria-label={`播放候选 ${candidate.rank}，场景 ${candidate.scene_start_seconds}–${candidate.scene_end_seconds} 秒`}
                          className="aspect-video w-full bg-black object-contain"
                          controls
                          playsInline
                          preload="metadata"
                          src={mediaUrl}
                        />
                      )}
                      <div className="space-y-2 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong>候选 {candidate.rank}</strong>
                          <Badge>尚未审核</Badge>
                        </div>
                        <p className="text-sm text-[var(--mute)]">
                          场景 {candidate.scene_start_seconds}–{candidate.scene_end_seconds} 秒 ·
                          generation {candidate.file_generation}
                        </p>
                        <p className="text-sm text-[var(--mute)]">
                          召回证据：{candidate.retrieval.reasons?.join('、') || '未提供'}；RRF{' '}
                          {candidate.retrieval.score ?? '—'}
                        </p>
                        <p className="text-sm text-[var(--mute)]">
                          未验证条件：{candidate.unverified_condition_ids?.length ?? 0} 项
                        </p>
                        {candidate.scene_id ? (
                          <CandidateEvidencePanel
                            source={{ type: 'agent_run_candidate', run_id: run.id }}
                            candidateKey={candidate.candidate_key}
                            apiClient={client}
                            pollIntervalMs={pollIntervalMs}
                          />
                        ) : null}
                        <Button
                          type="button"
                          variant={isSelected ? 'default' : 'outline'}
                          aria-pressed={isSelected}
                          aria-label={`选择候选 ${candidate.rank}，场景 ${candidate.scene_start_seconds}–${candidate.scene_end_seconds} 秒`}
                          onClick={() => chooseCandidate(candidate)}
                        >
                          {isSelected ? '已选择此片段' : '选择此片段'}
                        </Button>
                      </div>
                    </article>
                  )
                })
              ) : (
                <p className="text-sm text-[var(--mute)]">等待候选或没有命中。</p>
              )}
            </CardContent>
          </Card>

          {selectedCandidate ? (
            <Card>
              <CardHeader>
                <CardTitle>导出参数预览</CardTitle>
                <CardDescription>时间必须位于当前冻结视频场景内，格式固定为 MP4。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="export-start">开始时间（秒）</Label>
                  <Input
                    id="export-start"
                    type="number"
                    step="0.01"
                    min={selectedCandidate.scene_start_seconds ?? 0}
                    max={selectedCandidate.scene_end_seconds ?? undefined}
                    value={startSeconds}
                    onChange={(event) => {
                      setStartSeconds(event.target.value)
                      setConfirmation(null)
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="export-end">结束时间（秒）</Label>
                  <Input
                    id="export-end"
                    type="number"
                    step="0.01"
                    min={selectedCandidate.scene_start_seconds ?? 0}
                    max={selectedCandidate.scene_end_seconds ?? undefined}
                    value={endSeconds}
                    onChange={(event) => {
                      setEndSeconds(event.target.value)
                      setConfirmation(null)
                    }}
                  />
                </div>
                <div className="sm:col-span-2 flex flex-wrap gap-3">
                  <Button type="button" variant="outline" onClick={() => void previewExport()}>
                    <Clock3 aria-hidden="true" size={16} />
                    生成确认预览
                  </Button>
                  {confirmation ? (
                    <div className="basis-full rounded-lg border border-[var(--hairline)] p-4">
                      <p className="text-sm text-[var(--ink)]">
                        Server 冻结预览：{confirmation.preview.start_time_seconds}–
                        {confirmation.preview.end_time_seconds} 秒 ·{' '}
                        {confirmation.preview.output_format}
                      </p>
                      <p className="mt-1 text-xs text-[var(--mute)]">
                        场景 {confirmation.preview.scene_id}；确认后只会导出这组参数。
                      </p>
                      <Button className="mt-3" type="button" onClick={() => void confirmExport()}>
                        <ShieldCheck aria-hidden="true" size={16} />
                        确认并创建导出 Job
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {job ? (
            <Card aria-live="polite">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>导出 Job 状态</CardTitle>
                  <Badge>{job.status}</Badge>
                </div>
                <CardDescription>Agent run 已结束也不代表 FFmpeg 导出已完成。</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">
                  Job {job.id} · {job.progress}%
                </p>
                {job.error_message ? <Alert className="mt-3">{job.error_message}</Alert> : null}
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
