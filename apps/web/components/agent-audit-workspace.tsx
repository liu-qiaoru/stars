'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  createApiClient,
  type AgentAuditRunDetail,
  type AgentAuditRunSummary,
} from '../lib/api-client'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'

type AgentAuditApiClient = Pick<
  ReturnType<typeof createApiClient>,
  'listAgentAuditRuns' | 'getAgentAuditRun' | 'mediaContentUrl' | 'mediaThumbnailUrl'
>

/**
 * 本地内部审计页。它只读取已经持久化的历史，不会重新执行 Agent、搜索或 Rerank。
 * RRF 与 Rerank 并排显示，普通 `/agent` 页面则只展示最终 Rerank 结果。
 */
export function AgentAuditWorkspace({ apiClient }: { apiClient?: AgentAuditApiClient } = {}) {
  const defaultClient = useMemo(() => createApiClient(), [])
  const client = apiClient ?? defaultClient
  const [runs, setRuns] = useState<AgentAuditRunSummary[]>([])
  const [selected, setSelected] = useState<AgentAuditRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void client
      .listAgentAuditRuns({ signal: controller.signal })
      .then((value) => setRuns(value.runs))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : '读取检索历史失败。')
        }
      })
    return () => controller.abort()
  }, [client])

  async function openRun(id: string) {
    setError(null)
    try {
      setSelected(await client.getAgentAuditRun(id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取审计详情失败。')
    }
  }

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>检索审计与回溯</CardTitle>
          <CardDescription>
            只读查看每次查询、Agent 行为、服务 Trace、内部 RRF 和最终 Rerank；不会触发任何模型调用。
          </CardDescription>
        </CardHeader>
        {error ? <CardContent><Alert>{error}</Alert></CardContent> : null}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card>
          <CardHeader><CardTitle>检索历史</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {runs.map((run) => (
              <Button
                className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                key={run.id}
                type="button"
                variant={selected?.run.id === run.id ? 'default' : 'outline'}
                onClick={() => void openRun(run.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate">{run.query}</span>
                  <span className="block text-xs opacity-75">{run.status} · {new Date(run.created_at).toLocaleString()}</span>
                </span>
              </Button>
            ))}
            {!runs.length ? <p className="text-sm text-[var(--mute)]">还没有检索历史。</p> : null}
          </CardContent>
        </Card>

        {selected ? <AuditDetail detail={selected} client={client} /> : (
          <Card><CardContent className="py-10 text-sm text-[var(--mute)]">选择一条历史查看完整调用链。</CardContent></Card>
        )}
      </div>
    </section>
  )
}

function AuditDetail({ detail, client }: { detail: AgentAuditRunDetail; client: AgentAuditApiClient }) {
  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{detail.run.query}</CardTitle><Badge>{detail.run.status}</Badge>
          </div>
          <CardDescription>run_id: {detail.run.id}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader><CardTitle>服务 Trace</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {detail.trace.map((span) => (
            <div className="rounded-lg border border-[var(--hairline)] p-3" key={span.span_id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{span.component} · {span.operation}</strong><Badge>{span.status}</Badge>
              </div>
              <p className="text-sm text-[var(--mute)]">耗时 {span.duration_ms ?? '暂无'} ms · 外部调用 {span.external_call_status}</p>
              <pre className="mt-2 overflow-auto text-xs">{JSON.stringify({ request: span.request_summary, response: span.response_summary, error: span.error }, null, 2)}</pre>
            </div>
          ))}
          {!detail.trace.length ? <p className="text-sm text-[var(--mute)]">此历史发生在 Trace 持久化启用前，或尚未产生调用片段。</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>RRF 与 Rerank 对照</CardTitle></CardHeader>
        <CardContent className="overflow-auto">
          <table className="audit-compare-table w-full min-w-[44rem] text-left text-sm">
            <thead><tr><th className="p-2">候选</th><th className="p-2">RRF</th><th className="p-2">Rerank</th><th className="p-2">相关分数</th></tr></thead>
            <tbody>
              {detail.rrf_results.map((candidate) => {
                const latest = detail.rerank_attempts.at(-1)?.rankings.find((item) => item.candidate_id === candidate.candidate_id)
                return <tr className="border-t border-[var(--hairline)]" key={candidate.candidate_id}>
                  <td className="p-2">
                    <div className="audit-candidate-cell">
                      <AuditCandidatePreview candidate={candidate} client={client} />
                      <div className="audit-candidate-copy">
                        <strong>候选 {candidate.rrf_rank}</strong>
                        <span title={candidate.candidate_key}>{candidate.candidate_key}</span>
                        {hasAuditSceneRange(candidate) ? (
                          <small>{candidate.scene_start_seconds} 至 {candidate.scene_end_seconds} 秒</small>
                        ) : <small>{candidate.candidate_key.startsWith('video:') ? '视频场景' : '完整图片'}</small>}
                      </div>
                    </div>
                  </td>
                  <td className="p-2">{candidate.rrf_rank}</td><td className="p-2">{latest?.rerank_rank ?? '未入选'}</td>
                  <td className="p-2">{latest?.relevance_score ?? '暂无'}</td>
                </tr>
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Agent 行为与 Rerank 尝试</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <pre className="max-h-96 overflow-auto rounded-lg bg-[var(--canvas-soft)] p-3 text-xs">{JSON.stringify(detail.agent_behavior, null, 2)}</pre>
          <pre className="max-h-96 overflow-auto rounded-lg bg-[var(--canvas-soft)] p-3 text-xs">{JSON.stringify(detail.rerank_attempts, null, 2)}</pre>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * 审计页一次可能展示 20 个候选。视频使用 Server 提取的静态场景帧，不创建大量视频
 * 解码器；点击缩略图仍可通过受控媒体地址打开原图或对应视频时间片段。
 */
function AuditCandidatePreview({
  candidate,
  client,
}: {
  candidate: AgentAuditRunDetail['rrf_results'][number]
  client: AgentAuditApiClient
}) {
  const isVideo = candidate.candidate_key.startsWith('video:')
  const contentUrl = client.mediaContentUrl(candidate.file_id, {
    startTimeSeconds: candidate.scene_start_seconds,
    endTimeSeconds: candidate.scene_end_seconds,
  })
  const previewUrl = isVideo
    ? client.mediaThumbnailUrl(candidate.file_id, candidate.scene_start_seconds ?? 0)
    : contentUrl
  const mediaLabel = isVideo ? '视频' : '图片'

  return (
    <a
      className="audit-candidate-preview"
      href={contentUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`打开${mediaLabel}候选 ${candidate.rrf_rank}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={`${mediaLabel}候选 ${candidate.rrf_rank} 预览`} loading="lazy" src={previewUrl} />
      {isVideo ? <span>视频</span> : null}
    </a>
  )
}

/** 兼容服务重启前缓存的旧审计响应；只有两个边界都是数字时才拼接视频时间片段。 */
function hasAuditSceneRange(candidate: AgentAuditRunDetail['rrf_results'][number]) {
  return typeof candidate.scene_start_seconds === 'number'
    && typeof candidate.scene_end_seconds === 'number'
}
