import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { DATABASE } from '../database/database.module.js'
import {
  getFileWithAssetsAndVectors,
  getMediaFile,
  type Database,
} from '../database/repositories.js'

@Injectable()
export class MediaService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getMedia(id: string) {
    // Media Detail 需要同时展示文件事实字段和派生 assets。vector_refs 主要用于排查索引状态，
    // 当前响应先隐藏旧策略留下的 stale assets，避免用户看到已经被重索引替代的片段。
    const graph = await getFileWithAssetsAndVectors(this.db, id)
    if (!graph) {
      throw new NotFoundException('Media file not found')
    }

    const assets = graph.assets
      .filter((asset) => !this.isStaleAsset(asset.metadataJson))
      .slice(0, 50)
      .map((asset) => ({
        id: asset.id,
        asset_type: asset.assetType,
        start_time_seconds: asset.startTimeSeconds === null ? null : Number(asset.startTimeSeconds),
        end_time_seconds: asset.endTimeSeconds === null ? null : Number(asset.endTimeSeconds),
        cache_path: asset.path,
        text_content: asset.textContent,
        metadata_json: asset.metadataJson,
      }))

    return {
      id: graph.file.id,
      library_id: graph.file.libraryId,
      path: graph.file.path,
      media_type: graph.file.mediaType,
      size_bytes: graph.file.sizeBytes,
      duration_seconds:
        graph.file.durationSeconds === null ? undefined : Number(graph.file.durationSeconds),
      width: graph.file.width ?? undefined,
      height: graph.file.height ?? undefined,
      codec: graph.file.codec ?? undefined,
      index_status: graph.file.indexStatus,
      assets_limit: 50,
      assets_offset: 0,
      assets_total: graph.assets.length,
      assets,
    }
  }

  async getMediaContent(id: string) {
    const file = await getMediaFile(this.db, id)
    if (!file) {
      throw new NotFoundException('Media file not found')
    }

    return {
      path: file.path,
      media_type: file.mediaType,
      content_type: contentTypeForPath(file.path, file.mediaType),
    }
  }

  private isStaleAsset(metadata: unknown) {
    // 重索引不会物理删除旧 asset，而是用 metadata_json.stale 标记，便于回溯和安全迁移。
    return (
      typeof metadata === 'object' &&
      metadata !== null &&
      'stale' in metadata &&
      metadata.stale === true
    )
  }
}

function contentTypeForPath(path: string, mediaType: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension) {
    const byExtension = contentTypesByExtension[extension]
    if (byExtension) {
      return byExtension
    }
  }

  if (mediaType === 'image') {
    return 'image/jpeg'
  }
  if (mediaType === 'video') {
    return 'video/mp4'
  }
  if (mediaType === 'audio') {
    return 'audio/mpeg'
  }
  return 'application/octet-stream'
}

const contentTypesByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
}
