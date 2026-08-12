'use client'

import { useState, type FormEvent } from 'react'
import {
  createApiClient,
  type EvaluationRun,
  type EvaluationSet,
  type EvaluationTarget,
  type EvaluationVersion,
  type LibrarySummary,
} from '../lib/api-client'
import { CandidateEvidencePanel } from './candidate-evidence-panel'
import { ShadowRerankPanel } from './shadow-rerank-panel'

/**
 * 本地评测工作台：草稿阶段选择正式图片或 video_scenes 场景目标；运行后逐条盲标。
 * 页面不接触 Qdrant，也不显示未完成标注的来源分数，防止判断被算法名次影响。
 */
export function EvaluationWorkspace({
  initialSets,
  libraries,
  apiClient = createApiClient(),
}: {
  initialSets: EvaluationSet[]
  libraries: LibrarySummary[]
  apiClient?: ReturnType<typeof createApiClient>
}) {
  const [sets, setSets] = useState(initialSets)
  const [version, setVersion] = useState<
    (EvaluationVersion & { queries: Array<{ id: string; query_text: string }> }) | null
  >(null)
  const [targets, setTargets] = useState<EvaluationTarget[]>([])
  const [targetKey, setTargetKey] = useState('')
  const [run, setRun] = useState<EvaluationRun | null>(null)
  const [runId, setRunId] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function guard(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function openVersion(id: string) {
    await guard(async () => setVersion(await apiClient.getEvaluationVersion(id)))
  }

  async function createSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('name'))
    await guard(async () => {
      const created = await apiClient.createEvaluationSet({ name })
      const latest = {
        id: created.version_id,
        set_id: created.id,
        version: 1,
        status: 'draft' as const,
        frozen_at: null,
      }
      setSets((current) => [...current, { ...created, latest_version: latest }])
      setVersion({ ...latest, queries: [] })
      form.reset()
    })
  }

  async function loadTargets() {
    await guard(async () => {
      const response = await apiClient.listEvaluationTargets({ limit: 20, seed: 'phase6-ui' })
      setTargets(response.items)
      setTargetKey(response.items[0] ? identity(response.items[0]) : '')
    })
  }

  async function addQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!version) return
    const form = event.currentTarget
    const data = new FormData(form)
    const selected = targets.find((target) => identity(target) === targetKey)
    await guard(async () => {
      await apiClient.addEvaluationQuery(version.id, {
        query_text: String(data.get('query_text')),
        query_type: selected ? 'known_target' : 'discovery',
        search_scope: String(data.get('search_scope')) as 'visual' | 'spoken' | 'all',
        intent_category: String(data.get('intent_category')),
        must_have: String(data.get('must_have'))
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        optional: [],
        exclusions: [],
        target_file_id: selected?.file_id ?? null,
        // 视频目标来自 GET /targets/random 返回的正式 video_scenes.id；图片保持 null。
        target_scene_id: selected?.scene_id ?? null,
      })
      setVersion(await apiClient.getEvaluationVersion(version.id))
      form.reset()
    })
  }

  /**
   * 使用 PostgreSQL 中不可变的运行标识恢复盲标。
   *
   * 评测候选可能需要多次会话才能标完；恢复时服务端仍隐藏来源分数与两种排序名次，
   * 页面只选择第一个尚无人工判断的候选，因此不会重复覆盖已经完成的标注。
   */
  async function restoreRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await guard(async () => setRun(await apiClient.getEvaluationRun(runId.trim())))
  }

  const requiredCandidates =
    run?.candidates.filter((candidate) => candidate.requires_judgment) ?? []
  const next = requiredCandidates.find((candidate) => !candidate.judgment)
  const judgedCount = requiredCandidates.filter((candidate) => candidate.judgment).length
  return (
    <section className="space-y-6">
      <header>
        <p className="eyebrow">内部工具</p>
        <h1 className="page-title">检索评测</h1>
        <p className="muted">候选完成盲标前隐藏来源名次和 RRF 贡献；RRF 分数不是相关概率。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="primary-action" href="/evaluation/reports">
            查看测评报告
          </a>
          <a className="secondary-action" href="/evaluation/phase9a-c2">
            进入 Phase 9A-C2 的 30 条新盲标
          </a>
        </div>
      </header>
      {error ? <p role="alert">操作失败：{error}</p> : null}
      <form className="panel flex flex-col gap-2 sm:flex-row" onSubmit={restoreRun}>
        <input
          aria-label="评测运行 ID"
          className="min-w-0 flex-1 rounded border p-2"
          placeholder="输入运行 ID，刷新页面后可继续盲标"
          required
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
        />
        <button className="secondary-action justify-center">恢复盲标</button>
      </form>
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="panel space-y-3">
          <h2 className="section-title">评测集</h2>
          {sets.map((set) => (
            <button
              key={set.id}
              className="secondary-action w-full"
              disabled={!set.latest_version}
              onClick={() => void openVersion(set.latest_version!.id)}
            >
              {set.name} · v{set.latest_version?.version}
            </button>
          ))}
          <form className="space-y-2" onSubmit={createSet}>
            <input
              name="name"
              required
              aria-label="评测集名称"
              className="w-full rounded border p-2"
            />
            <button className="primary-action w-full justify-center">创建评测集</button>
          </form>
        </aside>
        <div className="panel space-y-4">
          {!version ? (
            <p className="muted">请选择或创建评测集。</p>
          ) : (
            <>
              <h2 className="section-title">
                版本 {version.version} · {version.status}
              </h2>
              <ul>
                {version.queries.map((query) => (
                  <li key={query.id}>{query.query_text}</li>
                ))}
              </ul>
              {version.status === 'draft' ? (
                <form className="space-y-2" onSubmit={addQuery}>
                  <input
                    name="query_text"
                    required
                    placeholder="查询文本"
                    className="w-full rounded border p-2"
                  />
                  <input
                    name="intent_category"
                    required
                    placeholder="意图分类"
                    className="w-full rounded border p-2"
                  />
                  <label className="block text-sm font-medium">
                    冻结检索范围
                    <select
                      name="search_scope"
                      defaultValue="visual"
                      className="mt-1 w-full rounded border p-2"
                    >
                      <option value="visual">视觉（Phase E 可用）</option>
                      <option value="spoken">口述/语音（Phase E 不适用）</option>
                      <option value="all">混合（Phase E 不适用）</option>
                    </select>
                  </label>
                  <textarea
                    name="must_have"
                    required
                    placeholder="必须满足，每行一项"
                    className="w-full rounded border p-2"
                  />
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => void loadTargets()}
                  >
                    从正式场景选择目标
                  </button>
                  {targets.length ? (
                    <select
                      aria-label="评测目标"
                      value={targetKey}
                      onChange={(event) => setTargetKey(event.target.value)}
                      className="w-full rounded border p-2"
                    >
                      <option value="">自然发现查询（无指定目标）</option>
                      {targets.map((target) => (
                        <option key={identity(target)} value={identity(target)}>
                          {target.relative_path}
                          {target.scene_id ? ` · 场景 ${target.scene_id}` : ' · 图片'}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button className="primary-action">添加查询</button>
                </form>
              ) : null}
              {version.status === 'draft' ? (
                <button
                  className="secondary-action"
                  disabled={!version.queries.length}
                  onClick={() =>
                    void guard(async () => {
                      const frozen = await apiClient.freezeEvaluationVersion(version.id)
                      setVersion({ ...frozen, queries: version.queries })
                    })
                  }
                >
                  冻结版本
                </button>
              ) : (
                <button
                  className="primary-action"
                  onClick={() =>
                    void guard(async () =>
                      setRun(
                        await apiClient.startEvaluationRun(
                          version.id,
                          libraries.map((library) => library.id),
                        ),
                      ),
                    )
                  }
                >
                  运行评测
                </button>
              )}
            </>
          )}
          {run ? (
            <section aria-label="评测运行" className="space-y-3">
              <h2>运行状态：{run.status}</h2>
              <p className="muted">
                已标注 {judgedCount} / {requiredCandidates.length}
              </p>
              <p className="muted">
                自然发现查询只需判断两种排序各自前 20 名的合并结果。指定目标已在搜索前
                固定正确场景，系统会自动检查它是否进入前 5、10、20 名以及首次出现名次，
                无需逐条判断其他候选。
              </p>
              {run.error_message ? (
                <p role="alert">
                  {run.error_code}：{run.error_message}
                </p>
              ) : null}
              {next ? (
                <>
                  <p>请只根据媒体内容判断。</p>
                  <p className="font-medium">查询：{next.query_text}</p>
                  {next.media_type === 'image' ? (
                    <img
                      alt="待标注候选"
                      className="max-h-96 rounded object-contain"
                      src={apiClient.mediaContentUrl(next.file_id)}
                    />
                  ) : (
                    <>
                      <video
                        aria-label="待标注候选"
                        className="max-h-96 w-full rounded"
                        controls
                        src={apiClient.mediaContentUrl(next.file_id, {
                          startTimeSeconds: next.start_time_seconds,
                          endTimeSeconds: next.end_time_seconds,
                        })}
                      />
                      <CandidateEvidencePanel
                        key={next.id}
                        source={{
                          type: 'evaluation_candidate',
                          run_id: run.id,
                          candidate_id: next.id,
                        }}
                        candidateKey={next.candidate_key}
                        apiClient={apiClient}
                      />
                    </>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {[
                      [2, '高度相关'],
                      [1, '部分相关'],
                      [0, '不相关'],
                    ].map(([relevance, label]) => (
                      <button
                        key={relevance}
                        className="secondary-action"
                        onClick={() =>
                          void guard(async () =>
                            setRun(
                              await apiClient.saveEvaluationJudgment(run.id, next.id, {
                                relevance: Number(relevance),
                              }),
                            ),
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      className="secondary-action"
                      onClick={() =>
                        void guard(async () =>
                          setRun(
                            await apiClient.saveEvaluationJudgment(run.id, next.id, {
                              unjudgeable: true,
                            }),
                          ),
                        )
                      }
                    >
                      无法判断
                    </button>
                  </div>
                </>
              ) : run.status === 'ready_for_labeling' || run.status === 'labeled' ? (
                <button
                  className="primary-action"
                  onClick={() =>
                    void guard(async () => setRun(await apiClient.finalizeEvaluationRun(run.id)))
                  }
                >
                  生成报告
                </button>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
      {run ? (
        <div className="space-y-3">
          <nav aria-label="当前评测运行导航" className="flex flex-wrap gap-2">
            <a className="secondary-action" href={`/evaluation/runs/${run.id}`}>
              打开运行详情
            </a>
            <a className="secondary-action" href="/evaluation/reports">
              查看历史报告
            </a>
          </nav>
          <ShadowRerankPanel
            evaluationRunId={run.id}
            canStart={run.status === 'reported'}
            apiClient={apiClient}
          />
        </div>
      ) : null}
    </section>
  )
}

function identity(target: EvaluationTarget) {
  return `${target.file_id}:${target.scene_id ?? 'image'}`
}
