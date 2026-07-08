'use client'

import { useEffect, useMemo, useState } from 'react'
import { FileAudio, Filter, Search, X } from 'lucide-react'
import type { LibrarySummary, SearchResponse, SearchResultItem } from '../lib/api-client'
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
}

const mediaFilters = ['image', 'video', 'audio'] as const

export function SearchWorkspace({ libraries, initialQuery, initialResults }: SearchWorkspaceProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeMedia, setActiveMedia] = useState<(typeof mediaFilters)[number][]>([
    'image',
    'video',
    'audio',
  ])
  const [results, setResults] = useState(initialResults)
  const [isLoading, setIsLoading] = useState(false)
  const [previewItem, setPreviewItem] = useState<SearchResultItem | null>(null)
  // 新 API 优先展示 top-level hybrid results；旧 groups 响应仍可通过 visibleResults fallback 渲染。
  const primaryResults = useMemo(() => visibleResults(results), [results])
  const totalResults = useMemo(() => primaryResults.length, [primaryResults])
  const allResultsLowConfidence =
    primaryResults.length > 0 && primaryResults.every((item) => item.confidence === 'low')

  async function submitSearch(formData: FormData) {
    const nextQuery = String(formData.get('query') ?? '').trim()
    if (!nextQuery) {
      return
    }
    setIsLoading(true)
    setQuery(nextQuery)
    try {
      const client = createApiClient()
      const response = await client.searchMedia({
        query: nextQuery,
        media_types: activeMedia,
        library_ids: [],
        limit: 20,
        offset: 0,
      })
      setResults(response)
    } catch {
      setResults(initialResults)
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
        <form action={submitSearch} className="search-shell">
          <Search aria-hidden="true" size={18} />
          <input name="query" defaultValue={query} aria-label="搜索关键词" />
          <button type="submit" className="primary-action" disabled={isLoading}>
            {isLoading ? '搜索中' : '搜索'}
          </button>
        </form>
      </section>

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
      {previewItem ? (
        <MediaPreviewDialog item={previewItem} onClose={() => setPreviewItem(null)} />
      ) : null}
    </div>
  )
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

function SearchResultPreview({
  item,
  priority,
}: {
  item: SearchResultItem
  priority: boolean
}) {
  const mediaUrl = createApiClient().mediaContentUrl(item.file_id, {
    startTimeSeconds: item.start_time_seconds,
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

function MediaPreviewDialog({
  item,
  onClose,
}: {
  item: SearchResultItem
  onClose: () => void
}) {
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
