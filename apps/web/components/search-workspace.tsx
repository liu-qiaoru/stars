'use client'

import { useMemo, useState } from 'react'
import { Filter, Search } from 'lucide-react'
import type { LibrarySummary, SearchResponse, SearchResultItem } from '../lib/api-client'
import { createApiClient } from '../lib/api-client'
import {
  formatCollection,
  formatMediaType,
  formatScoreKind,
  formatTimeRange,
} from '../lib/display-labels'
import { MediaThumbnail } from './media-thumbnail'

interface SearchWorkspaceProps {
  libraries: LibrarySummary[]
  initialQuery: string
  initialResults: SearchResponse
}

const mediaFilters = ['image', 'video'] as const

export function SearchWorkspace({ libraries, initialQuery, initialResults }: SearchWorkspaceProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeMedia, setActiveMedia] = useState<(typeof mediaFilters)[number][]>([
    'image',
    'video',
  ])
  const [results, setResults] = useState(initialResults)
  const [isLoading, setIsLoading] = useState(false)
  const totalResults = useMemo(
    () => results.groups.reduce((sum, group) => sum + group.results.length, 0),
    [results.groups],
  )

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
        {results.groups.map((group) => (
          <section
            key={group.collection}
            aria-label={formatCollection(group.collection)}
            className="space-y-3"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="section-title">{formatCollection(group.collection)}</h2>
                <p className="muted">{formatScoreKind(group.score_kind)}</p>
              </div>
              <span className="result-count">{group.results.length} 条结果</span>
            </div>
            {group.results.length ? (
              <div className="masonry-grid">
                {group.results.map((item, index) => (
                  <SearchCard
                    key={`${group.collection}-${item.asset_id}`}
                    item={item}
                    index={index}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-panel">该分组暂无已索引结果。</div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

function SearchCard({ item, index }: { item: SearchResultItem; index: number }) {
  const timeRange =
    item.start_time_seconds === null || item.end_time_seconds === null
      ? null
      : formatTimeRange(item.start_time_seconds, item.end_time_seconds)
  return (
    <article className="pin-card">
      <MediaThumbnail
        index={index % 6}
        label={item.path}
        className={index % 2 === 0 ? 'aspect-[4/5]' : 'aspect-[3/4]'}
      />
      <div className="pin-overlay top-3 left-3">{formatMediaType(item.media_type)}</div>
      <div className="pin-overlay bottom-3 left-3">{item.score.toFixed(2)}</div>
      <div className="pin-meta">
        <p className="truncate font-bold">{item.path}</p>
        {timeRange ? <p className="text-xs">{timeRange}</p> : null}
      </div>
    </article>
  )
}
