'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileAudio, Filter, Search, SlidersHorizontal, X } from 'lucide-react'
import type {
  LibrarySummary,
  QueryExpansionMode,
  SearchResponse,
  SearchResultItem,
} from '../lib/api-client'
import { createApiClient } from '../lib/api-client'
import {
  formatCollection,
  formatConfidence,
  formatMediaType,
  formatReason,
  formatScoreKind,
  formatTimeRange,
} from '../lib/display-labels'

interface SearchWorkspaceProps {
  libraries: LibrarySummary[]
  initialQuery: string
  initialResults: SearchResponse
  apiClient?: Pick<ReturnType<typeof createApiClient>, 'searchMedia'>
}

const mediaFilters = ['image', 'video', 'audio'] as const
// 诊断缩略帧会从本地视频流按时间点加载。限制为五个不同场景，既能观察首屏召回，
// 又避免一次诊断请求让浏览器并发读取过多大视频文件。
const MAX_VISUAL_DIAGNOSTIC_FRAMES = 5
const queryExpansionOptions = [
  {
    value: 'original',
    label: '仅原查询',
    description: '仅使用您输入的原始查询进行检索。',
  },
  {
    value: 'translate',
    label: '忠实翻译',
    description: '保留原意并补充忠实翻译，不扩展概念。',
  },
  {
    value: 'expand',
    label: '完整扩展',
    description: '翻译并扩展相关概念，尽可能提升召回率。',
  },
] as const satisfies ReadonlyArray<{
  value: QueryExpansionMode
  label: string
  description: string
}>

