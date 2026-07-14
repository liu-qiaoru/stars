import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SETTINGS, type Settings } from '../../src/config/settings.js'
import { DATABASE, PG_POOL } from '../../src/database/database.module.js'
import {
  createLibrary,
  createMediaAsset,
  createMediaFile,
  createVectorRef,
} from '../../src/database/repositories.js'
import { ModelGatewayService } from '../../src/model-gateway/model-gateway.service.js'
import { QDRANT_CLIENT } from '../../src/qdrant/qdrant.module.js'
import { SearchModule } from '../../src/search/search.module.js'
import { SearchService } from '../../src/search/search.service.js'
import { createTestDatabase } from '../database/test-db.js'

const settings: Settings = {
  serverHost: '127.0.0.1',
  serverPort: 4000,
  databaseUrl: 'postgres://user:pass@localhost:5432/media_agent_test',
  qdrantUrl: 'http://localhost:6333',
  modelServiceUrl: 'http://127.0.0.1:4020',
  modelServiceTimeoutMs: 10000,
  allowExternalLlm: false,
  agentModel: 'disabled',
  agentMaxSteps: 4,
  agentToolTimeoutMs: 10000,
  jobCoordinatorEnabled: true,
  jobCoordinatorIntervalMs: 5000,
  jobCoordinatorEmbeddingLimit: 100,
  jobCoordinatorOcrLimit: 500,
  queryExpansionProvider: 'none',
  queryExpansionTimeoutMs: 10000,
  queryExpansionMaxVariants: 3,
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: undefined,
  deepseekModel: 'deepseek-v4-flash',
  captionIndexingEnabled: true,
  captionSearchEnabled: true,
  videoSegmentSearchEnabled: false,
  localVlmEnabled: false,
  localVlmServiceUrl: 'http://127.0.0.1:4030',
  searchRerankMode: 'off',
  searchRerankTopK: 10,
  searchRerankTimeoutMs: 30000,
  frameCacheEnabled: false,
  frameCacheMaxBytes: 1073741824,
  frameCacheImageMaxWidth: 512,
}

describe('search diagnostics', () => {
  let closeDb: () => Promise<void>
  let closeModule: () => Promise<void>
  let service: SearchService
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db']
  const qdrantSearch = vi.fn()
  const embedText = vi.fn()

  beforeEach(async () => {
    const testDb = await createTestDatabase()
    db = testDb.db
    closeDb = testDb.close
    qdrantSearch.mockReset()
    embedText.mockReset()
    embedText.mockImplementation(async (_text: string, expected: { vectorDim: number }) =>
      Array.from({ length: expected.vectorDim }, () => 0),
    )
    const moduleRef = await Test.createTestingModule({ imports: [SearchModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(PG_POOL)
      .useValue(null)
      .overrideProvider(SETTINGS)
      .useValue(settings)
      .overrideProvider(QDRANT_CLIENT)
      .useValue({ search: qdrantSearch })
      .overrideProvider(ModelGatewayService)
      .useValue({ embedText })
      .compile()
    service = moduleRef.get(SearchService)
    closeModule = () => moduleRef.close()
  })

  afterEach(async () => {
    await closeModule?.()
    await closeDb?.()
  })

  test('returns Caption provenance and per-Point query scores only when explicitly requested', async () => {
    const library = await createLibrary(db, { name: 'Images', rootPath: '/images' })
    const file = await createMediaFile(db, {
      libraryId: library.id,
      path: '/images/person.jpg',
      relativePath: 'person.jpg',
      mediaType: 'image',
      sizeBytes: 100,
      mtimeMs: 1710000000000,
    })
    const caption = await createMediaAsset(db, {
      fileId: file.id,
      assetType: 'caption',
      textContent: '一个人背靠岩石站立。',
      contentHash: 'caption-hash',
      metadataJson: { prompt_version: 'caption-v1', source: 'vlm_caption' },
    })
    const pointId = '14141414-1414-4414-8414-141414141414'
    await createVectorRef(db, {
      assetId: caption.id,
      fileId: file.id,
      libraryId: library.id,
      collectionName: 'caption_text_vectors',
      pointId,
      modelName: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      modelVersion: 'paraphrase-multilingual-MiniLM-L12-v2',
      vectorKind: 'vlm_caption_text_embedding',
      vectorDim: 384,
      distance: 'Cosine',
      contentHash: 'caption-hash',
      indexProfile: 'balanced',
      status: 'indexed',
    })
    qdrantSearch.mockImplementation(async (collection: string) =>
      collection === 'caption_text_vectors' ? [{ id: pointId, score: 0.63 }] : [],
    )

    const regular = await service.search({ query: '一个人靠着石头', media_types: ['image'] })
    expect(regular).not.toHaveProperty('query_diagnostics')
    expect(regular.groups.flatMap((group) => group.results)[0]).not.toHaveProperty('diagnostics')

    const diagnostic = await service.search({
      query: '一个人靠着石头',
      media_types: ['image'],
      query_expansion_mode: 'original',
      include_diagnostics: true,
    })
    expect(diagnostic.query_diagnostics).toEqual({
      query_expansion_mode: 'original',
      query_variants: [{ text: '一个人靠着石头', weight: 1, source: 'original' }],
    })
    expect(
      diagnostic.groups.find((group) => group.collection === 'caption_text_vectors')?.results[0],
    ).toMatchObject({
      asset_id: caption.id,
      diagnostics: {
        source_rank: 1,
        caption: { text: '一个人背靠岩石站立。', prompt_version: 'caption-v1' },
        query_variant_hits: [
          {
            text: '一个人靠着石头',
            source: 'original',
            weight: 1,
            raw_score: 0.63,
            weighted_score: 0.63,
            winning: true,
          },
        ],
      },
    })
  })
})
