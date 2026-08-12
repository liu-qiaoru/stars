'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createApiClient,
  type EvaluationRankingMetrics,
  type ShadowRerankRun,
} from '../lib/api-client'

const activeStatuses = new Set(['pending', 'running'])
// 默认 client 必须跨 React render 保持同一引用，否则 effect 会把每次状态更新
// 误认为依赖变化并重启请求。
const defaultApiClient = createApiClient()

/**
 * Phase E 状态面板只轮询 PostgreSQL 冻结事实。隐藏标签页时暂停，恢复可见立即读取；
 * 终态停止，组件卸载时 AbortController 取消在途 HTTP 请求。
 */
export function ShadowRerankPanel({
  evaluationRunId,
  canStart,
  apiClient = defaultApiClient,
}: {
  evaluationRunId: string
  canStart: boolean
  apiClient?: ReturnType<typeof createApiClient>
}) {
  const [run, setRun] = useState<ShadowRerankRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pollEpoch, setPollEpoch] = useState(0)
  const startControllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await apiClient.getEvaluationShadowRerank(evaluationRunId, signal)
      const validated = parseShadowRerankRun(next)
      setRun(validated)
      return validated
    },
    [apiClient, evaluationRunId],
  )

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const poll = async (force = false) => {
      if (disposed || (!force && document.visibilityState === 'hidden')) return
      try {
        const next = await refresh(controller.signal)
        setError(null)
        if (next && activeStatuses.has(next.status)) timer = setTimeout(poll, 2_000)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause))
          // 首次读取也可能正好遇到短暂断线；在明确读到未运行或终态前，
          // 始终用 2 秒有界间隔恢复，避免页面把“未知”误当成停止条件。
          timer = setTimeout(poll, 2_000)
        }
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') {
        if (timer) clearTimeout(timer)
        void poll()
      } else if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    // 首次挂载读取一次持久化事实，随后隐藏页面只暂停周期轮询。
    void poll(true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      controller.abort()
      startControllerRef.current?.abort()
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pollEpoch, refresh])

  async function start() {
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    startControllerRef.current?.abort()
    startControllerRef.current = controller
    try {
      setRun(
        parseShadowRerankRun(
          await apiClient.startEvaluationShadowRerank(evaluationRunId, controller.signal),
        ),
      )
      // 首次读取 null 时没有定时器；显式启动后通过 epoch 立即重建轮询。
      setPollEpoch((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (startControllerRef.current === controller) startControllerRef.current = null
      setLoading(false)
    }
  }

  return (
    <section className="panel space-y-4" aria-labelledby={`shadow-rerank-${evaluationRunId}`}>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <p className="eyebrow">Phase E · Evaluation only</p>
          <h2 id={`shadow-rerank-${evaluationRunId}`} className="section-title">
            qwen3-vl-rerank 影子评测
          </h2>
          <p className="muted mt-1 max-w-3xl">
            比较冻结 RRF Top-20 并输出 Top-10；不会改变普通 Search 或 Agent 候选顺序。
            relevance_score 不是概率，只能在同一次请求的候选之间比较。
          </p>
        </div>
        {canStart && !run ? (
          <button
            className="primary-action focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            disabled={loading}
            onClick={() => void start()}
          >
            {loading ? '读取中…' : '运行影子重排'}
          </button>
        ) : null}
      </div>

      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        尚未执行 VLM 审核。本阶段不产生通过、拒绝或条件成立结论。
      </p>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {run ? `影子重排状态：${statusLabel(run.status)}` : '影子重排尚未运行'}
      </div>
      {error ? <p role="alert">读取影子运行失败：{error}</p> : null}
      {!run && !loading && !error ? (
        <p className="muted">尚未运行；历史页面不会自动调用 Provider。</p>
      ) : null}
      {run ? <ShadowRunDetail run={run} /> : null}
    </section>
  )
}

function ShadowRunDetail({ run }: { run: ShadowRerankRun }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
        <span className="muted text-sm">
          成功 {run.succeeded_count} / {run.query_count} · 失败 {run.failed_count} · 实际样本 n=
          {run.actual_sample_count} · 不适用 {run.not_applicable_count}
        </span>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="模型" value={run.requested_model} />
        <Stat label="协议" value={run.protocol_version} />
        <Stat label="Token" value={run.total_tokens.toLocaleString()} />
        <Stat label="请求大小" value={formatBytes(run.request_bytes)} />
        <Stat label="总耗时" value={`${run.latency_ms.toLocaleString()} ms`} />
        <Stat label="费用" value={`¥${run.billed_cost_cny.toFixed(4)}`} />
        <Stat label="Provider" value={run.provider} />
        <Stat label="VLM 审核" value="尚未执行" />
      </dl>
      {run.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          <strong>{run.error.code}</strong>：{run.error.message}
        </p>
      ) : null}
      <MetricSummary summary={run.metric_summary} />
      {run.attempts.map((attempt) => (
        <article key={attempt.id} className="card-surface space-y-3 p-4">
          <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-semibold">{attempt.query_text || attempt.query_id}</h3>
            <span className={statusClass(attempt.status)}>{statusLabel(attempt.status)}</span>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="响应模型" value={attempt.response_model ?? '尚无响应'} />
            <Stat label="模型快照" value={attempt.model_snapshot ?? 'Provider 未提供'} />
            <Stat label="区域" value={attempt.region ?? 'Provider 未提供'} />
            <Stat label="请求 ID" value={attempt.provider_request_id ?? '尚无'} />
            <Stat
              label="候选/结果"
              value={`${attempt.actual_candidate_count}/${attempt.actual_result_count}`}
            />
            <Stat label="Token" value={String(attempt.total_tokens ?? 0)} />
            <Stat label="耗时" value={`${attempt.latency_ms ?? 0} ms`} />
            <Stat label="费用" value={`¥${(attempt.billed_cost_cny ?? 0).toFixed(4)}`} />
          </dl>
          <Fingerprint label="查询指纹" value={attempt.query_fingerprint} />
          <Fingerprint label="证据指纹" value={attempt.evidence_fingerprint} />
          <Fingerprint label="响应指纹" value={attempt.response_fingerprint} />
          {attempt.error ? (
            <div
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
            >
              <strong>{attempt.error.code}</strong>：{attempt.error.message}
            </div>
          ) : null}
          {attempt.applicability_reason ? (
            <p className="muted text-sm">不适用：{attempt.applicability_reason}</p>
          ) : null}
          {attempt.metrics ? <MetricComparison metrics={attempt.metrics} /> : null}
          {attempt.rankings.length ? <RankingTable rankings={attempt.rankings} /> : null}
        </article>
      ))}
    </div>
  )
}

