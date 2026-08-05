'use client'

import { useState } from 'react'
import {
  createApiClient,
  type EvaluationRankingMetrics,
  type EvaluationReport,
  type EvaluationRun,
  type EvaluationRunStatus,
  type EvaluationRunSummary,
} from '../lib/api-client'

const metricDefinitions = [
  ['precisionAt5', 'Precision@5', '前 5 条中相关候选的比例'],
  ['precisionAt10', 'Precision@10', '前 10 条中相关候选的比例'],
  ['ndcgAt10', 'nDCG@10', '前 10 条中相关等级与排序位置的综合质量'],
  ['ndcgAt20', 'nDCG@20', '前 20 条中相关等级与排序位置的综合质量'],
  ['hitAt5', 'Hit@5', '指定目标是否进入前 5 条'],
  ['hitAt10', 'Hit@10', '指定目标是否进入前 10 条'],
  ['hitAt20', 'Hit@20', '指定目标是否进入前 20 条'],
  ['reciprocalRank', 'MRR', '指定目标首次出现名次的倒数'],
] as const

/**
 * 历史测评报告工作台。
 *
 * 列表只读取 PostgreSQL 中的轻量摘要；用户选择一次已完成运行后，页面再调用带
 * reveal_evidence=true 的只读 API 取得查询文本和冻结名次。服务端仍负责盲标门禁，
 * 所以未完成的运行无法借此提前看到算法证据。
 */
