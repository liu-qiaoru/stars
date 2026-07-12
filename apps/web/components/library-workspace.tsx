'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  File,
  FolderPlus,
  ImageIcon,
  Plus,
  RefreshCw,
  Video,
  X,
} from 'lucide-react'
import { useState } from 'react'
import type { LibraryMediaItem, LibrarySummary } from '../lib/api-client'
import { createApiClient } from '../lib/api-client'
import { formatStatus } from '../lib/display-labels'

const FILE_PAGE_SIZE = 25

interface LibraryFileState {
  items: LibraryMediaItem[]
  total: number
  loading: boolean
  error: string | null
}

type LibraryApiClient = Pick<
  ReturnType<typeof createApiClient>,
  'createLibrary' | 'scanLibrary' | 'listLibraryMedia'
>

export function LibraryWorkspace({
  libraries,
  apiClient = createApiClient(),
}: {
  libraries: LibrarySummary[]
  apiClient?: LibraryApiClient
}) {
  const router = useRouter()
  const [expandedLibraries, setExpandedLibraries] = useState<Record<string, boolean>>({})
  const [filesByLibrary, setFilesByLibrary] = useState<Record<string, LibraryFileState>>({})
  const [scanningLibraryId, setScanningLibraryId] = useState<string | null>(null)
  const [scanErrors, setScanErrors] = useState<Record<string, string | null>>({})
  const [showCreateForm, setShowCreateForm] = useState(false)

  const totals = libraries.reduce(
    (summary, library) => ({
      media: summary.media + (library.media_count ?? 0),
      indexed: summary.indexed + (library.indexed_count ?? 0),
      failed: summary.failed + (library.failed_count ?? 0),
    }),
    { media: 0, indexed: 0, failed: 0 },
  )

  async function createLibrary(formData: FormData) {
    // 注册 library 只保存本地根路径；真实扫描要用户点击“扫描”后创建 scan_library job。
    const name = String(formData.get('name') ?? '').trim()
    const rootPath = String(formData.get('root_path') ?? '').trim()
    if (!name || !rootPath) {
      return
    }
    await apiClient.createLibrary({ name, root_path: rootPath })
  }

  async function loadLibraryFiles(libraryId: string, offset: number) {
    setFilesByLibrary((current) => ({
      ...current,
      [libraryId]: {
        items: current[libraryId]?.items ?? [],
        total: current[libraryId]?.total ?? 0,
        loading: true,
        error: null,
      },
    }))
    try {
      const response = await apiClient.listLibraryMedia(libraryId, {
        limit: FILE_PAGE_SIZE,
        offset,
      })
      setFilesByLibrary((current) => ({
        ...current,
        [libraryId]: {
          items:
            offset === 0
              ? response.items
              : mergeFiles(current[libraryId]?.items ?? [], response.items),
          total: response.total,
          loading: false,
          error: null,
        },
      }))
    } catch (error) {
      setFilesByLibrary((current) => ({
        ...current,
        [libraryId]: {
          items: current[libraryId]?.items ?? [],
          total: current[libraryId]?.total ?? 0,
          loading: false,
          error: error instanceof Error ? error.message : '未知错误',
        },
      }))
    }
  }

  function toggleLibraryFiles(libraryId: string) {
    const willExpand = !expandedLibraries[libraryId]
    setExpandedLibraries((current) => ({ ...current, [libraryId]: willExpand }))
    if (willExpand && filesByLibrary[libraryId] === undefined) {
      void loadLibraryFiles(libraryId, 0)
    }
  }

  async function scanLibrary(libraryId: string) {
    setScanningLibraryId(libraryId)
    setScanErrors((current) => ({ ...current, [libraryId]: null }))
    try {
      await apiClient.scanLibrary(libraryId)
      router.push('/jobs')
    } catch (error) {
      setScanErrors((current) => ({
        ...current,
        [libraryId]: error instanceof Error ? error.message : '未知错误',
      }))
    } finally {
      setScanningLibraryId(null)
    }
  }

  return (
    <div className="library-page">
      <header className="library-page-header">
        <div>
          <h1 className="page-title">素材库</h1>
          <p className="muted">集中管理本地媒体库，查看内容与索引状态。</p>
        </div>
        <button
          className="primary-action"
          type="button"
          aria-expanded={showCreateForm}
          aria-controls="create-library-form"
          onClick={() => setShowCreateForm((current) => !current)}
        >
          {showCreateForm ? <X aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
          {showCreateForm ? '取消添加' : '添加素材库'}
        </button>
      </header>

      {showCreateForm ? (
        <form id="create-library-form" action={createLibrary} className="library-create-form">
          <label className="field-label">
            名称
            <input name="name" className="text-input" placeholder="主媒体库" />
          </label>
          <label className="field-label">
            根路径
            <input name="root_path" className="text-input" placeholder="/本地媒体" />
          </label>
          <button className="primary-action library-create-submit" type="submit">
            <FolderPlus aria-hidden="true" size={16} />
            确认添加
          </button>
        </form>
      ) : null}

      <div className="library-overview" aria-label="素材库汇总">
        <span>共 {libraries.length} 个素材库</span>
        <span>{totals.media} 个媒体</span>
        <span>{totals.indexed} 个已索引</span>
        <span>{totals.failed} 个失败</span>
      </div>

      <section className="library-directory" aria-label="素材库列表">
        <div className="list-stack">
          {libraries.map((library) => (
            <article key={library.id} className="library-card">
              <div className="library-summary-grid">
                <button
                  className="library-expand-trigger"
                  type="button"
                  aria-label={
                    expandedLibraries[library.id]
                      ? '收起文件'
                      : `查看文件 ${library.media_count ?? 0}`
                  }
                  aria-expanded={expandedLibraries[library.id] ?? false}
                  aria-controls={`library-files-${library.id}`}
                  onClick={() => toggleLibraryFiles(library.id)}
                >
                  {expandedLibraries[library.id] ? (
                    <ChevronDown aria-hidden="true" size={18} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={18} />
                  )}
                </button>
                <div className="library-identity">
                  <h2 className="card-title">{library.name}</h2>
                  <p className="muted">{library.root_path}</p>
                </div>
                <div className="metric-strip">
                  <Metric label="媒体" value={library.media_count ?? 0} />
                  <Metric label="已索引" value={library.indexed_count ?? 0} />
                  <Metric label="失败" value={library.failed_count ?? 0} />
                </div>
                <div className="library-actions">
                  <button
                    className="library-scan-action"
                    type="button"
                    disabled={scanningLibraryId === library.id}
                    onClick={() => void scanLibrary(library.id)}
                  >
                    <RefreshCw aria-hidden="true" size={16} />
                    {scanningLibraryId === library.id ? '正在创建任务' : '扫描'}
                  </button>
                </div>
              </div>
              {scanErrors[library.id] ? (
                <p className="inline-error" role="alert">
                  创建扫描任务失败：{scanErrors[library.id]}
                </p>
              ) : null}
              {expandedLibraries[library.id] ? (
                <LibraryFileList
                  id={`library-files-${library.id}`}
                  state={filesByLibrary[library.id]}
                  onLoadMore={() =>
                    void loadLibraryFiles(library.id, filesByLibrary[library.id]?.items.length ?? 0)
                  }
                  onRetry={() =>
                    void loadLibraryFiles(library.id, filesByLibrary[library.id]?.items.length ?? 0)
                  }
                />
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function LibraryFileList({
  id,
  state,
  onLoadMore,
  onRetry,
}: {
  id: string
  state: LibraryFileState | undefined
  onLoadMore: () => void
  onRetry: () => void
}) {
  const items = state?.items ?? []
  const total = state?.total ?? 0
  return (
    <section id={id} className="library-file-panel" aria-label="素材库文件">
      {items.length ? (
        <div className="library-file-list">
          {items.map((file) => (
            <Link key={file.id} href={`/media/${file.id}`} className="library-file-row">
              <FileTypeIcon mediaType={file.media_type} />
              <span className="library-file-path">{file.relative_path}</span>
              <span
                className={file.index_status === 'failed' ? 'status-chip error' : 'status-chip'}
              >
                {formatStatus(file.index_status)}
              </span>
            </Link>
          ))}
        </div>
      ) : state?.loading ? null : (
        <p className="muted">该素材库暂无文件。</p>
      )}
      {state?.loading ? (
        <p className="muted" role="status" aria-live="polite">
          正在加载文件…
        </p>
      ) : null}
      {state?.error ? (
        <div className="inline-error" role="alert">
          <span>加载文件失败：{state.error}</span>
          <button type="button" className="secondary-action" onClick={onRetry}>
            重试加载文件
          </button>
        </div>
      ) : null}
      {items.length ? (
        <div className="library-file-footer">
          <span className="muted">
            已显示 {items.length} / {total}
          </span>
          {items.length < total ? (
            <button
              type="button"
              className="secondary-action"
              disabled={state?.loading}
              onClick={onLoadMore}
            >
              加载更多
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function mergeFiles(existing: LibraryMediaItem[], incoming: LibraryMediaItem[]) {
  const byId = new Map(existing.map((file) => [file.id, file]))
  for (const file of incoming) {
    byId.set(file.id, file)
  }
  return [...byId.values()]
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  )
}

function FileTypeIcon({ mediaType }: { mediaType: LibraryMediaItem['media_type'] }) {
  const iconProps = {
    'aria-hidden': true,
    size: 18,
    strokeWidth: 1.7,
  } as const

  if (mediaType === 'image') {
    return (
      <span className="library-file-icon" data-testid="file-type-icon-image">
        <ImageIcon {...iconProps} />
      </span>
    )
  }
  if (mediaType === 'video') {
    return (
      <span className="library-file-icon" data-testid="file-type-icon-video">
        <Video {...iconProps} />
      </span>
    )
  }
  return (
    <span className="library-file-icon" data-testid="file-type-icon-file">
      <File {...iconProps} />
    </span>
  )
}