function MetricSummary({ summary }: { summary: ShadowRerankRun['metric_summary'] }) {
  const rows = [
    {
      key: 'successful',
      label: '技术成功样本',
      n: summary.successful_samples.n,
      rrf: summary.successful_samples.rrf,
      shadow: summary.successful_samples.shadow,
    },
    {
      key: 'full',
      label: '完整产品样本（失败按 RRF 回退）',
      n: summary.full_product_samples.n,
      rrf: summary.full_product_samples.rrf,
      shadow: summary.full_product_samples.shadow_with_rrf_fallback,
    },
  ]
  return (
    <section className="space-y-3" aria-labelledby="shadow-summary-title">
      <div>
        <h3 id="shadow-summary-title" className="font-semibold">
          RRF 与影子宏平均
        </h3>
        <p className="muted text-sm">宏平均是先按每条查询算指标，再让每条查询等权平均。</p>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="rounded-md border border-neutral-200 p-3">
          <p className="font-medium">
            {row.label} · n={row.n}
          </p>
          {row.rrf && row.shadow ? (
            <MetricComparison metrics={{ rrf: row.rrf, shadow: row.shadow }} />
          ) : (
            <p className="muted mt-2 text-sm">尚无可计算样本</p>
          )}
        </div>
      ))}
    </section>
  )
}

