'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  createApiClient,
  type VlmBlindCandidateReviewPacket,
  type VlmBlindDataset,
  type VlmBlindGroup,
  type VlmBlindLabelingState,
  type VlmBlindLabelStage,
  type VlmBlindVerdict,
} from '../lib/api-client'
import { EvaluationBreadcrumbs } from './evaluation-breadcrumbs'

const groups: Array<{ value: VlmBlindGroup; label: string; explanation: string }> = [
  { value: 'exact_match', label: '完全符合', explanation: '建议用于检查模型是否能正确通过正例' },
  {
    value: 'missing_must_have',
    label: '缺少必须条件',
    explanation: '建议用于检查模型能否找出关键缺失',
  },
  {
    value: 'exclusion_hit',
    label: '命中排除条件',
    explanation: '建议用于检查模型能否拒绝明确反例',
  },
  {
    value: 'partial_relevance',
    label: '部分相关',
    explanation: '建议用于区分“有点像”与“条件真正成立”',
  },
  {
    value: 'insufficient_evidence',
    label: '证据不足',
    explanation: '建议用于检查帧未覆盖关键动作时能否保持不确定',
  },
]

/**
 * 同一页面先完成候选审核，再在候选冻结后切换到条件级人工盲标。两个状态机分别来自
 * PostgreSQL，页面不会为了进入一审而把 immutable candidate dataset 改回可编辑。
 */
