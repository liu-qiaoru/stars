'use client'

import { useState, type FormEvent } from 'react'
import {
  createApiClient,
  type EvaluationRun,
  type EvaluationRandomTarget,
  type EvaluationSetSummary,
  type EvaluationVersionSummary,
  type LibraryMediaItem,
  type LibrarySummary,
  type MediaDetail,
} from '../lib/api-client'

export function EvaluationWorkspace({
  initialSets,
  libraries,
}: {
  initialSets: EvaluationSetSummary[]
  libraries: LibrarySummary[]
}) {
  const client = createApiClient()
  const [sets, setSets] = useState(initialSets)
  const [selected, setSelected] = useState<
    (EvaluationVersionSummary & { queries: Array<{ id: string; query_text: string }> }) | null
  >(null)
  const [run, setRun] = useState<EvaluationRun | null>(null)
  const [runs, setRuns] = useState<Array<{ id: string; status: string; created_at: string }>>([])
  const [queryType, setQueryType] = useState<'discovery' | 'known_target'>('discovery')
  const [pickerLibraryId, setPickerLibraryId] = useState(libraries[0]?.id ?? '')
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerItems, setPickerItems] = useState<LibraryMediaItem[]>([])
  const [selectedMedia, setSelectedMedia] = useState<MediaDetail | null>(null)
  const [selectedTarget, setSelectedTarget] = useState<{
    fileId: string
    sceneId: string | null
    label: string
  } | null>(null)
  const [randomTargets, setRandomTargets] = useState<EvaluationRandomTarget[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function guard(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function openVersion(id: string) {
    await guard(async () => {
      const [version, history] = await Promise.all([
        client.getEvaluationVersion(id),
        client.listEvaluationRuns(id),
      ])
      setSelected(version)
      setRuns(history.items)
    })
  }

  async function createSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    await guard(async () => {
      const created = await client.createEvaluationSet({ name: String(data.get('name')) })
      const latest = {
        id: created.version_id,
        set_id: created.id,
        version: 1,
        status: 'draft' as const,
        frozen_at: null,
      }
      setSets((items) => [...items, { ...created, latest_version: latest }])
      await openVersion(created.version_id)
      form.reset()
    })
  }

  async function addQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const data = new FormData(form)
    if (queryType === 'known_target' && !selectedTarget) {
      setError('请先选择目标图片或视频场景')
      return
    }
    await guard(async () => {
      await client.addEvaluationQuery(selected.id, {
        query_text: String(data.get('query_text')),
        query_type: queryType,
        intent_category: String(data.get('intent_category')),
        must_have: String(data.get('must_have'))
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        optional: String(data.get('optional'))
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        exclusions: String(data.get('exclusions'))
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        target_file_id: queryType === 'known_target' ? selectedTarget!.fileId : null,
        target_scene_id: queryType === 'known_target' ? selectedTarget!.sceneId : null,
      })
      setSelected(await client.getEvaluationVersion(selected.id))
      form.reset()
      setSelectedMedia(null)
      setSelectedTarget(null)
    })
  }

  async function searchPicker() {
    if (!pickerLibraryId) return
    await guard(async () => {
      const response = await client.listLibraryMedia(pickerLibraryId, {
        limit: 50,
        offset: 0,
        query: pickerQuery.trim() || undefined,
      })
      setPickerItems(
        response.items.filter((item) => item.media_type === 'image' || item.media_type === 'video'),
      )
      setSelectedMedia(null)
      setSelectedTarget(null)
    })
  }

  async function chooseMedia(item: LibraryMediaItem) {
    await guard(async () => {
      if (item.media_type === 'image') {
        setSelectedMedia(null)
        setSelectedTarget({ fileId: item.id, sceneId: null, label: item.relative_path })
        return
      }
      setSelectedTarget(null)
      setSelectedMedia(await client.getMedia(item.id))
    })
  }

  async function loadRandomTargets() {
    await guard(async () => {
      const result = await client.listRandomEvaluationTargets({
        libraryId: pickerLibraryId || undefined,
        limit: 20,
        seed: crypto.randomUUID(),
      })
      setRandomTargets(result.items)
      setSelectedMedia(null)
      setSelectedTarget(null)
    })
  }

  const selectableScenes = (selectedMedia?.assets ?? []).flatMap((asset) => {
    const sceneId = asset.metadata_json?.scene_id
    return asset.asset_type === 'video_segment' && typeof sceneId === 'string'
      ? [{ ...asset, sceneId }]
      : []
  })

  const nextCandidate = run?.candidates.find((candidate) => !candidate.judgment)
  async function exportRun() {
    if (!run) return
    await guard(async () => {
      const payload = await client.exportEvaluationRun(run.id)
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `evaluation-${run.id}.json`
      link.click()
      URL.revokeObjectURL(url)
    })
  }
  return (
    <section className="space-y-6">
      <header>
        <p className="text-sm text-[var(--muted)]">内部工具</p>
        <h1 className="text-2xl font-semibold">检索评测</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          盲标阶段隐藏来源、分数和 Caption；RRF 分数仅用于排序，不表示相关概率。
        </p>
      </header>
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3 rounded-xl border border-[var(--hairline)] bg-white p-4">
          <h2 className="font-medium">评测集</h2>
          {sets.map((set) => (
            <button
              className="block w-full rounded-lg border p-3 text-left text-sm"
              key={set.id}
              disabled={!set.latest_version || busy}
              onClick={() => void openVersion(set.latest_version!.id)}
            >
              {set.name}
              <span className="block text-xs text-[var(--muted)]">
                v{set.latest_version?.version} · {set.latest_version?.status}
              </span>
            </button>
          ))}
          <form onSubmit={createSet} className="space-y-2">
            <input
              name="name"
              required
              placeholder="新评测集名称"
              className="w-full rounded-lg border p-2 text-sm"
            />
            <button disabled={busy} className="primary-action w-full justify-center">
              创建
            </button>
          </form>
        </aside>
        <div className="space-y-5">
          {!selected ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-[var(--muted)]">
              选择或创建评测集
            </div>
          ) : (
            <>
              <section className="rounded-xl border border-[var(--hairline)] bg-white p-5">
                <div className="flex items-center justify-between">
                  <h2 className="font-medium">查询 v{selected.version}</h2>
                  <span className="text-sm">{selected.status}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {selected.queries.map((query) => (
                    <li key={query.id} className="rounded border p-2 text-sm">
                      {query.query_text}
                    </li>
                  ))}
                </ul>
                {selected.status === 'draft' ? (
                  <form onSubmit={addQuery} className="mt-4 grid gap-2">
                    <input
                      name="query_text"
                      required
                      placeholder="查询文本"
                      className="rounded border p-2"
                    />
                    <select
                      aria-label="查询类型"
                      value={queryType}
                      onChange={(event) => setQueryType(event.target.value as typeof queryType)}
                      className="rounded border p-2"
                    >
                      <option value="discovery">自然发现</option>
                      <option value="known_target">指定目标</option>
                    </select>
                    <input
                      name="intent_category"
                      required
                      placeholder="意图分类，如：物体"
                      className="rounded border p-2"
                    />
                    {queryType === 'known_target' ? (
                      <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                        <p className="text-sm font-medium">选择目标媒体</p>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm text-[var(--muted)]">
                            随机抽取已索引的图片和视频场景，选择后再描述查询。
                          </p>
                          <button
                            type="button"
                            className="rounded border bg-white px-3 py-2 text-sm"
                            onClick={() => void loadRandomTargets()}
                          >
                            {randomTargets.length ? '换一批' : '随机抽取 20 个'}
                          </button>
                        </div>
                        {randomTargets.length ? (
                          <div className="grid max-h-[36rem] gap-3 overflow-auto sm:grid-cols-2">
                            {randomTargets.map((target) => {
                              const sceneLabel =
                                target.media_type === 'video'
                                  ? `${formatTime(target.start_time_seconds)}–${formatTime(target.end_time_seconds)}`
                                  : null
                              return (
                                <div
                                  key={target.target_key}
                                  className="overflow-hidden rounded border bg-white"
                                >
                                  {target.media_type === 'image' ? (
                                    <img
                                      alt={target.relative_path}
                                      className="h-40 w-full bg-slate-100 object-contain"
                                      src={client.mediaContentUrl(target.file_id)}
                                    />
                                  ) : (
                                    <video
                                      aria-label={`随机场景预览 ${sceneLabel}`}
                                      className="h-40 w-full bg-black object-contain"
                                      controls
                                      preload="metadata"
                                      src={client.mediaContentUrl(target.file_id, {
                                        startTimeSeconds: target.start_time_seconds,
                                        endTimeSeconds: target.end_time_seconds,
                                      })}
                                    />
                                  )}
                                  <div className="space-y-2 p-3">
                                    <p className="truncate text-sm">{target.relative_path}</p>
                                    {sceneLabel ? (
                                      <p className="text-xs text-[var(--muted)]">{sceneLabel}</p>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="w-full rounded border px-3 py-2 text-sm"
                                      onClick={() =>
                                        setSelectedTarget({
                                          fileId: target.file_id,
                                          sceneId: target.scene_id,
                                          label: `${target.relative_path}${sceneLabel ? ` · ${sceneLabel}` : ''}`,
                                        })
                                      }
                                    >
                                      选择此目标
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                        <details>
                          <summary className="cursor-pointer text-sm">按文件名查找目标</summary>
                          <div className="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
                            <select
                              aria-label="目标素材库"
                              value={pickerLibraryId}
                              onChange={(event) => setPickerLibraryId(event.target.value)}
                              className="rounded border p-2"
                            >
                              {libraries.map((library) => (
                                <option key={library.id} value={library.id}>
                                  {library.name}
                                </option>
                              ))}
                            </select>
                            <input
                              value={pickerQuery}
                              onChange={(event) => setPickerQuery(event.target.value)}
                              placeholder="按文件名或路径筛选"
                              className="rounded border p-2"
                            />
                            <button
                              type="button"
                              className="rounded border bg-white px-3"
                              onClick={() => void searchPicker()}
                            >
                              查找媒体
                            </button>
                          </div>
                          <div className="grid max-h-80 gap-2 overflow-auto sm:grid-cols-2">
                            {pickerItems.map((item) => (
                              <button
                                type="button"
                                key={item.id}
                                className="overflow-hidden rounded border bg-white text-left text-sm"
                                onClick={() => void chooseMedia(item)}
                              >
                                {item.media_type === 'image' ? (
                                  <img
                                    alt={item.relative_path}
                                    className="h-28 w-full bg-slate-100 object-contain"
                                    src={client.mediaContentUrl(item.id)}
                                  />
                                ) : (
                                  <video
                                    aria-label={`${item.relative_path} 视频预览`}
                                    className="h-28 w-full bg-black object-contain"
                                    muted
                                    preload="metadata"
                                    src={client.mediaContentUrl(item.id)}
                                  />
                                )}
                                <span className="block truncate p-2">{item.relative_path}</span>
                              </button>
                            ))}
                          </div>
                          {selectedMedia ? (
                            <div className="space-y-2">
                              <p className="text-sm">请选择视频场景：</p>
                              {selectableScenes.length ? (
                                selectableScenes.map((scene) => {
                                  const label = `${formatTime(scene.start_time_seconds)}–${formatTime(scene.end_time_seconds)}`
                                  return (
                                    <div
                                      key={scene.sceneId}
                                      className="overflow-hidden rounded border bg-white"
                                    >
                                      <video
                                        aria-label={`场景预览 ${label}`}
                                        className="max-h-64 w-full bg-black"
                                        controls
                                        preload="metadata"
                                        src={client.mediaContentUrl(selectedMedia.id, {
                                          startTimeSeconds: scene.start_time_seconds,
                                          endTimeSeconds: scene.end_time_seconds,
                                        })}
                                      />
                                      <div className="flex items-center justify-between gap-3 p-3">
                                        <span className="text-sm">{label}</span>
                                        <button
                                          type="button"
                                          className="rounded border px-3 py-2 text-sm"
                                          onClick={() =>
                                            setSelectedTarget({
                                              fileId: selectedMedia.id,
                                              sceneId: scene.sceneId,
                                              label: `${selectedMedia.path} · ${label}`,
                                            })
                                          }
                                        >
                                          选择此场景
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })
                              ) : (
                                <p className="text-sm text-amber-700">
                                  该视频没有可选择的稳定 scene_id。
                                </p>
                              )}
                            </div>
                          ) : null}
                        </details>
                        {selectedTarget ? (
                          <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">
                            已选择：{selectedTarget.label}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <textarea
                      name="must_have"
                      required
                      placeholder="必须满足，每行一项"
                      className="rounded border p-2"
                    />
                    <textarea
                      name="optional"
                      placeholder="加分条件，每行一项"
                      className="rounded border p-2"
                    />
                    <textarea
                      name="exclusions"
                      placeholder="明确排除，每行一项"
                      className="rounded border p-2"
                    />
                    <button
                      disabled={busy || (queryType === 'known_target' && !selectedTarget)}
                      className="primary-action justify-center"
                    >
                      添加查询
                    </button>
                  </form>
                ) : null}
                <div className="mt-4 flex gap-2">
                  {selected.status === 'draft' ? (
                    <button
                      disabled={busy || !selected.queries.length}
                      className="primary-action"
                      onClick={() =>
                        void guard(async () =>
                          setSelected({
                            ...(await client.freezeEvaluationVersion(selected.id)),
                            queries: selected.queries,
                          }),
                        )
                      }
                    >
                      冻结版本
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      className="primary-action"
                      onClick={() =>
                        void guard(async () =>
                          setRun(
                            await client.startEvaluationRun(
                              selected.id,
                              libraries.map((library) => library.id),
                            ),
                          ),
                        )
                      }
                    >
                      运行基线评测
                    </button>
                  )}
                </div>
                {runs.length ? (
                  <div className="mt-4">
                    <h3 className="text-sm font-medium">历史运行</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {runs.map((item) => (
                        <button
                          key={item.id}
                          className="rounded border px-2 py-1 text-xs"
                          onClick={() =>
                            void guard(async () => setRun(await client.getEvaluationRun(item.id)))
                          }
                        >
                          {item.status} · {new Date(item.created_at).toLocaleString()}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
              {run ? (
                <section className="rounded-xl border border-[var(--hairline)] bg-white p-5">
                  <h2 className="font-medium">运行 {run.status}</h2>
                  {run.error_message ? (
                    <p className="text-red-700">
                      {run.error_stage}: {run.error_message}
                    </p>
                  ) : null}
                  {nextCandidate ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-sm">请只根据媒体内容判断，来源证据将在标注后显示。</p>
                      {nextCandidate.media_type === 'image' ? (
                        <img
                          alt="待标注候选"
                          className="max-h-96 rounded-lg object-contain"
                          src={client.mediaContentUrl(nextCandidate.file_id)}
                        />
                      ) : (
                        <video
                          className="max-h-96 w-full rounded-lg"
                          controls
                          src={client.mediaContentUrl(nextCandidate.file_id, {
                            startTimeSeconds: nextCandidate.start_time_seconds,
                            endTimeSeconds: nextCandidate.end_time_seconds,
                          })}
                        />
                      )}
                      <div className="flex flex-wrap gap-2">
                        {[
                          [2, '高度相关'],
                          [1, '部分相关'],
                          [0, '不相关'],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            disabled={busy}
                            className="rounded-lg border px-3 py-2"
                            onClick={() =>
                              void guard(async () =>
                                setRun(
                                  await client.saveEvaluationJudgment(run.id, nextCandidate.id, {
                                    relevance: Number(value),
                                  }),
                                ),
                              )
                            }
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          disabled={busy}
                          className="rounded-lg border px-3 py-2"
                          onClick={() =>
                            void guard(async () =>
                              setRun(
                                await client.saveEvaluationJudgment(run.id, nextCandidate.id, {
                                  unjudgeable: true,
                                }),
                              ),
                            )
                          }
                        >
                          无法判断
                        </button>
                      </div>
                    </div>
                  ) : run.status !== 'reported' ? (
                    <button
                      disabled={busy}
                      className="primary-action mt-4"
                      onClick={() =>
                        void guard(async () => setRun(await client.finalizeEvaluationRun(run.id)))
                      }
                    >
                      生成报告
                    </button>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <button
                        className="rounded-lg border px-3 py-2 text-sm"
                        onClick={() => void exportRun()}
                      >
                        导出 JSON
                      </button>
                      <pre className="overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-white">
                        {JSON.stringify(run.report, null, 2)}
                      </pre>
                      {run.candidates.map((candidate) => (
                        <details key={candidate.id} className="rounded border p-3 text-sm">
                          <summary>
                            {candidate.candidate_key} · current #{candidate.current_rank} · RRF #
                            {candidate.rrf_rank}
                          </summary>
                          <pre className="mt-2 overflow-auto text-xs">
                            {JSON.stringify(candidate.source_evidence, null, 2)}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function formatTime(value: number | null) {
  if (value === null) return '--:--'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
