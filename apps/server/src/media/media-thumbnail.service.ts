import { execFile } from 'node:child_process'
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'

/**
 * FFmpeg 缩略图命令的可注入边界。
 * 生产环境执行本地 FFmpeg；测试替换成内存 fake，避免读取真实视频或创建子进程。
 */
export const MEDIA_THUMBNAIL_RUNNER = Symbol('MEDIA_THUMBNAIL_RUNNER')

export type MediaThumbnailRunner = (input: {
  path: string
  timeSeconds: number
}) => Promise<Buffer>

const MAX_CONCURRENT_THUMBNAILS = 2
const MAX_CACHED_THUMBNAILS = 128

/**
 * 按需从视频指定时间点提取一张 JPEG。
 *
 * 详情页只会请求当前场景页的图片。这里再把 FFmpeg 并发限制为 2，避免浏览器同时加载
 * 多张缩略图时启动大量解码进程。内存缓存不改写源媒体、PostgreSQL 或 Qdrant；
 * Server 重启后缓存自然清空，源文件重新索引后也不会遗留磁盘缩略图。
 */
@Injectable()
export class MediaThumbnailService {
  private activeCount = 0
  private readonly waiters: Array<() => void> = []
  private readonly cache = new Map<string, Promise<Buffer>>()

  constructor(
    @Inject(MEDIA_THUMBNAIL_RUNNER)
    private readonly runner: MediaThumbnailRunner,
  ) {}

  getThumbnail(path: string, timeSeconds: number, versionIdentity = '') {
    // 毫秒精度足以区分场景起点，也能把语义相同的浮点参数归并到同一缓存键。
    const cacheKey = `${path}:${versionIdentity}:${timeSeconds.toFixed(3)}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      // Map 的插入顺序承担简单 LRU（Least Recently Used，最近最少使用）淘汰顺序。
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }

    const pending = this.runWithConcurrencyLimit(path, timeSeconds).catch((error) => {
      // 失败结果不能缓存，否则一次临时 FFmpeg 错误会让后续请求持续失败。
      this.cache.delete(cacheKey)
      throw error
    })
    this.cache.set(cacheKey, pending)
    this.evictOldestEntries()
    return pending
  }

  private async runWithConcurrencyLimit(path: string, timeSeconds: number) {
    await this.acquireSlot()
    try {
      return await this.runner({ path, timeSeconds })
    } catch {
      // 不向 HTTP 响应暴露本地路径或 FFmpeg stderr，只返回稳定的服务不可用错误。
      throw new ServiceUnavailableException('Media thumbnail generation failed')
    } finally {
      this.releaseSlot()
    }
  }

  private async acquireSlot() {
    if (this.activeCount < MAX_CONCURRENT_THUMBNAILS) {
      this.activeCount += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.activeCount += 1
  }

  private releaseSlot() {
    this.activeCount -= 1
    this.waiters.shift()?.()
  }

  private evictOldestEntries() {
    while (this.cache.size > MAX_CACHED_THUMBNAILS) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) return
      this.cache.delete(oldestKey)
    }
  }
}

/**
 * 快速 seek 到场景时间点后只解码一帧，输出最大 480×270 的 JPEG 到 stdout。
 * `-ss` 放在输入前可利用视频关键帧快速定位；15 秒超时和 4 MiB 输出上限避免异常媒体拖住 Server。
 */
export const runFfmpegThumbnail: MediaThumbnailRunner = ({ path, timeSeconds }) =>
  new Promise<Buffer>((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(timeSeconds),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:270:force_original_aspect_ratio=decrease',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: null, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error || stdout.length === 0) {
          reject(error ?? new Error('FFmpeg returned an empty thumbnail'))
          return
        }
        resolve(stdout)
      },
    )
  })
