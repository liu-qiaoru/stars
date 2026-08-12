'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Clock3, Send, ShieldCheck } from 'lucide-react'
import { createApiClient, type AgentRunDetail, type JobSummary } from '../lib/api-client'
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

type AgentApiClient = Pick<
  ReturnType<typeof createApiClient>,
  | 'createAgentRun'
  | 'getAgentRun'
  | 'getAgentSettings'
  | 'selectAgentExport'
  | 'confirmAgentExport'
  | 'getJob'
  | 'retryUnknownAgentRun'
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
  const [pollIntervalMs, setPollIntervalMs] = useState(2_000)
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
      .then((settings) => setPollIntervalMs(settings.editable.web_poll_interval_ms))
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
    if (!trimmedPrompt) return
    setStatusMessage('正在创建持久化 run…')
    const created = await client.createAgentRun({
      prompt: trimmedPrompt,
      allow_external_text: true,
      allow_external_visual: false,
      // 空数组在 Server 协议中表示“无额外限制”，但浏览器显式列出 V1 支持范围，
      // 让后续导出守卫和页面展示都不依赖隐式默认值。
      media_types: ['image', 'video', 'audio'],
    })
    const detail = await client.getAgentRun(created.run_id)
    window.localStorage.setItem('agent:last-run-id', created.run_id)
    setRun(detail)
    setJob(null)
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
    if (!run || !stepAttemptId) return
    await client.retryUnknownAgentRun(run.id, {
      step_attempt_id: stepAttemptId,
      client_request_id: crypto.randomUUID(),
    })
    setRun(await client.getAgentRun(run.id))
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
              <p className="eyebrow">Agent V1 · Phase D</p>
              <CardTitle className="text-2xl">检索与安全导出</CardTitle>
            </div>
          </div>
          <CardDescription>固定流程，不包含 Rerank、VLM 或自主工具循环。</CardDescription>
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
                <Button type="button" variant="outline" onClick={() => void retryUnknown()}>
                  显式重试未知结果
                </Button>
              ) : null}
            </CardContent>
          </Card>

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
              <CardTitle>搜索候选</CardTitle>
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

                  return (
                    <article
                      key={candidate.candidate_key}
                      className={`overflow-hidden rounded-lg border bg-white ${
                        isSelected
                          ? 'border-[var(--primary)] ring-2 ring-[var(--ring)]'
                          : 'border-[var(--hairline)]'
                      }`}
                    >
                      <video
                        aria-label={`播放候选 ${candidate.rank}，场景 ${candidate.scene_start_seconds}–${candidate.scene_end_seconds} 秒`}
                        className="aspect-video w-full bg-black object-contain"
                        controls
                        playsInline
                        preload="metadata"
                        src={mediaUrl}
                      />
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