export function SearchWorkspace({
  libraries,
  initialQuery,
  initialResults,
  apiClient = createApiClient(),
}: SearchWorkspaceProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeMedia, setActiveMedia] = useState<(typeof mediaFilters)[number][]>([
    'image',
    'video',
    'audio',
  ])
  const [results, setResults] = useState(initialResults)
  const [queryExpansionMode, setQueryExpansionMode] = useState<QueryExpansionMode>('expand')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [isSearchSettingsOpen, setIsSearchSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<SearchResultItem | null>(null)
  const searchSettingsRef = useRef<HTMLDivElement>(null)
  // 新 API 优先展示 top-level hybrid results；旧 groups 响应仍可通过 visibleResults fallback 渲染。
  const primaryResults = useMemo(() => visibleResults(results), [results])
  const totalResults = useMemo(() => primaryResults.length, [primaryResults])
  const allResultsLowConfidence =
    primaryResults.length > 0 && primaryResults.every((item) => item.confidence === 'low')

  useEffect(() => {
    if (!isSearchSettingsOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!searchSettingsRef.current?.contains(event.target as Node)) {
        setIsSearchSettingsOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsSearchSettingsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSearchSettingsOpen])

  async function submitSearch(formData: FormData) {
    const nextQuery = String(formData.get('query') ?? '').trim()
    if (!nextQuery) {
      return
    }
    setIsLoading(true)
    setSearchError(null)
    setQuery(nextQuery)
    try {
      const response = await apiClient.searchMedia({
        query: nextQuery,
        media_types: activeMedia,
        library_ids: [],
        limit: 20,
        offset: 0,
        query_expansion_mode: queryExpansionMode,
        include_diagnostics: includeDiagnostics,
      })
      setResults(response)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : '未知错误')
    } finally {
      setIsLoading(false)
    }
  }

  function toggleMedia(mediaType: (typeof mediaFilters)[number]) {
    setActiveMedia((current) =>
      current.includes(mediaType)
        ? current.filter((item) => item !== mediaType)
        : [...current, mediaType],
    )
  }

  return (
    <div className="space-y-6">
      <section className="toolbar-band">
        <div>
          <p className="eyebrow">向量检索</p>
          <h1 className="page-title">搜索本地媒体</h1>
        </div>
        <div className="search-controls" ref={searchSettingsRef}>
          <form
            className="search-shell"
            onSubmit={(event) => {
              event.preventDefault()
              void submitSearch(new FormData(event.currentTarget))
            }}
          >
            <Search aria-hidden="true" size={18} />
            <input
              name="query"
              defaultValue={query}
              aria-label="搜索关键词"
              disabled={isLoading}
            />
            <button type="submit" className="primary-action" disabled={isLoading}>
              {isLoading ? '搜索中' : '搜索'}
            </button>
          </form>
          <button
            type="button"
            className="search-settings-trigger"
            aria-label="搜索设置"
            aria-expanded={isSearchSettingsOpen}
            aria-controls="search-settings-popover"
            onClick={() => setIsSearchSettingsOpen((current) => !current)}
            disabled={isLoading}
          >
            <SlidersHorizontal aria-hidden="true" size={20} />
          </button>
          {isSearchSettingsOpen ? (
            <div
              id="search-settings-popover"
              className="search-settings-popover"
              role="dialog"
              aria-label="搜索设置"
            >
              <fieldset className="search-mode-options">
                <legend>查询方式</legend>
                {queryExpansionOptions.map((option) => (
                  <label key={option.value} className="search-mode-option">
                    <input
                      type="radio"
                      name="query-expansion-mode"
                      value={option.value}
                      checked={queryExpansionMode === option.value}
                      onChange={() => setQueryExpansionMode(option.value)}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="search-diagnostics-option">
                <span>
                  <strong>显示检索诊断</strong>
                  <small>返回查询版本、通道名次和 Caption 等排查信息。</small>
                </span>
                <span className="search-toggle">
                  <input
                    type="checkbox"
                    aria-label="显示检索诊断"
                    checked={includeDiagnostics}
                    onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
            </div>
          ) : null}
        </div>
      </section>

      {isLoading ? (
        <div className="search-progress" role="status" aria-live="polite">
          <span className="search-spinner" aria-hidden="true" />
          正在检索，请稍候…
        </div>
      ) : null}
      {searchError ? (
        <div className="search-error" role="alert">
          搜索失败：{searchError}。已保留上一次结果。
        </div>
      ) : null}

      <section className="filter-row" aria-label="搜索筛选">
        <span className="inline-flex items-center gap-2 text-sm font-bold">
          <Filter aria-hidden="true" size={16} />
          {totalResults} 条结果
        </span>
        {mediaFilters.map((mediaType) => (
          <button
            key={mediaType}
            type="button"
            className={activeMedia.includes(mediaType) ? 'filter-chip-active' : 'filter-chip'}
            onClick={() => toggleMedia(mediaType)}
            disabled={isLoading}
          >
            {formatMediaType(mediaType)}
          </button>
        ))}
        {libraries.map((library) => (
          <span key={library.id} className="filter-chip">
            {library.name}
          </span>
        ))}
      </section>

      <div className="space-y-8">
        <section aria-label="混合结果" className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <h2 className="section-title">混合结果</h2>
              <p className="muted">{formatScoreKind('hybrid_score')}</p>
            </div>
            <span className="result-count">{primaryResults.length} 条结果</span>
          </div>
          {primaryResults.length ? (
            <>
              {allResultsLowConfidence ? (
                <div className="empty-panel">未找到高相关结果，以下是弱相关候选。</div>
              ) : null}
              <div className="media-grid">
                {primaryResults.map((item, index) => (
                  <SearchCard
                    key={`${item.asset_id}-${index}`}
                    item={item}
                    index={index}
                    onPreview={setPreviewItem}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="empty-panel">暂无已索引结果。</div>
          )}
        </section>
        {results.results === undefined
          ? results.groups.map((group) => (
              <section
                key={group.collection}
                aria-label={formatCollection(group.collection)}
                className="space-y-3"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <h2 className="section-title">{formatCollection(group.collection)}</h2>
                    <p className="muted">{formatScoreKind(group.score_kind)}</p>
                  </div>
                  <span className="result-count">{group.results.length} 条结果</span>
                </div>
                {group.results.length ? (
                  <div className="media-grid">
                    {group.results.map((item, index) => (
                      <SearchCard
                        key={`${group.collection}-${item.asset_id}`}
                        item={item}
                        index={index}
                        onPreview={setPreviewItem}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-panel">该分组暂无已索引结果。</div>
                )}
              </section>
            ))
          : null}
      </div>
      {results.query_diagnostics ? (
        <SearchDiagnosticsPanel results={results} onPreview={setPreviewItem} />
      ) : null}
      {previewItem ? (
        <MediaPreviewDialog item={previewItem} onClose={() => setPreviewItem(null)} />
      ) : null}
    </div>
  )
}

function SearchDiagnosticsPanel({
  results,
  onPreview,
}: {
  results: SearchResponse
  onPreview: (item: SearchResultItem) => void
}) {
  const diagnostics = results.query_diagnostics
  if (!diagnostics) {
    return null
  }
  const visualFrameDiagnostics = bestVisualFramesByScene(results)
  const sourceResults = results.groups.flatMap((group) =>
    group.results.flatMap((item) =>
      item.diagnostics ? [{ collection: group.collection, item }] : [],
    ),
  )
  return (
    <section aria-label="检索诊断" className="space-y-3 rounded-lg border bg-slate-50 p-4">
      <div>
        <h2 className="section-title">检索诊断</h2>
        <p className="muted">
          当前模式：{formatQueryExpansionMode(diagnostics.query_expansion_mode)}。Caption
          原文只在本次显式开启诊断时返回。
        </p>
      </div>
      <div className="space-y-1 text-sm">
        <p className="font-medium">实际查询版本</p>
        <ol className="list-decimal space-y-1 pl-5">
          {diagnostics.query_variants.map((variant) => (
            <li key={`${variant.source}-${variant.text}`}>
              {variant.text} · 权重 {variant.weight.toFixed(2)} · {variant.source}
            </li>
          ))}
        </ol>
      </div>
      {visualFrameDiagnostics.frames.length || visualFrameDiagnostics.incompleteCount ? (
        <section aria-label="视觉通道最佳命中帧" className="diagnostic-visual-section">
          <div className="diagnostic-visual-heading">
            <div>
              <h3>视觉通道最佳命中帧</h3>
              <p>每个场景只保留分数最高的帧，排名仍是原始帧通道名次。</p>
            </div>
            <span>{visualFrameDiagnostics.frames.length} 个场景</span>
          </div>
          {visualFrameDiagnostics.incompleteCount ? (
            <p className="diagnostic-frame-warning" role="status">
              {visualFrameDiagnostics.incompleteCount} 条视觉帧缺少 scene_id、准确时间或诊断信息，已跳过。
            </p>
          ) : null}
          {visualFrameDiagnostics.frames.length ? (
            <div className="diagnostic-frame-grid">
              {visualFrameDiagnostics.frames.map((item) => (
                <VisualDiagnosticFrame
                  key={`${item.file_id}-${item.scene_id}`}
                  item={item}
                  onPreview={onPreview}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="space-y-2">
        {sourceResults.map(({ collection, item }) => (
          <details
            key={`${collection}-${item.asset_id}`}
            className="rounded border bg-white p-3 text-sm"
          >
            <summary className="cursor-pointer font-medium">
              {formatCollection(collection)} #{item.diagnostics!.source_rank} ·{' '}
              {item.scene_id ?? item.asset_id} · {item.score.toFixed(4)}
            </summary>
            {item.diagnostics!.caption ? (
              <div className="mt-3 space-y-1">
                <p>{item.diagnostics!.caption.text}</p>
                <p className="muted">
                  {item.diagnostics!.caption.prompt_version ?? 'Prompt 版本缺失'}
                </p>
              </div>
            ) : null}
            <ul className="mt-3 space-y-1">
              {item.diagnostics!.query_variant_hits.map((hit) => (
                <li key={`${hit.source}-${hit.text}`}>
                  {hit.text} · 原始 {hit.raw_score.toFixed(4)} · 权重 {hit.weight.toFixed(2)} ·{' '}
                  {hit.winning ? '胜出 · ' : ''}加权 {hit.weighted_score.toFixed(4)}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  )
}

/**
 * 从原始视频帧通道中选出每个场景的最高分帧。
 * Server 已按加权后的通道分数降序返回 group，因此第一次遇到某个 scene_id 时，
 * 该帧就是当前召回深度内的 MaxSim（最大相似度）代表帧，无需在 Web 端重新算分。
 */
function bestVisualFramesByScene(results: SearchResponse): {
  frames: SearchResultItem[]
  incompleteCount: number
} {
  const visualResults =
    results.groups.find((group) => group.collection === 'video_frame_vectors')?.results ?? []
  const seenScenes = new Set<string>()
  const selected: SearchResultItem[] = []
  let incompleteCount = 0

  for (const item of visualResults) {
    if (item.media_type !== 'video') {
      continue
    }
    // 缺少 scene_id、诊断名次或准确帧时间时，无法证明这是哪个场景的 MaxSim 代表帧。
    // 这些数据会在页面上计数提示，避免静默把 asset_id 冒充场景并掩盖索引完整性问题。
    if (!item.scene_id || item.start_time_seconds === null || !item.diagnostics) {
      incompleteCount += 1
      continue
    }
    const sceneKey = `${item.file_id}:${item.scene_id}`
    if (seenScenes.has(sceneKey)) {
      continue
    }
    seenScenes.add(sceneKey)
    if (selected.length < MAX_VISUAL_DIAGNOSTIC_FRAMES) {
      selected.push(item)
    }
  }

  return { frames: selected, incompleteCount }
}

function VisualDiagnosticFrame({
  item,
  onPreview,
}: {
  item: SearchResultItem
  onPreview: (item: SearchResultItem) => void
}) {
  const frameTime = item.start_time_seconds ?? 0
  const sceneLabel = item.scene_id ?? item.asset_id
  const winningVariant = item.diagnostics?.query_variant_hits.find((hit) => hit.winning)
  const mediaUrl = createApiClient().mediaContentUrl(item.file_id, {
    startTimeSeconds: frameTime,
  })

  return (
    <button
      type="button"
      className="diagnostic-frame-card"
      aria-label={`预览视觉命中帧 ${sceneLabel}`}
      // 原始 frame result 的 start/end 相同。弹窗只传开始时间，避免生成零时长媒体片段。
      onClick={() => onPreview({ ...item, end_time_seconds: null })}
    >
      <video
        aria-label={`${sceneLabel} 在 ${frameTime.toFixed(2)} 秒的命中帧`}
        className="diagnostic-frame-media"
        muted
        playsInline
        preload="metadata"
        src={mediaUrl}
      />
      <span className="diagnostic-frame-body">
        <span className="diagnostic-frame-meta">
          <strong>帧排名 #{item.diagnostics?.source_rank}</strong>
          <span>{formatFrameTimestamp(frameTime)}</span>
        </span>
        <span className="diagnostic-frame-scene" title={sceneLabel}>
          {sceneLabel}
        </span>
        <span className="diagnostic-frame-score">
          <span>原始余弦</span>
          <strong>{winningVariant ? winningVariant.raw_score.toFixed(4) : '—'}</strong>
        </span>
        <span className="diagnostic-frame-weighted">查询加权分 {item.score.toFixed(4)}</span>
        <span className="diagnostic-frame-query" title={winningVariant?.text}>
          {winningVariant?.text ?? '没有胜出的查询版本'}
        </span>
      </span>
    </button>
  )
}

function formatFrameTimestamp(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds)
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = (safeSeconds % 60).toFixed(2).padStart(5, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`
}

function formatQueryExpansionMode(mode: QueryExpansionMode) {
  return queryExpansionOptions.find((option) => option.value === mode)?.label ?? mode
}

function visibleResults(results: SearchResponse): SearchResultItem[] {
  // 兼容 Phase 13 旧响应：没有 results 时 flatten groups，避免旧后端让 Search 页空白。
  if (results.results) {
    return results.results
  }
  return results.groups.flatMap((group) => group.results)
}

function SearchCard({
  item,
  index,
  onPreview,
}: {
  item: SearchResultItem
  index: number
  onPreview: (item: SearchResultItem) => void
}) {
  const timeRange =
    item.start_time_seconds === null || item.end_time_seconds === null
      ? null
      : formatTimeRange(item.start_time_seconds, item.end_time_seconds)
  const reason = item.primary_reason ?? item.reason
  return (
    <button
      type="button"
      aria-label={`预览 ${item.path}`}
      className="media-result-card"
      onClick={() => onPreview(item)}
    >
      <SearchResultPreview item={item} priority={index < 6} />
      <div className="media-result-body">
        <div className="media-meta-row">
          <span className="meta-chip">{formatMediaType(item.media_type)}</span>
          <span className="meta-chip">{item.score.toFixed(2)}</span>
          {reason ? <span className="meta-chip">{formatReason(reason)}</span> : null}
          {item.confidence === 'low' ? (
            <span className="meta-chip">{formatConfidence(item.confidence)}</span>
          ) : null}
        </div>
        <div>
          <p className="card-title truncate">{item.path}</p>
          {timeRange ? <p className="muted mt-1">{timeRange}</p> : null}
        </div>
      </div>
    </button>
  )
}

function SearchResultPreview({ item, priority }: { item: SearchResultItem; priority: boolean }) {
  const mediaUrl = createApiClient().mediaContentUrl(item.file_id, {
    startTimeSeconds: item.start_time_seconds,
    endTimeSeconds: item.end_time_seconds,
  })

  if (item.media_type === 'image') {
    return (
      <img
        alt={item.path}
        className="media-thumb media-preview-media aspect-[16/10]"
        loading={priority ? 'eager' : 'lazy'}
        src={mediaUrl}
      />
    )
  }

  if (item.media_type === 'video') {
    return (
      <video
        aria-label={item.path}
        className="media-thumb media-preview-media aspect-[16/10]"
        muted
        playsInline
        preload="metadata"
        src={mediaUrl}
      />
    )
  }

  if (item.media_type === 'audio') {
    return (
      <div aria-label={item.path} className="media-thumb media-audio-thumb aspect-[16/10]">
        <FileAudio aria-hidden="true" size={42} />
      </div>
    )
  }

  return <div aria-label={item.path} className="media-thumb aspect-[16/10]" />
}

function MediaPreviewDialog({ item, onClose }: { item: SearchResultItem; onClose: () => void }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const mediaUrl = createApiClient().mediaContentUrl(item.file_id, {
    startTimeSeconds: item.start_time_seconds,
    endTimeSeconds: item.end_time_seconds,
  })
  const timeRange =
    item.start_time_seconds === null || item.end_time_seconds === null
      ? null
      : formatTimeRange(item.start_time_seconds, item.end_time_seconds)
  const reason = item.primary_reason ?? item.reason

  return (
    <div className="media-preview-backdrop" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${item.path}`}
        className="media-preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="media-preview-header">
          <div className="min-w-0">
            <div className="media-meta-row">
              <span className="meta-chip">{formatMediaType(item.media_type)}</span>
              <span className="meta-chip">{item.score.toFixed(2)}</span>
              {reason ? <span className="meta-chip">{formatReason(reason)}</span> : null}
              {item.confidence === 'low' ? (
                <span className="meta-chip">{formatConfidence(item.confidence)}</span>
              ) : null}
              {timeRange ? <span className="meta-chip">{timeRange}</span> : null}
            </div>
            <p className="card-title media-preview-title">{item.path}</p>
          </div>
          <button type="button" className="icon-action" aria-label="关闭预览" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="media-preview-stage">{renderPreviewContent(item, mediaUrl)}</div>
      </div>
    </div>
  )
}

function renderPreviewContent(item: SearchResultItem, mediaUrl: string) {
  if (item.media_type === 'image') {
    return <img alt={item.path} className="media-preview-full" src={mediaUrl} />
  }

  if (item.media_type === 'video') {
    return (
      <video
        aria-label={item.path}
        className="media-preview-full"
        controls
        playsInline
        preload="metadata"
        src={mediaUrl}
      />
    )
  }

  if (item.media_type === 'audio') {
    return (
      <div className="media-preview-audio">
        <FileAudio aria-hidden="true" size={56} />
        <audio aria-label={item.path} controls src={mediaUrl} />
      </div>
    )
  }

  return <div aria-label={item.path} className="media-preview-empty" />
}