function RankingTable({ rankings }: { rankings: ShadowRerankRun['attempts'][number]['rankings'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse text-left text-sm">
        <caption className="sr-only">冻结候选的 RRF 与影子重排名次对比</caption>
        <thead>
          <tr className="border-b">
            <th className="p-2">候选</th>
            <th className="p-2">RRF</th>
            <th className="p-2">影子</th>
            <th className="p-2">relevance_score</th>
          </tr>
        </thead>
        <tbody>
          {rankings.map((ranking) => (
            <tr key={ranking.candidate_id} className="border-b last:border-0">
              <td className="p-2 font-mono text-xs">{ranking.candidate_key}</td>
              <td className="p-2 tabular-nums">{ranking.rrf_rank}</td>
              <td className="p-2 tabular-nums">{ranking.shadow_rank ?? 'Top-10 外'}</td>
              <td className="p-2 tabular-nums">{ranking.relevance_score?.toFixed(6) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MetricComparison({
  metrics,
}: {
  metrics: { rrf: EvaluationRankingMetrics; shadow: EvaluationRankingMetrics }
}) {
  const entries = [
    ['precisionAt5', 'Precision@5'],
    ['precisionAt10', 'Precision@10'],
    ['ndcgAt10', 'nDCG@10'],
    ['ndcgAt20', 'nDCG@20'],
    ['hitAt5', 'Hit@5'],
    ['hitAt10', 'Hit@10'],
    ['reciprocalRank', 'MRR'],
  ] as const
  return (
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {entries.flatMap(([key, label]) =>
        ['rrf', 'shadow'].flatMap((source) => {
          const value = metrics[source as 'rrf' | 'shadow'][key]
          return value === null
            ? []
            : [
                <Stat
                  key={`${source}-${key}`}
                  label={`${source === 'rrf' ? 'RRF' : '影子'} ${label}`}
                  value={`${(value * 100).toFixed(2)}%`}
                />,
              ]
        }),
      )}
    </dl>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <dt className="muted">{label}</dt>
      <dd className="mt-1 break-all font-medium text-neutral-950">{value}</dd>
    </div>
  )
}
function Fingerprint({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="text-xs">
      <span className="muted">{label}：</span>
      <code className="break-all">{value ?? '尚无'}</code>
    </p>
  )
}
function formatBytes(value: number) {
  return value < 1024 ? `${value} B` : `${(value / 1024 / 1024).toFixed(2)} MiB`
}
function statusLabel(status: string) {
  return (
    (
      {
        pending: '未运行',
        running: '运行中',
        succeeded: '成功',
        completed_with_errors: '部分失败',
        failed: '失败',
        outcome_unknown: '结果未知',
        not_applicable: '不适用',
      } as Record<string, string>
    )[status] ?? status
  )
}
function statusClass(status: string) {
  return status === 'succeeded'
    ? 'status-chip status-complete'
    : status === 'running' || status === 'pending'
      ? 'status-chip status-running'
      : status === 'completed_with_errors'
        ? 'status-chip status-warning'
        : 'status-chip status-failed'
}
/**
 * Web 边界不能只依赖 TypeScript 类型：HTTP JSON 在运行时仍可能缺字段。
 * null 是合法的“尚未运行”；其他畸形对象必须抛错并由 role=alert 暴露，
 * 不能被静默伪装成未运行。
 */
function parseShadowRerankRun(value: unknown): ShadowRerankRun | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('影子重排 API 响应不是对象')
  const statuses = new Set([
    'pending',
    'running',
    'succeeded',
    'completed_with_errors',
    'failed',
    'not_applicable',
  ])
  const requiredStrings = [
    'id',
    'evaluation_run_id',
    'provider',
    'requested_model',
    'protocol_version',
  ]
  const requiredNumbers = [
    'query_count',
    'succeeded_count',
    'failed_count',
    'not_applicable_count',
    'actual_sample_count',
    'request_bytes',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'latency_ms',
    'billed_cost_cny',
  ]
  if (
    !statuses.has(String(value.status)) ||
    value.requested_model !== 'qwen3-vl-rerank' ||
    value.protocol_version !== 'qwen3-vl-rerank-top20-v1' ||
    value.review_status !== 'not_run' ||
    !requiredStrings.every((field) => typeof value[field] === 'string') ||
    !requiredNumbers.every(
      (field) =>
        typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0,
    ) ||
    !isNullableString(value.response_model) ||
    !isNullableString(value.model_snapshot) ||
    !isNullableString(value.region) ||
    !isStructuredErrorOrNull(value.error) ||
    typeof value.created_at !== 'string' ||
    !isNullableString(value.finished_at) ||
    !Array.isArray(value.attempts) ||
    !value.attempts.every(isShadowAttempt) ||
    !isMetricSummary(value.metric_summary)
  ) {
    throw new Error('影子重排 API 响应不符合 Phase E 协议')
  }
  return value as unknown as ShadowRerankRun
}

function isShadowAttempt(value: unknown) {
  const attemptStatuses = new Set([
    'pending',
    'running',
    'succeeded',
    'failed',
    'outcome_unknown',
    'not_applicable',
  ])
  const externalStatuses = new Set(['not_dispatched', 'dispatched', 'completed', 'outcome_unknown'])
  const nullableNumbers = [
    'request_bytes',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'latency_ms',
    'billed_cost_cny',
  ]
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.query_id === 'string' &&
    typeof value.query_text === 'string' &&
    attemptStatuses.has(String(value.status)) &&
    externalStatuses.has(String(value.external_call_status)) &&
    isNullableString(value.provider_request_id) &&
    isNullableString(value.response_model) &&
    isNullableString(value.model_snapshot) &&
    isNullableString(value.region) &&
    isNullableFingerprint(value.query_fingerprint) &&
    isNullableFingerprint(value.evidence_fingerprint) &&
    isNullableFingerprint(value.response_fingerprint) &&
    nullableNumbers.every((key) => isNonnegativeNumberOrNull(value[key])) &&
    isNonnegativeInteger(value.actual_candidate_count) &&
    isNonnegativeInteger(value.actual_result_count) &&
    (value.metrics === null ||
      (isRecord(value.metrics) &&
        isWebMetricsOrNull(value.metrics.rrf) &&
        value.metrics.rrf !== null &&
        isWebMetricsOrNull(value.metrics.shadow) &&
        value.metrics.shadow !== null)) &&
    isStructuredErrorOrNull(value.error) &&
    isNullableString(value.applicability_reason) &&
    Array.isArray(value.rankings) &&
    value.rankings.every(isShadowRanking)
  )
}

function isShadowRanking(value: unknown) {
  if (!isRecord(value)) return false
  const shadowRankValid =
    value.shadow_rank === null ||
    (isNonnegativeInteger(value.shadow_rank) && value.shadow_rank >= 1 && value.shadow_rank <= 10)
  const scoreValid =
    value.relevance_score === null ||
    (typeof value.relevance_score === 'number' && Number.isFinite(value.relevance_score))
  return (
    typeof value.candidate_id === 'string' &&
    typeof value.candidate_key === 'string' &&
    isNonnegativeInteger(value.rrf_rank) &&
    value.rrf_rank >= 1 &&
    value.rrf_rank <= 20 &&
    shadowRankValid &&
    scoreValid &&
    (value.shadow_rank === null) === (value.relevance_score === null)
  )
}

function isMetricSummary(value: unknown) {
  if (!isRecord(value)) return false
  const successful = value.successful_samples
  const fullProduct = value.full_product_samples
  return (
    isMetricBucket(successful) &&
    isWebMetricsOrNull(successful.rrf) &&
    isWebMetricsOrNull(successful.shadow) &&
    isMetricBucket(fullProduct) &&
    isWebMetricsOrNull(fullProduct.rrf) &&
    isWebMetricsOrNull(fullProduct.shadow_with_rrf_fallback)
  )
}

function isMetricBucket(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.n === 'number' && Number.isInteger(value.n) && value.n >= 0
}

function isWebMetricsOrNull(value: unknown) {
  if (value === null) return true
  if (!isRecord(value)) return false
  const nullableMetricKeys = [
    'precisionAt5',
    'precisionAt10',
    'ndcgAt10',
    'ndcgAt20',
    'hitAt5',
    'hitAt10',
    'hitAt20',
    'reciprocalRank',
  ]
  return (
    nullableMetricKeys.every(
      (key) =>
        value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])),
    ) &&
    typeof value.unjudgeableCount === 'number' &&
    Number.isInteger(value.unjudgeableCount) &&
    value.unjudgeableCount >= 0
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableFingerprint(value: unknown) {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isNonnegativeNumberOrNull(value: unknown) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isStructuredErrorOrNull(value: unknown) {
  return (
    value === null ||
    (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