export function EvaluationReportsWorkspace({
  initialRuns,
  total,
  apiClient = createApiClient(),
}: {
  initialRuns: EvaluationRunSummary[]
  total: number
  apiClient?: ReturnType<typeof createApiClient>
}) {
  const [runs, setRuns] = useState(initialRuns)
  const [detail, setDetail] = useState<EvaluationRun | null>(null)
  const [selectedRun, setSelectedRun] = useState<EvaluationRunSummary | null>(null)
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function openReport(run: EvaluationRunSummary) {
    setError(null)
    setLoadingRunId(run.id)
    // 切换运行时先移除旧详情，避免按钮已经指向新运行而下方仍短暂显示上一份报告。
    setDetail(null)
    setSelectedRun(null)
    setSelectedQueryId(null)
    try {
      const loaded = await apiClient.getEvaluationRunReport(run.id)
      setDetail(loaded)
      setSelectedRun(run)
      setSelectedQueryId(loaded.report?.queries[0]?.query_id ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingRunId(null)
    }
  }

  async function loadMoreRuns() {
    setError(null)
    setLoadingMore(true)
    try {
      const response = await apiClient.listEvaluationRuns({ limit: 25, offset: runs.length })
      // 后端使用 created_at + id 稳定排序；按 ID 去重仍可防止用户翻页期间新运行插入
      // 导致边界项重复。新插入项会在下一次刷新后出现在第一页。
      setRuns((current) => {
        const existing = new Set(current.map((run) => run.id))
        return [...current, ...response.items.filter((run) => !existing.has(run.id))]
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  const report = detail?.report ?? null
  const queryTextById = new Map([
    ...(detail?.candidates.map((candidate) => [candidate.query_id, candidate.query_text] as const) ??
      []),
    ...(detail?.queries?.map((query) => [query.id, query.query_text] as const) ?? []),
  ])
  const selectedCandidates =
    detail?.candidates
      .filter((candidate) => candidate.query_id === selectedQueryId)
      .sort(
        (left, right) =>
          (left.rrf_rank ?? left.current_rank ?? Number.MAX_SAFE_INTEGER) -
          (right.rrf_rank ?? right.current_rank ?? Number.MAX_SAFE_INTEGER),
      ) ?? []

  return (
    <section className="space-y-6">
      <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">内部工具 · PostgreSQL 历史记录</p>
          <h1 className="page-title">测评报告</h1>
          <p className="muted mt-2 max-w-3xl">
            查看已经保存的检索指标、逐查询对比和候选名次变化。页面只读，不会重新调用模型。
          </p>
        </div>
        <a className="secondary-action" href="/evaluation">
          返回评测工作台
        </a>
      </header>

      {error ? <p role="alert">读取报告失败：{error}</p> : null}

      <section className="panel space-y-4" aria-labelledby="run-history-title">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="run-history-title" className="section-title">
              历史运行
            </h2>
            <p className="muted">共 {total} 次；当前显示最近 {runs.length} 次。</p>
          </div>
        </div>
        {runs.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {runs.map((run) => (
              <article key={run.id} className="card-surface space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="card-title">
                      {run.set_name} · v{run.version}
                    </h3>
                    <p className="eyebrow mt-1">{formatDate(run.finished_at ?? run.created_at)}</p>
                  </div>
                  <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
                </div>
                <dl className="grid grid-cols-3 gap-3 text-sm">
                  <Stat label="查询" value={run.query_count} />
                  <Stat label="候选" value={run.candidate_count} />
                  <Stat
                    label="正式标注"
                    value={`${run.judged_required_candidate_count}/${run.required_candidate_count}`}
                  />
                </dl>
                {run.error_message ? (
                  <p role="alert" className="text-sm text-red-700">
                    {run.error_code}：{run.error_message}
                  </p>
                ) : null}
                <button
                  className="primary-action"
                  disabled={!run.report || loadingRunId === run.id}
                  onClick={() => void openReport(run)}
                >
                  {loadingRunId === run.id ? '读取中…' : run.report ? '查看报告' : '报告未生成'}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">还没有测评运行。请先在评测工作台冻结版本、运行并生成报告。</p>
        )}
        {runs.length < total ? (
          <button
            className="secondary-action"
            disabled={loadingMore}
            onClick={() => void loadMoreRuns()}
          >
            {loadingMore ? '加载中…' : '加载更多历史运行'}
          </button>
        ) : null}
      </section>

      {report ? (
        <>
          <section className="panel" aria-label="当前报告">
            <p className="eyebrow">当前报告</p>
            <h2 className="section-title mt-1">
              {selectedRun?.set_name} · v{selectedRun?.version}
            </h2>
            <p className="muted mt-2">
              完成时间：{selectedRun ? formatDate(selectedRun.finished_at ?? selectedRun.created_at) : ''}
              {' · '}运行 ID：{selectedRun?.id}
            </p>
          </section>
          <ReportMethodology report={report} />
          <ReportSummary report={report} />
          <section className="panel space-y-4" aria-labelledby="query-comparison-title">
            <div>
              <h2 id="query-comparison-title" className="section-title">
                逐查询指标
              </h2>
              <p className="muted">
                Current 是当前生产排序；RRF 是按各召回通道名次融合的实验排序。百分比越高越好。
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <caption className="sr-only">每条查询的 Current、RRF 与 VLM 影子重排指标</caption>
                <thead>
                  <tr className="border-b">
                    <th className="p-3">查询</th>
                    <th className="p-3">指标</th>
                    <th className="p-3">Current</th>
                    <th className="p-3">RRF</th>
                    <th className="p-3">VLM 影子重排</th>
                  </tr>
                </thead>
                <tbody>
                  {report.queries.flatMap((query) =>
                    applicableMetrics(query.current).map(([key, label, description], index) => (
                      <tr key={`${query.query_id}:${key}`} className="border-b last:border-0">
                        <td className="p-3 font-medium text-neutral-950">
                          {index === 0 ? queryTextById.get(query.query_id) || query.query_id : ''}
                        </td>
                        <td className="p-3">
                          <span className="font-medium text-neutral-950">{label}</span>
                          <span className="muted block">{description}</span>
                        </td>
                        <td className="p-3 tabular-nums">{formatScore(query.current[key])}</td>
                        <td className="p-3 tabular-nums">{formatScore(query.rrf[key])}</td>
                        <td className="p-3 tabular-nums">
                          {query.shadow_rerank
                            ? formatScore(query.shadow_rerank[key])
                            : '尚未执行'}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <CandidateRanks
            detail={detail!}
            selectedQueryId={selectedQueryId}
            setSelectedQueryId={setSelectedQueryId}
            queryTextById={queryTextById}
            candidates={selectedCandidates}
          />
        </>
      ) : null}
    </section>
  )
}

function ReportSummary({ report }: { report: EvaluationReport }) {
  // 自然发现与指定目标是两种不同任务，不能把 nDCG 和 MRR 混成一个平均数。
  // 只展示本次运行实际适用的摘要指标；混合评测集会同时出现两组对比卡片。
  const summaries = [
    ['ndcgAt10', '发现查询 · 平均 nDCG@10'],
    ['reciprocalRank', '指定目标 · 平均 MRR'],
  ] as const
  const applicable = summaries.filter(([key]) =>
    report.queries.some((query) => query.current[key] !== null),
  )
  return (
    <section className="space-y-3" aria-label="报告摘要">
      {applicable.map(([key, label]) => {
        const currentValues = report.queries.map((query) => query.current[key])
        const rrfValues = report.queries.map((query) => query.rrf[key])
        const shadowValues = report.queries.map((query) => query.shadow_rerank?.[key] ?? null)
        const current = average(currentValues)
        const rrf = average(rrfValues)
        const shadow = average(shadowValues)
        return (
          <div key={key} className="grid gap-3 sm:grid-cols-3">
            <MetricCard
              label={`Current · ${label} · n=${applicableCount(currentValues)}`}
              value={formatScore(current)}
            />
            <MetricCard
              label={`RRF · ${label} · n=${applicableCount(rrfValues)}`}
              value={formatScore(rrf)}
            />
            <MetricCard
              label={`VLM 影子重排 · ${label} · n=${applicableCount(shadowValues)}`}
              value={shadow === null ? '尚未执行' : formatScore(shadow)}
            />
          </div>
        )
      })}
    </section>
  )
}

function ReportMethodology({ report }: { report: EvaluationReport }) {
  const discoveryCount = report.queries.filter(
    (query) => query.current.ndcgAt10 !== null,
  ).length
  const knownTargetCount = report.queries.filter(
    (query) => query.current.reciprocalRank !== null,
  ).length
  return (
    <section className="panel space-y-3" aria-labelledby="report-methodology-title">
      <h2 id="report-methodology-title" className="section-title">
        指标口径
      </h2>
      <div className="grid gap-3 text-sm leading-6 md:grid-cols-2">
        <p>
          <strong className="text-neutral-950">自然发现查询（{discoveryCount} 条）</strong>：
          Precision@K（前 K 条准确率）等于前 K 条中人工判为相关的比例；nDCG@K
          （Normalized Discounted Cumulative Gain，归一化折损累计增益）先让相关收益随名次靠后逐步折损，
          再用实际累计收益除以理想排序的累计收益，因此高度相关内容越靠前得分越高。
        </p>
        <p>
          <strong className="text-neutral-950">指定目标查询（{knownTargetCount} 条）</strong>：
          Hit@K 表示预先指定的正确目标是否进入前 K 条；MRR（Mean Reciprocal Rank，平均倒数排名）
          对每条查询取正确目标首次出现名次的倒数，再对查询求平均。
        </p>
        <p>
          所有百分比范围都是 0%–100%，越高越好。摘要采用宏平均：先算每条适用查询，再求平均；
          <code>n</code> 是参与该平均的查询数，不适用的查询不会按 0 分混入。
        </p>
        <p>
          Current 是当前生产排序；RRF（Reciprocal Rank Fusion，倒数排名融合）只按各召回通道名次合并；
          VLM（Vision-Language Model，视觉语言模型）影子重排只做对照，不改变用户实际看到的生产排序。
        </p>
      </div>
    </section>
  )
}

function CandidateRanks({
  detail,
  selectedQueryId,
  setSelectedQueryId,
  queryTextById,
  candidates,
}: {
  detail: EvaluationRun
  selectedQueryId: string | null
  setSelectedQueryId: (id: string) => void
  queryTextById: Map<string, string>
  candidates: EvaluationRun['candidates']
}) {
  const queryIds = detail.report?.queries.map((query) => query.query_id) ?? []
  return (
    <section className="panel space-y-4" aria-labelledby="candidate-ranks-title">
      <div>
        <h2 id="candidate-ranks-title" className="section-title">
          候选名次变化
        </h2>
        <p className="muted">同一冻结候选在不同排序中的位置；“4 → 1”表示从第 4 名升到第 1 名。</p>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="选择查询">
        {queryIds.map((queryId) => (
          <button
            key={queryId}
            className={queryId === selectedQueryId ? 'filter-chip-active' : 'filter-chip'}
            onClick={() => setSelectedQueryId(queryId)}
          >
            {queryTextById.get(queryId) || queryId}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-sm">
          <caption className="sr-only">所选查询的候选相关等级和排序名次变化</caption>
          <thead>
            <tr className="border-b">
              <th className="p-3">候选</th>
              <th className="p-3">人工判断</th>
              <th className="p-3">Current → RRF</th>
              <th className="p-3">VLM 影子重排</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.id} className="border-b last:border-0">
                <td className="p-3">
                  <span className="font-medium text-neutral-950">{candidate.media_type}</span>
                  <span className="eyebrow block">{candidate.scene_id ?? candidate.file_id}</span>
                </td>
                <td className="p-3">{judgmentLabel(candidate.judgment)}</td>
                <td className="p-3 font-medium tabular-nums text-neutral-950">
                  {formatRank(candidate.current_rank)} → {formatRank(candidate.rrf_rank)}
                </td>
                <td className="p-3 tabular-nums">
                  {candidate.shadow_rerank_rank === undefined
                    ? '尚未执行'
                    : formatRank(candidate.shadow_rerank_rank)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 font-medium text-neutral-950 tabular-nums">{value}</dd>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="card-surface p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-neutral-950 tabular-nums">{value}</p>
    </article>
  )
}

function applicableMetrics(metrics: EvaluationRankingMetrics) {
  return metricDefinitions.filter(([key]) => metrics[key] !== null)
}

function average(values: Array<number | null>) {
  const applicable = values.filter((value): value is number => value !== null)
  return applicable.length
    ? applicable.reduce((sum, value) => sum + value, 0) / applicable.length
    : null
}

function applicableCount(values: Array<number | null>) {
  return values.filter((value) => value !== null).length
}

function formatScore(value: number | null) {
  return value === null ? '不适用' : `${(value * 100).toFixed(1)}%`
}

function formatRank(rank: number | null | undefined) {
  return rank === null || rank === undefined ? '未进入' : String(rank)
}

function judgmentLabel(judgment: EvaluationRun['candidates'][number]['judgment']) {
  if (!judgment) return '无需判断'
  if (judgment.unjudgeable) return '无法判断'
  return judgment.relevance === 2 ? '高度相关' : judgment.relevance === 1 ? '部分相关' : '不相关'
}

function statusLabel(status: EvaluationRunStatus) {
  const labels: Record<EvaluationRunStatus, string> = {
    pending: '等待运行',
    reported: '报告已生成',
    failed: '运行失败',
    labeled: '等待生成报告',
    ready_for_labeling: '等待盲标',
    retrieving: '检索中',
  }
  return labels[status]
}

function statusClass(status: EvaluationRunStatus) {
  const tone = status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-neutral-100 text-neutral-700'
  return `rounded-full px-2.5 py-1 text-xs font-medium ${tone}`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
