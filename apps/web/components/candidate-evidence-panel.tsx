'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageIcon, LoaderCircle, XCircle } from 'lucide-react'
import {
  createApiClient,
  type CandidateEvidenceSource,
  type CandidateEvidenceSummary,
} from '../lib/api-client'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled'])
const statusLabels: Record<string, string> = {
  queued: '等待准备',
  running: '正在构建',
  cancel_requested: '正在取消',
  succeeded: '证据准备完成',
  failed: '证据准备失败',
  cancelled: '证据准备已取消',
}

type EvidenceApiClient = Pick<
  ReturnType<typeof createApiClient>,
  | 'createCandidateEvidence'
  | 'listCandidateEvidence'
  | 'cancelCandidateEvidence'
  | 'candidateEvidenceArtifactUrl'
>

/**
 * Phase D 的候选证据面板只在用户点击后创建本地 Job。组件通过 source + candidate_key
 * 从 PostgreSQL 恢复状态，因此页面刷新不会重复创建；轮询只读取状态，不触发搜索或模型。
 */
export function CandidateEvidencePanel({
  source,
  candidateKey,
  apiClient,
  pollIntervalMs = 2_000,
}: {
  source: CandidateEvidenceSource
  candidateKey: string
  apiClient?: EvidenceApiClient
  pollIntervalMs?: number
}) {
  const defaultClient = useMemo(() => createApiClient(), [])
  const client = apiClient ?? defaultClient
  const [items, setItems] = useState<CandidateEvidenceSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const sourceId = source.type === 'agent_run_candidate' ? source.run_id : source.candidate_id

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await client.listCandidateEvidence(
        { source_type: source.type, source_id: sourceId, candidate_key: candidateKey },
        { signal },
      )
      setItems(response.items)
      setPreviewError(false)
      return response.items
    },
    [candidateKey, client, source.type, sourceId],
  )

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : '无法恢复证据状态')
      }
    })
    return () => controller.abort()
  }, [refresh])

  const hasActive = items.some((item) => !terminalStatuses.has(item.status))
  useEffect(() => {
    if (!hasActive) return
    let disposed = false
    let timer: number | undefined
    let controller: AbortController | undefined
    const poll = async () => {
      if (disposed || document.visibilityState === 'hidden') return
      controller?.abort()
      controller = new AbortController()
      try {
        const nextItems = await refresh(controller.signal)
        if (!nextItems.every((item) => terminalStatuses.has(item.status)) && !disposed) {
          timer = window.setTimeout(poll, pollIntervalMs)
        }
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(cause instanceof Error ? cause.message : '证据状态刷新失败')
          if (!disposed) timer = window.setTimeout(poll, pollIntervalMs)
        }
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (timer) window.clearTimeout(timer)
        void poll()
      } else {
        controller?.abort()
      }
    }
    timer = window.setTimeout(poll, pollIntervalMs)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      controller?.abort()
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [hasActive, pollIntervalMs, refresh])

  async function buildEvidence() {
    setBusy(true)
    setError(null)
    try {
      const response = await client.createCandidateEvidence({
        source,
        candidate_key: candidateKey,
        strategies: ['contact_sheet_v1', 'all_indexed_frames_v1'],
      })
      setItems(response.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建证据 Job 失败')
    } finally {
      setBusy(false)
    }
  }

  async function cancelEvidence() {
    const active = items.find((item) => !terminalStatuses.has(item.status))
    if (!active) return
    setError(null)
    try {
      await client.cancelCandidateEvidence(active.id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消证据 Job 失败')
    }
  }

  const contactSheet = items.find((item) => item.strategy === 'contact_sheet_v1')
  return (
    <section className="space-y-3 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || hasActive}
          aria-label="准备此候选的本地视觉证据"
          onClick={() => void buildEvidence()}
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
          ) : (
            <ImageIcon aria-hidden="true" size={16} />
          )}
          {items.length ? '重新使用本地证据' : '准备本地证据'}
        </Button>
        {hasActive ? (
          <Button
            type="button"
            variant="outline"
            aria-label="取消此候选的证据构建"
            onClick={() => void cancelEvidence()}
          >
            <XCircle aria-hidden="true" size={16} />
            取消构建
          </Button>
        ) : null}
      </div>

      {error ? <Alert role="alert">证据操作失败：{error}</Alert> : null}
      {previewError ? (
        <Alert role="alert">本地证据预览加载失败，请检查证据文件后重试。</Alert>
      ) : null}
      {items.length ? (
        <div className="space-y-2" role="status" aria-live="polite">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-md border border-[var(--hairline)] bg-white p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{item.strategy}</span>
                <Badge>{statusLabels[item.status] ?? item.status}</Badge>
              </div>
              <p className="mt-1 text-[var(--mute)]">
                协议 {item.protocol_version} · 帧数 {item.frame_count ?? '等待生成'}
              </p>
              {item.error ? (
                <p className="mt-2 text-[var(--danger)]">
                  {item.error.code}：{item.error.message}
                </p>
              ) : null}
            </div>
          ))}
          <p className="text-sm text-[var(--mute)]">
            尚未执行 Rerank（重排）。尚未执行 VLM（视觉语言模型）审核。
          </p>
        </div>
      ) : (
        <p className="text-sm text-[var(--mute)]">不会因展示候选而自动生成证据。</p>
      )}
      {contactSheet?.status === 'succeeded' ? (
        <img
          alt="当前候选的本地时间戳拼图证据"
          className="w-full rounded-md border border-[var(--hairline)] bg-black object-contain"
          src={client.candidateEvidenceArtifactUrl(contactSheet.id)}
          onError={() => setPreviewError(true)}
        />
      ) : null}
    </section>
  )
}
