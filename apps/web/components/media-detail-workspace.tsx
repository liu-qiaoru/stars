'use client'

import { useState } from 'react'
import { createApiClient, type ExportClipRequest, type MediaDetail } from '../lib/api-client'
import {
  formatAssetType,
  formatMediaType,
  formatStatus,
  formatTimeRange,
} from '../lib/display-labels'
import { MediaThumbnail } from './media-thumbnail'

interface ClipExportClient {
  exportClip(input: ExportClipRequest): Promise<{ job_id: string; status: string }>
}

export function MediaDetailWorkspace({
  media,
  apiClient = createApiClient(),
}: {
  media: MediaDetail
  apiClient?: ClipExportClient
}) {
  const [exportStatusByAssetId, setExportStatusByAssetId] = useState<Record<string, string>>({})

  async function exportAsset(asset: MediaDetail['assets'][number]) {
    if (asset.start_time_seconds === null || asset.end_time_seconds === null) {
      return
    }
    setExportStatusByAssetId((current) => ({ ...current, [asset.id]: '正在创建导出任务...' }))
    try {
      const response = await apiClient.exportClip({
        file_id: media.id,
        start_time_seconds: asset.start_time_seconds,
        end_time_seconds: asset.end_time_seconds,
        output_format: 'mp4',
      })
      setExportStatusByAssetId((current) => ({
        ...current,
        [asset.id]: `已创建导出任务 ${response.job_id}`,
      }))
    } catch {
      setExportStatusByAssetId((current) => ({ ...current, [asset.id]: '导出任务创建失败' }))
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_360px]">
      <section className="pin-card-large">
        <MediaThumbnail index={1} label={media.path} className="aspect-video" />
      </section>
      <aside className="panel">
        <p className="eyebrow">{formatMediaType(media.media_type)}</p>
        <h1 className="page-title break-words">{media.path}</h1>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Info label="状态" value={formatStatus(media.index_status)} />
          <Info label="编码" value={media.codec ?? '未知'} />
          <Info label="大小" value={`${Math.round(media.size_bytes / 1024 / 1024)} MB`} />
          <Info label="资产" value={String(media.assets_total)} />
        </div>
      </aside>
      <section className="panel lg:col-span-2">
        <h2 className="section-title">片段</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {media.assets.map((asset) => (
            <article key={asset.id} className="row-card">
              <div>
                <h3 className="card-title">{formatAssetType(asset.asset_type)}</h3>
                <p className="muted">
                  {formatTimeRange(asset.start_time_seconds ?? 0, asset.end_time_seconds ?? 0)}
                </p>
                {exportStatusByAssetId[asset.id] ? (
                  <p className="muted mt-2">{exportStatusByAssetId[asset.id]}</p>
                ) : null}
              </div>
              <button
                className="secondary-action"
                type="button"
                disabled={asset.start_time_seconds === null || asset.end_time_seconds === null}
                onClick={() => {
                  void exportAsset(asset)
                }}
              >
                导出
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
