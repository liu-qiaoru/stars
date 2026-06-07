'use client'

import { FolderPlus, Play } from 'lucide-react'
import type { LibrarySummary } from '../lib/api-client'
import { createApiClient } from '../lib/api-client'

export function LibraryWorkspace({ libraries }: { libraries: LibrarySummary[] }) {
  async function createLibrary(formData: FormData) {
    const name = String(formData.get('name') ?? '').trim()
    const rootPath = String(formData.get('root_path') ?? '').trim()
    if (!name || !rootPath) {
      return
    }
    await createApiClient().createLibrary({ name, root_path: rootPath })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <section className="panel">
        <p className="eyebrow">素材库</p>
        <h1 className="page-title">本地来源</h1>
        <form action={createLibrary} className="mt-5 space-y-3">
          <label className="field-label">
            名称
            <input name="name" className="text-input" placeholder="主媒体库" />
          </label>
          <label className="field-label">
            根路径
            <input name="root_path" className="text-input" placeholder="/本地媒体" />
          </label>
          <button className="primary-action w-full justify-center" type="submit">
            <FolderPlus aria-hidden="true" size={16} />
            添加素材库
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="list-stack">
          {libraries.map((library) => (
            <article key={library.id} className="row-card">
              <div>
                <h2 className="card-title">{library.name}</h2>
                <p className="muted">{library.root_path}</p>
              </div>
              <div className="metric-strip">
                <Metric label="媒体" value={library.media_count ?? 0} />
                <Metric label="已索引" value={library.indexed_count ?? 0} />
                <Metric label="失败" value={library.failed_count ?? 0} />
              </div>
              <button
                className="secondary-action"
                type="button"
                onClick={async () => {
                  try {
                    await createApiClient().scanLibrary(library.id)
                  } catch {
                    /* scan 触发失败静默处理，避免未捕获 Promise rejection */
                  }
                }}
              >
                <Play aria-hidden="true" size={16} />
                扫描
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  )
}
