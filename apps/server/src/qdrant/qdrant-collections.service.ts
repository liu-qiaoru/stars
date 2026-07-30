import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { SETTINGS, type Settings } from '../config/settings.js'
import {
  VECTOR_COLLECTIONS,
  type VectorCollectionConfig,
  type VectorCollectionName,
} from './vector-collections.js'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type ResetVectorRefs = (
  collectionName: VectorCollectionName,
  config: VectorCollectionConfig,
) => Promise<void>
type HasVectorRefConfigMismatch = (
  collectionName: VectorCollectionName,
  config: VectorCollectionConfig,
) => Promise<boolean>

// vector-index-design.md: payload keyword indexes 用于搜索时按 library_id / media_type 高效过滤
const PAYLOAD_INDEXES = [
  { fieldName: 'library_id', fieldSchema: 'keyword' },
  { fieldName: 'media_type', fieldSchema: 'keyword' },
] as const

@Injectable()
export class QdrantCollectionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QdrantCollectionsService.name)

  constructor(
    @Inject(SETTINGS) settingsOrUrl: Settings | string,
    private readonly fetcher: Fetcher = fetch,
    private readonly collections: Partial<
      Record<VectorCollectionName, VectorCollectionConfig>
    > = VECTOR_COLLECTIONS,
    private readonly resetVectorRefsForCollection?: ResetVectorRefs,
    private readonly hasVectorRefConfigMismatch?: HasVectorRefConfigMismatch,
  ) {
    this.qdrantUrl =
      typeof settingsOrUrl === 'string'
        ? settingsOrUrl.replace(/\/$/, '')
        : settingsOrUrl.qdrantUrl.replace(/\/$/, '')
  }

  private readonly qdrantUrl: string

  async onApplicationBootstrap() {
    try {
      await this.ensureCollections()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Qdrant collection initialization failed: ${message}`)
    }
  }

  async ensureCollections() {
    // 启动时确保 collection 维度与注册表一致。维度变化意味着旧 point 无法复用，
    // 因此会重建 collection，并让 PostgreSQL vector_refs 回到 pending 等待 worker 重写。
    const created: string[] = []
    const existing: string[] = []
    const recreated: string[] = []

    for (const [name, config] of Object.entries(this.collections) as [
      VectorCollectionName,
      VectorCollectionConfig,
    ][]) {
      const collectionUrl = `${this.qdrantUrl}/collections/${name}`
      const response = await this.fetcher(collectionUrl, { method: 'GET' })
      if (response.ok) {
        const dimensionMismatch = await this.hasDimensionMismatch(response, config)
        const modelConfigMismatch =
          (await this.hasVectorRefConfigMismatch?.(name, config)) ?? false
        if (dimensionMismatch || modelConfigMismatch) {
          // 先把 PostgreSQL 引用原子地置为 pending，再操作外部 Qdrant。两个系统无法共享
          // 一个数据库事务；这个顺序保证后续任何删除/创建失败都只会留下“等待重写”的安全状态，
          // 不会让不存在的 Point 继续显示为 indexed。下次启动会再次尝试恢复 Collection。
          await this.resetVectorRefsForCollection?.(name, config)
          const deleteResponse = await this.fetcher(collectionUrl, { method: 'DELETE' })
          if (!deleteResponse.ok) {
            throw new Error(
              `Failed to delete Qdrant collection ${name}: HTTP ${deleteResponse.status}`,
            )
          }
          await this.createCollection(collectionUrl, name, config)
          recreated.push(name)
          continue
        }
        existing.push(name)
        continue
      }

      // 只有 404（Not Found，资源不存在）能证明 Collection 缺失。401、429、500 等状态
      // 分别可能表示鉴权、限流或服务端临时故障；若把它们误判成缺失，会把整个素材库的
      // Vector Ref 重置为 pending，并触发昂贵且没有必要的全量重新向量化。
      if (response.status !== 404) {
        throw new Error(`Failed to inspect Qdrant collection ${name}: HTTP ${response.status}`)
      }

      // Collection 缺失意味着 Qdrant 中没有任何可检索 Point；PostgreSQL 里即使还保留
      // indexed Vector Ref 也不能继续当成成功。统一重置为 pending 后，协调器会重新创建
      // embedding 任务，从而恢复数据库事实状态与真实向量状态的一致性。
      await this.resetVectorRefsForCollection?.(name, config)
      await this.createCollection(collectionUrl, name, config)
      created.push(name)
    }

    // vector-index-design.md: 确保 payload keyword indexes 存在（幂等，已存在时不报错）
    await this.createPayloadIndexes()

    return recreated.length ? { created, existing, recreated } : { created, existing }
  }

  private async hasDimensionMismatch(response: Response, config: VectorCollectionConfig) {
    try {
      const body = (await response.json()) as {
        result?: { config?: { params?: { vectors?: { size?: number } } } }
      }
      const actualSize = body.result?.config?.params?.vectors?.size
      return typeof actualSize === 'number' && actualSize !== config.vectorDim
    } catch {
      return false
    }
  }

  private async createCollection(
    collectionUrl: string,
    name: VectorCollectionName,
    config: VectorCollectionConfig,
  ) {
    const createResponse = await this.fetcher(collectionUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          size: config.vectorDim,
          distance: config.distance,
        },
      }),
    })
    if (!createResponse.ok) {
      throw new Error(`Failed to create Qdrant collection ${name}: HTTP ${createResponse.status}`)
    }
  }

  private async createPayloadIndexes() {
    // Qdrant payload index 是性能优化，不是事实过滤的唯一来源；Search hydration 仍会回 PostgreSQL 兜底。
    for (const [name] of Object.entries(this.collections) as [
      VectorCollectionName,
      VectorCollectionConfig,
    ][]) {
      for (const { fieldName, fieldSchema } of PAYLOAD_INDEXES) {
        await this.fetcher(`${this.qdrantUrl}/collections/${name}/index`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field_name: fieldName, field_schema: fieldSchema }),
        })
      }
    }
  }
}