export function VlmBlindCandidateReviewWorkspace({
  packet,
  initialDataset,
  initialLabeling = null,
  apiClient = createApiClient(),
}: {
  packet: VlmBlindCandidateReviewPacket
  initialDataset: VlmBlindDataset | null
  initialLabeling?: VlmBlindLabelingState | null
  apiClient?: ReturnType<typeof createApiClient>
}) {
  const [dataset, setDataset] = useState(initialDataset)
  const [activeGroup, setActiveGroup] = useState<VlmBlindGroup>('exact_match')
  const [groupOverrides, setGroupOverrides] = useState<Record<string, VlmBlindGroup>>({})
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null)
  const [busyDecision, setBusyDecision] = useState<'accepted' | 'rejected' | null>(null)
  const [caseErrors, setCaseErrors] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [generatingReplacements, setGeneratingReplacements] = useState(false)
  const [rebalancingGroups, setRebalancingGroups] = useState(false)
  const [freezing, setFreezing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const visibleCases = useMemo(
    () =>
      dataset?.cases.filter((item) => item.is_active && item.proposed_group === activeGroup) ?? [],
    [activeGroup, dataset],
  )
  const activeGroupCounts = useMemo(() => {
    const counts = new Map<VlmBlindGroup, number>(groups.map((group) => [group.value, 0]))
    for (const candidateCase of dataset?.cases ?? []) {
      if (!candidateCase.is_active) continue
      const group = candidateCase.reviewed_group ?? candidateCase.proposed_group
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
    return counts
  }, [dataset])
  const needsGroupRebalance =
    dataset?.status === 'candidate_review' &&
    dataset?.summary.pending === 0 &&
    dataset.summary.rejected === 0 &&
    dataset.summary.accepted === 60 &&
    groups.some((group) => activeGroupCounts.get(group.value) !== 12)
  const canFreezeCandidateReview =
    dataset?.status === 'candidate_review' &&
    dataset.summary.pending === 0 &&
    dataset.summary.rejected === 0 &&
    dataset.summary.accepted === 60 &&
    groups.every((group) => activeGroupCounts.get(group.value) === 12)

  async function createReviewBatch() {
    if (importing) return
    setImporting(true)
    setError('')
    setMessage('正在导入候选建议…')
    try {
      setDataset(
        await apiClient.importVlmBlindCandidateReviewPacket('Agent V1 Phase F 候选审核 1', packet),
      )
      setMessage('已创建 60 对候选审核批次。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setMessage('')
    } finally {
      setImporting(false)
    }
  }

  async function reviewCase(caseId: string, decision: 'accepted' | 'rejected') {
    if (!dataset || dataset.status !== 'candidate_review') return
    setBusyCaseId(caseId)
    setBusyDecision(decision)
    setCaseErrors((current) => ({ ...current, [caseId]: '' }))
    setError('')
    try {
      const candidateCase = dataset.cases.find((item) => item.id === caseId)!
      const next = await apiClient.reviewVlmBlindCandidate(
        dataset.id,
        caseId,
        decision === 'accepted'
          ? {
              decision,
              reviewed_group: groupOverrides[caseId] ?? candidateCase.proposed_group,
            }
          : { decision },
      )
      setDataset(next)
      setMessage(decision === 'accepted' ? '已接受候选。' : '已拒绝候选，不会进入盲标。')
    } catch (caught) {
      const nextError = caught instanceof Error ? caught.message : String(caught)
      setError(nextError)
      setCaseErrors((current) => ({ ...current, [caseId]: nextError }))
    } finally {
      setBusyCaseId(null)
      setBusyDecision(null)
    }
  }

  async function generateReplacements() {
    if (!dataset || generatingReplacements || dataset.summary.rejected === 0) return
    setGeneratingReplacements(true)
    setError('')
    setMessage('正在丢弃被拒绝的查询文本并生成替代案例…')
    try {
      const next = await apiClient.generateVlmBlindCandidateReplacements(dataset.id)
      setDataset(next)
      setMessage(`拒绝过的查询已退出盲测池；当前有 ${next.summary.pending} 条待审核候选。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setMessage('')
    } finally {
      setGeneratingReplacements(false)
    }
  }

  /**
   * 人工分组可能让某些组超过 12、另一些组不足 12。再平衡不会改写这些人工结论；
   * Server 会保留超额组的 accepted 父记录，并为缺额组追加同一冻结查询下的新 pending 子记录。
   */
  async function rebalanceGroups() {
    if (!dataset || rebalancingGroups || !needsGroupRebalance) return
    setRebalancingGroups(true)
    setError('')
    setMessage('正在按人工分组结果生成配额替代候选…')
    try {
      const next = await apiClient.rebalanceVlmBlindCandidateGroups(dataset.id)
      setDataset(next)
      setMessage(`已生成 ${next.summary.pending} 条待审核配额替代候选。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setMessage('')
    } finally {
      setRebalancingGroups(false)
    }
  }

  /**
   * 冻结是候选审核的终态：Server 会再次核对数量、分组、查询多样性与历史拒绝文本，
   * 再为规范化快照生成 SHA-256 指纹。这里不在浏览器自行计算指纹，避免前后端口径漂移。
   */
  async function freezeCandidateReview() {
    if (!dataset || freezing || !canFreezeCandidateReview) return
    setFreezing(true)
    setError('')
    setMessage('正在核对并冻结 60 条盲测候选…')
    try {
      const next = await apiClient.freezeVlmBlindCandidateReview(dataset.id)
      setDataset(next)
      setMessage(`候选已冻结；冻结指纹 ${next.frozen_fingerprint?.slice(0, 8)}…`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setMessage('')
    } finally {
      setFreezing(false)
    }
  }

  return (
    <section className="space-y-6">
      <EvaluationBreadcrumbs
        items={[
          { label: '评测主页', href: '/evaluation' },
          { label: '历史报告', href: '/evaluation/reports' },
          { label: 'Phase F 候选审核' },
        ]}
      />
      <header className="overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-6 shadow-sm sm:p-8">
        <p className="eyebrow">Agent V1 · Phase F 前置数据</p>
        <h1 className="page-title mt-2">VLM 人工盲测候选审核</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-neutral-700">
          候选分组只是抽样建议，不是人工真值。请播放视频并对照原子条件，再决定接受、拒绝或调整分组。
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-sm font-medium">
          <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-emerald-900">
            真实 VLM 调用：0
          </span>
          <span className="rounded-full bg-white px-3 py-1.5 text-neutral-700 ring-1 ring-neutral-200">
            尚未执行 VLM 审核
          </span>
          <span className="rounded-full bg-white px-3 py-1.5 text-neutral-700 ring-1 ring-neutral-200">
            只读本地媒体预览
          </span>
        </div>
      </header>

      <div aria-live="polite" className="min-h-6 text-sm text-neutral-700">
        {error ? (
          <span role="alert" className="text-red-700">
            审核失败：{error}
          </span>
        ) : (
          message
        )}
      </div>

      {!dataset ? (
        <section className="surface-card p-6">
          <h2 className="section-title">候选包已就绪</h2>
          <p className="mt-2 text-sm text-neutral-600">
            本地快照包含 60 对建议，每组 12 对。创建批次只会将审核快照写入 PostgreSQL。
          </p>
          <button
            className="primary-action mt-4"
            disabled={importing}
            onClick={createReviewBatch}
            type="button"
          >
            {importing ? '正在创建…' : '创建候选审核批次'}
          </button>
        </section>
      ) : (
        <>
          {/* 终态或下一步操作放在统计卡之前，让窄屏用户无需越过五张卡片才能看到结果。 */}
          {dataset.status === 'frozen' ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
              <p className="font-bold">候选已冻结</p>
              <p className="mt-1 text-sm leading-6">
                这 60 条候选已成为只读盲测快照。冻结指纹{' '}
                <span className="font-mono font-semibold">
                  {dataset.frozen_fingerprint?.slice(0, 8)}…
                </span>
                ，用于确认后续读取的是同一批数据。
              </p>
            </div>
          ) : canFreezeCandidateReview ? (
            <div className="rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white p-4 shadow-sm">
              <p className="font-bold text-emerald-950">60 条候选已满足冻结条件</p>
              <p className="mt-1 text-sm leading-6 text-emerald-900">
                五组各 12 条且没有待审核或有效拒绝。冻结后候选、分组和条件将只读；此操作不会调用
                VLM。
              </p>
              <button
                className="mt-3 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                disabled={freezing}
                onClick={freezeCandidateReview}
                type="button"
              >
                {freezing ? '正在冻结…' : '冻结盲测候选'}
              </button>
            </div>
          ) : null}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="有效候选审核进度">
            <ProgressStat label="待审核" value={dataset.summary.pending} tone="amber" />
            <ProgressStat label="已接受" value={dataset.summary.accepted} tone="green" />
            <ProgressStat label="已拒绝" value={dataset.summary.rejected} tone="red" />
            <ProgressStat
              label="历史拒绝"
              value={dataset.summary.historical_rejected}
              tone="neutral"
            />
            <ProgressStat
              label="历史接受"
              value={dataset.summary.historical_accepted}
              tone="neutral"
            />
          </section>
          {dataset.status === 'frozen' && initialLabeling ? (
            <HumanConditionLabelingPanel apiClient={apiClient} initialState={initialLabeling} />
          ) : null}
          {dataset.status !== 'frozen' ? (
            <>
              {dataset.summary.rejected > 0 ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm leading-6 text-red-950">
                    当前有 {dataset.summary.rejected} 条有效候选被拒绝。该查询文本及所有同文本候选
                    都不会进入盲测；系统会保留审核历史，并从未被拒绝的冻结查询中追加待审核案例。
                  </p>
                  <button
                    className="primary-action mt-3"
                    disabled={generatingReplacements}
                    onClick={generateReplacements}
                    type="button"
                  >
                    {generatingReplacements ? '正在生成…' : '丢弃查询并生成替代候选'}
                  </button>
                </div>
              ) : null}
              {needsGroupRebalance ? (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm leading-6 text-blue-950">
                    60 条有效候选已全部接受，但人工分组尚未达到每组 12 条。再平衡会保留旧审核记录，
                    只为不足的组追加新的待审核候选。
                  </p>
                  <button
                    className="primary-action mt-3"
                    disabled={rebalancingGroups}
                    onClick={rebalanceGroups}
                    type="button"
                  >
                    {rebalancingGroups ? '正在再平衡…' : '按人工分组生成替代候选'}
                  </button>
                </div>
              ) : null}
              <nav aria-label="候选分组" className="flex gap-2 overflow-x-auto pb-2">
                {groups.map((group) => (
                  <button
                    aria-pressed={activeGroup === group.value}
                    className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                      activeGroup === group.value
                        ? 'bg-neutral-950 text-white'
                        : 'bg-white text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50'
                    }`}
                    key={group.value}
                    onClick={() => setActiveGroup(group.value)}
                    type="button"
                  >
                    {group.label}
                  </button>
                ))}
              </nav>
              <p className="text-sm text-neutral-600">
                {groups.find((group) => group.value === activeGroup)!.explanation}
              </p>
              <div className="grid gap-5 xl:grid-cols-2">
                {visibleCases.map((candidateCase) => {
                  const isBusy = busyCaseId === candidateCase.id
                  const isAccepted = candidateCase.review_status === 'accepted'
                  const isRejected = candidateCase.review_status === 'rejected'
                  const caseError = caseErrors[candidateCase.id]
                  return (
                    <article
                      className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm"
                      key={candidateCase.id}
                    >
                      <video
                        aria-label={`播放候选视频：${candidateCase.query_text}`}
                        className="aspect-video w-full bg-neutral-950 object-contain"
                        controls
                        playsInline
                        preload="metadata"
                        src={apiClient.mediaContentUrl(candidateCase.file_id, {
                          startTimeSeconds: candidateCase.start_time_seconds,
                          endTimeSeconds: candidateCase.end_time_seconds,
                        })}
                      />
                      <div className="space-y-4 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="eyebrow">{candidateCase.proposal_id}</p>
                            <h2 className="mt-1 text-lg font-bold text-neutral-950">
                              {candidateCase.query_text}
                            </h2>
                            <p className="mt-1 text-sm text-neutral-500 tabular-nums">
                              {candidateCase.start_time_seconds.toFixed(1)}s –{' '}
                              {candidateCase.end_time_seconds.toFixed(1)}s
                            </p>
                          </div>
                          <CandidateReviewStatus
                            candidateCase={candidateCase}
                            error={caseError}
                            isBusy={isBusy}
                          />
                        </div>
                        <div className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                          {candidateCase.selection_basis}
                        </div>
                        <ul className="space-y-2" aria-label="待核对条件">
                          {candidateCase.conditions.map((condition) => (
                            <li
                              className="rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                              key={condition.condition_id}
                            >
                              <span className="mr-2 font-semibold text-neutral-500">
                                {conditionKindLabel(condition.kind)}
                              </span>
                              {condition.source_text}
                            </li>
                          ))}
                        </ul>
                        <label className="block text-sm font-semibold text-neutral-800">
                          审核后分组
                          <select
                            className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                            onChange={(event) =>
                              setGroupOverrides((current) => ({
                                ...current,
                                [candidateCase.id]: event.target.value as VlmBlindGroup,
                              }))
                            }
                            disabled={dataset.status !== 'candidate_review'}
                            value={
                              groupOverrides[candidateCase.id] ??
                              candidateCase.reviewed_group ??
                              candidateCase.proposed_group
                            }
                          >
                            {groups.map((group) => (
                              <option key={group.value} value={group.value}>
                                {group.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="flex flex-wrap gap-3">
                          <button
                            aria-pressed={isAccepted}
                            className={
                              isAccepted
                                ? 'rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2'
                                : 'primary-action'
                            }
                            disabled={busyCaseId !== null || dataset.status !== 'candidate_review'}
                            onClick={() => reviewCase(candidateCase.id, 'accepted')}
                            type="button"
                          >
                            {isBusy && busyDecision === 'accepted'
                              ? '正在保存…'
                              : isAccepted
                                ? '已接受'
                                : '接受这对候选'}
                          </button>
                          <button
                            aria-pressed={isRejected}
                            className={
                              isRejected
                                ? 'rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2'
                                : 'secondary-action'
                            }
                            disabled={busyCaseId !== null || dataset.status !== 'candidate_review'}
                            onClick={() => reviewCase(candidateCase.id, 'rejected')}
                            type="button"
                          >
                            {isBusy && busyDecision === 'rejected'
                              ? '正在保存…'
                              : isRejected
                                ? '已拒绝，需替换'
                                : '拒绝，需替换'}
                          </button>
                          <a className="secondary-action" href={`/media/${candidateCase.file_id}`}>
                            打开媒体详情
                          </a>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}

function HumanConditionLabelingPanel({
  initialState,
  apiClient,
}: {
  initialState: VlmBlindLabelingState
  apiClient: ReturnType<typeof createApiClient>
}) {
  const [state, setState] = useState(initialState)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const activeStage: VlmBlindLabelStage | null =
    state.labels_status === 'first_pass'
      ? 'first'
      : state.labels_status === 'second_pass'
        ? 'second'
        : state.labels_status === 'adjudication'
          ? 'final'
          : null

  // Worker 异步构建证据时每 3 秒读取 PostgreSQL 状态。后台标签页暂停轮询，恢复可见后
  // 立即刷新；GET 不创建 Job 或 Provider 请求，所以刷新页面也不会产生隐藏副作用。
  useEffect(() => {
    if (state.labels_status !== 'evidence_preparing') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const next = await apiClient.getVlmBlindLabeling(state.dataset_id)
        if (!cancelled) {
          setState(next)
          setError('')
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
      if (!cancelled) timer = setTimeout(refresh, 3_000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    timer = setTimeout(refresh, 3_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [apiClient, state.dataset_id, state.labels_status])

  async function runAction(
    key: string,
    action: () => Promise<VlmBlindLabelingState>,
    success: string,
  ) {
    if (busy) return
    setBusy(key)
    setError('')
    setMessage('')
    try {
      setState(await action())
      setMessage(success)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy('')
    }
  }

  async function saveLabel(
    caseId: string,
    conditionId: string,
    stage: VlmBlindLabelStage,
    verdict: VlmBlindVerdict,
  ) {
    const key = `${conditionId}:${stage}`
    await runAction(
      key,
      () =>
        apiClient.saveVlmBlindConditionLabel(state.dataset_id, caseId, conditionId, stage, {
          verdict,
        }),
      `已保存${stageLabel(stage)}判断。`,
    )
  }

  const visibleCases = state.cases.filter((candidateCase) =>
    activeStage === 'final'
      ? candidateCase.conditions.some((condition) => condition.needs_adjudication)
      : true,
  )

  return (
    <section className="space-y-5 rounded-3xl border border-blue-200 bg-blue-50/40 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">独立人工标签会话</p>
          <h2 className="section-title mt-1">条件级盲标</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-700">
            候选仍保持冻结。先准备现有索引帧，再依次完成第一轮、独立复核和争议裁决；系统不会自动填写人工真值。
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-sm font-bold text-blue-900 ring-1 ring-blue-200">
          {labelingStatusLabel(state.labels_status)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="条件盲标总进度">
        <ProgressStat label="证据完成" value={state.evidence_summary.succeeded} tone="neutral" />
        <ProgressStat label="第一轮" value={state.label_progress.first} tone="amber" />
        <ProgressStat label="复核" value={state.label_progress.second} tone="neutral" />
        <ProgressStat label="已解析" value={state.label_progress.resolved} tone="green" />
      </div>
      <p className="text-sm text-neutral-600">
        证据 {state.evidence_summary.succeeded}/{state.evidence_summary.total} 条；条件共{' '}
        {state.label_progress.total} 个。争议条件 {state.label_progress.adjudication_required} 个。
      </p>

      <div aria-live="polite" aria-atomic="true" className="min-h-6 text-sm">
        {error ? (
          <span className="text-red-700" role="alert">
            操作失败：{error}。可保留当前进度后重试。
          </span>
        ) : (
          message
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {['evidence_pending', 'evidence_failed'].includes(state.labels_status) ? (
          <button
            className="primary-action"
            disabled={Boolean(busy)}
            onClick={() =>
              runAction(
                'evidence',
                () => apiClient.prepareVlmBlindEvidence(state.dataset_id),
                '证据任务已创建；页面会自动刷新进度。',
              )
            }
            type="button"
          >
            {busy === 'evidence' ? '正在创建任务…' : '准备 60 条独立索引帧证据'}
          </button>
        ) : null}
        {state.labels_status === 'ready_to_freeze' ? (
          <button
            className="primary-action"
            disabled={Boolean(busy)}
            onClick={() =>
              runAction(
                'freeze-labels',
                () => apiClient.freezeVlmBlindLabels(state.dataset_id),
                '人工标签已冻结。',
              )
            }
            type="button"
          >
            {busy === 'freeze-labels' ? '正在冻结…' : '冻结人工条件标签'}
          </button>
        ) : null}
        {state.labels_status === 'labels_frozen' && !state.fake_report ? (
          <button
            className="primary-action"
            disabled={Boolean(busy)}
            onClick={() =>
              runAction(
                'fake-run',
                () => apiClient.runVlmBlindFake(state.dataset_id),
                '本地 fake 协议演练已完成，真实调用仍为 0。',
              )
            }
            type="button"
          >
            {busy === 'fake-run' ? '正在演练…' : '运行本地 fake 协议演练'}
          </button>
        ) : null}
        <button
          className="secondary-action"
          disabled={Boolean(busy)}
          onClick={() =>
            runAction(
              'refresh',
              () => apiClient.getVlmBlindLabeling(state.dataset_id),
              '已刷新 PostgreSQL 进度。',
            )
          }
          type="button"
        >
          刷新进度
        </button>
      </div>

      {state.fake_report && state.labels_status === 'labels_frozen' ? (
        <FakeReport report={state.fake_report} />
      ) : null}

      {activeStage ? (
        <div className="grid gap-5 xl:grid-cols-2">
          {visibleCases.map((candidateCase) => (
            <article
              className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm"
              key={candidateCase.id}
            >
              <video
                aria-label={`播放盲标视频：${candidateCase.query_text}`}
                className="aspect-video w-full bg-neutral-950 object-contain"
                controls
                playsInline
                preload="metadata"
                src={apiClient.mediaContentUrl(candidateCase.file_id, {
                  startTimeSeconds: candidateCase.start_time_seconds,
                  endTimeSeconds: candidateCase.end_time_seconds,
                })}
              />
              <div className="space-y-4 p-5">
                <div>
                  <p className="eyebrow">{candidateCase.proposal_id}</p>
                  <h3 className="mt-1 text-lg font-bold text-neutral-950">
                    {candidateCase.query_text}
                  </h3>
                  <p className="mt-1 text-sm text-neutral-500">
                    证据状态：{evidenceStatusLabel(candidateCase.evidence?.status)} · 独立索引帧{' '}
                    {candidateCase.evidence?.frame_count ?? '—'} 张
                  </p>
                </div>
                <div className="space-y-3">
                  {candidateCase.conditions
                    .filter((condition) => activeStage !== 'final' || condition.needs_adjudication)
                    .map((condition) => {
                      const selected = condition[activeStage]
                      const conditionBusy = busy === `${condition.id}:${activeStage}`
                      return (
                        <fieldset
                          className="rounded-2xl border border-neutral-200 p-4"
                          key={condition.id}
                        >
                          <legend className="px-1 text-sm font-bold text-neutral-900">
                            {conditionKindLabel(condition.kind)}：{condition.source_text}
                          </legend>
                          <p className="mt-1 text-xs text-neutral-500">
                            {activeStage === 'final'
                              ? `一审 ${verdictLabel(condition.first)}；复核 ${verdictLabel(condition.second)}`
                              : `${stageLabel(activeStage)} · 可用 Tab 聚焦，Enter 或空格选择`}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(['yes', 'no', 'uncertain'] as const).map((verdict) => (
                              <button
                                aria-keyshortcuts={
                                  verdict === 'yes' ? '1' : verdict === 'no' ? '2' : '3'
                                }
                                aria-pressed={selected === verdict}
                                className={`rounded-xl px-3 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                  selected === verdict
                                    ? 'bg-blue-700 text-white'
                                    : 'bg-neutral-100 text-neutral-800 hover:bg-neutral-200'
                                }`}
                                disabled={Boolean(busy)}
                                key={verdict}
                                onClick={() =>
                                  saveLabel(candidateCase.id, condition.id, activeStage, verdict)
                                }
                                type="button"
                              >
                                {verdictLabel(verdict)}
                              </button>
                            ))}
                          </div>
                          <p aria-live="polite" className="mt-2 min-h-5 text-xs text-blue-800">
                            {conditionBusy
                              ? '正在保存…'
                              : selected
                                ? `${stageLabel(activeStage)}已保存：${verdictLabel(selected)}`
                                : '尚未判断'}
                          </p>
                        </fieldset>
                      )
                    })}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function FakeReport({ report }: { report: NonNullable<VlmBlindLabelingState['fake_report']> }) {
  const conditionAccuracy = report.metrics?.condition_accuracy
  const caseAccuracy = report.metrics?.case_status_accuracy
  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-violet-950">fake 协议演练只读报告</h3>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-violet-900">
          真实 VLM 调用：{report.external_call_count}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-violet-950">
        条件一致率 {formatRatio(conditionAccuracy)}：逐条件比较 fake 与冻结人工结论，越高表示这份
        固定假输出碰巧一致得越多；案例状态一致率 {formatRatio(caseAccuracy)}：比较 Server
        派生的通过/拒绝状态。两者只验证协议链路，不代表真实模型质量。
      </p>
      <p className="mt-2 text-xs text-violet-800">
        共 {report.case_count} 个案例；成功 {report.succeeded_count}，不适用{' '}
        {report.not_applicable_count}，失败 {report.failed_count}。
      </p>
    </section>
  )
}

function labelingStatusLabel(status: VlmBlindLabelingState['labels_status']) {
  return {
    evidence_pending: '候选已冻结 · 待准备证据',
    evidence_preparing: '证据准备中',
    evidence_failed: '证据准备失败 · 可重试',
    first_pass: '待第一轮标注',
    second_pass: '待独立复核',
    adjudication: '待最终裁决',
    ready_to_freeze: '人工标签待冻结',
    labels_frozen: '人工标签已冻结',
  }[status]
}

function stageLabel(stage: VlmBlindLabelStage) {
  return { first: '第一轮', second: '复核', final: '最终裁决' }[stage]
}

function verdictLabel(verdict: VlmBlindVerdict | null) {
  if (verdict === null) return '未填写'
  return { yes: '是', no: '否', uncertain: '不确定' }[verdict]
}

function evidenceStatusLabel(status?: string) {
  if (!status) return '尚未准备'
  return {
    queued: '等待 Worker',
    running: 'Worker 处理中',
    cancel_requested: '正在取消',
    succeeded: '准备完成',
    failed: '准备失败',
    cancelled: '已取消',
  }[status]
}

function formatRatio(value: number | null | undefined) {
  return value === null || value === undefined ? '未知' : `${(value * 100).toFixed(1)}%`
}

function CandidateReviewStatus({
  candidateCase,
  error,
  isBusy,
}: {
  candidateCase: VlmBlindDataset['cases'][number]
  error?: string
  isBusy: boolean
}) {
  if (error) {
    return (
      <p
        className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-bold text-red-900"
        role="alert"
      >
        保存失败，请重试
      </p>
    )
  }
  if (isBusy) {
    return (
      <p
        aria-live="polite"
        className="rounded-full bg-blue-100 px-3 py-1.5 text-xs font-bold text-blue-900"
      >
        正在保存审核结果…
      </p>
    )
  }
  if (candidateCase.review_status === 'accepted') {
    return (
      <p
        aria-live="polite"
        className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-bold text-emerald-900"
      >
        审核结果：已接受 ·{' '}
        {groupLabel(candidateCase.reviewed_group ?? candidateCase.proposed_group)}
      </p>
    )
  }
  if (candidateCase.review_status === 'rejected') {
    return (
      <p
        aria-live="polite"
        className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-bold text-red-900"
      >
        审核结果：已拒绝 · 需要替换
      </p>
    )
  }
  return (
    <p className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-bold text-amber-900">
      审核结果：待审核
    </p>
  )
}

function ProgressStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'amber' | 'green' | 'red' | 'neutral'
}) {
  const tones = {
    amber: 'bg-amber-50 text-amber-950',
    green: 'bg-emerald-50 text-emerald-950',
    red: 'bg-red-50 text-red-950',
    neutral: 'bg-neutral-100 text-neutral-800',
  }
  return (
    <div className={`rounded-2xl p-4 ${tones[tone]}`}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums">
        {label} {value}
      </p>
    </div>
  )
}

function conditionKindLabel(kind: 'must_have' | 'optional' | 'exclusion') {
  return { must_have: '必须', optional: '可选', exclusion: '排除' }[kind]
}

function groupLabel(value: VlmBlindGroup) {
  return groups.find((group) => group.value === value)?.label ?? value
}
