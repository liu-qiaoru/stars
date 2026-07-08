# VLM Caption 检索与 Rerank 实施计划

> **给自动化编码执行者：** 必须使用子技能：实现本计划时按任务逐项使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）语法跟踪进度。

**目标：** 先把本地 Qwen2.5-VL 生成 caption 接入搜索召回，再把 Qwen2.5-VL 多模态 rerank 作为可开关的高精度层接入，避免一次改变太多排序变量。

**架构：** Phase 15A 只做离线 caption indexing + caption text vector retrieval，并把 caption 作为独立 `caption_match` 来源并入现有 Phase 14 hybrid results，不替换现有 hybrid score。Phase 15A 为视频临时抽帧生成 caption，用完删除帧文件，只保存 caption text 和 embedding。Phase 15B 再为 `blocking` 本地 VLM rerank 引入受容量限制的 512px frame cache；`async` rerank 和 RRF 全局替换放到后续阶段。

**技术栈：** NestJS/TypeScript 搜索编排，Drizzle/PostgreSQL 事实源，Qdrant 向量召回，Python worker 离线 caption/embedding job，独立 localhost Python VLM service 运行 Qwen2.5-VL。

## 全局约束

- PostgreSQL 是事实源；Qdrant 只保存向量和轻量 payload。
- Caption 不能混入 OCR/transcript 语义；caption 使用 `asset_type='caption'` 和 `reason='caption_match'`。
- Phase 15A 不改现有视觉向量、FTS、query expansion、相邻窗口合并和 hybrid score 语义，只新增 caption 来源。
- Phase 15A 不实现 RRF，也不做 RRF 全局替换；RRF 留到 Phase 15C 单独设计。
- Phase 15A 不持久缓存视频帧；caption 生成时临时抽帧，VLM 调用结束后删除临时文件。
- Phase 15B 只实现 `SEARCH_RERANK_MODE=off|blocking`；不实现 `async`。
- Phase 15B 才引入 frame cache，且默认缓存 512px JPEG/WebP、设置容量上限、可清理、可重建。
- 用户请求 rerank 但 VLM 不可用时，响应必须明确返回 rerank 失败状态；不能假装精排成功。
- 生成 caption、caption embedding、rerank 都必须记录 model name、model version、prompt version、source asset IDs、frame times、duration 和 error class。
- 默认面向当前约 3 GB 视频库；先追求可解释、可调试、可回滚。

---

## 为什么拆成两阶段

原方案把 caption indexing、caption embedding、RRF、在线 rerank、async 状态管理和前端高精度体验一起做。这样一旦搜索质量变化，很难判断收益或问题来自哪一层。

新版按可验证顺序推进：

```text
Phase 15A：caption retrieval
  只回答：caption text vector 是否提升召回？

Phase 15B：blocking VLM rerank
  只回答：Qwen2.5-VL 看候选帧能否改善 top-5？

Phase 15C：RRF / async rerank
  只在前两阶段有效后再做排序融合和异步体验优化。
```

## Phase 15A 产品行为

默认搜索仍然快：

```text
query
  -> optional query expansion
  -> visual vectors + FTS + caption_text_vectors
  -> existing hybrid merge/rank
  -> results
```

Phase 15A 开关：

```text
CAPTION_INDEXING_ENABLED=false
CAPTION_SEARCH_ENABLED=false
LOCAL_VLM_ENABLED=false
LOCAL_VLM_SERVICE_URL=http://127.0.0.1:4030
```

含义：

- `CAPTION_INDEXING_ENABLED=true`：worker 在索引后为视觉 assets 创建 caption jobs。
- `CAPTION_SEARCH_ENABLED=true`：server 在搜索时查询 `caption_text_vectors`。
- `LOCAL_VLM_ENABLED=true`：worker 允许调用本地 VLM service 生成 caption。
- 没有 caption vectors 时，搜索仍按现有 Phase 14 行为返回。

## Phase 15B 产品行为

高精度搜索是显式阻塞请求：

```text
query
  -> fast hybrid results
  -> ensure 512px frame cache for top K candidates
  -> send top K candidates to local Qwen2.5-VL
  -> reorder top K
  -> return reranked results + rerank metadata
```

Phase 15B 开关：

```text
SEARCH_RERANK_MODE=off
SEARCH_RERANK_TOP_K=10
SEARCH_RERANK_TIMEOUT_MS=30000
FRAME_CACHE_ENABLED=false
FRAME_CACHE_MAX_BYTES=1073741824
FRAME_CACHE_IMAGE_MAX_WIDTH=512
```

第一版只支持：

```text
off
blocking
```

不支持：

```text
async
```

原因：`async` 需要稳定的状态存储、轮询 endpoint、失败恢复和前端状态机。它应该单独设计，不能塞进第一版。

## 数据模型

优先复用现有 `media_assets`，不新增 caption 表。

Caption asset：

```text
asset_type = 'caption'
file_id = source file id
path = null
start_time_seconds = source visual asset start
end_time_seconds = source visual asset end
frame_time_seconds = source frame time when single-frame caption
text_content = generated caption text
content_hash = hash(source_asset_ids + prompt_version + vlm_model_version + caption_text)
metadata_json = {
  "caption": {
    "source_asset_ids": ["..."],
    "source_frame_times": [12.4],
    "vlm_model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
    "vlm_model_version": "qwen2.5-vl-7b-instruct",
    "prompt_version": "caption-v1",
    "language": "zh-en",
    "generated_at": "ISO timestamp"
  }
}
```

Caption vector collection：

```text
caption_text_vectors
```

初始 text embedding 模型：

```text
model_name = sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
model_version = paraphrase-multilingual-MiniLM-L12-v2
vector_dim = 384
distance = Cosine
vector_kind = vlm_caption_text_embedding
```

关键要求：

- Caption asset 的 `text_content` 是生成文本，不是 OCR，也不是 transcript。
- `caption_text_vectors` 只索引 `asset_type='caption'`。
- 搜索命中 caption vector 时，reason 必须是 `caption_match`。
- 不把 caption asset 纳入现有 `text_search`，避免被误标成 `ocr_match` 或 `transcript_match`。

## 图像来源策略

Phase 15A 和 Phase 15B 使用不同策略，避免还没验证 caption retrieval 收益时就引入长期缓存复杂度。

Phase 15A caption 粒度：

- image asset：直接使用原图路径。
- video_segment asset：用源视频路径 + `representative_frame_time_seconds` 临时抽一张 512px 帧，发送给 VLM 后立即删除。
- video_frame asset：第一版不自动生成 caption，除非后续质量评估证明需要 dense frame caption。

Phase 15B rerank 图像来源：

- image asset：直接使用原图路径，必要时生成 512px 派生图。
- video_segment asset：按 `representative_frame_time_seconds` 生成或复用 512px frame cache。
- video_frame asset：按 `frame_time_seconds` 生成或复用 512px frame cache。

Frame cache 只服务在线 rerank，不服务 Phase 15A caption indexing。缓存文件是可重建派生数据，不能成为事实源。

## 文件结构

- 修改：`packages/shared/constants/index.ts`  
  增加 `caption`、`caption_text_vectors`、`generate_caption`、`embed_text_asset`。

- 修改：`packages/shared/schemas/index.ts`  
  增加 `generate_caption` 和 `embed_text_asset` job schemas。

- 修改：`apps/server/src/config/settings.ts`  
  增加 caption indexing/search、local VLM、blocking rerank、frame cache 的 env 解析。

- 修改：`apps/server/src/qdrant/vector-collections.ts`  
  注册 `caption_text_vectors`。

- 修改：`apps/server/src/model-gateway/model-gateway.service.ts`  
  把 text embedding 改成 model-aware，并新增 `/rerank` 调用。

- 修改：`apps/server/src/search/search-query-vector.service.ts`  
  query embedding cache key 使用 `modelName:modelVersion:vectorDim:query`。

- 修改：`apps/server/src/search/search-hybrid.ts`  
  新增 `caption_match`，但保留现有 score 规则。

- 修改：`apps/server/src/search/search.service.ts`  
  在 `CAPTION_SEARCH_ENABLED=true` 时查询 `caption_text_vectors` 并映射为 `caption_match`。

- 新建：`apps/server/src/search/search-rerank.service.ts`  
  Phase 15B 实现 blocking rerank。

- 新建：`apps/server/src/media/frame-cache.service.ts` 或 `apps/server/src/search/frame-cache.service.ts`  
  Phase 15B 生成/复用 512px frame cache，并执行容量检查。

- 修改：`apps/server/src/jobs/jobs.service.ts`  
  pending `caption_text_vectors` ref 创建 `embed_text_asset` job。

- 修改：`apps/server/src/jobs/jobs-coordinator.service.ts`  
  coordinator 能自动补 caption text embedding jobs。

- 新建：`apps/worker-py/media_agent_worker/vlm_service.py`  
  本地 Qwen2.5-VL service，提供 `/caption`、`/rerank`、`/health`。

- 新建：`apps/worker-py/media_agent_worker/captioning.py`  
  实现 `GenerateCaptionHandler`，视频 caption 使用临时抽帧，用完删除。

- 新建：`apps/worker-py/media_agent_worker/text_embedding_worker.py`  
  实现 `EmbedTextAssetHandler`。

- 修改：`apps/worker-py/media_agent_worker/repository.py`  
  增加 caption asset、caption source asset、text asset embedding helpers。

- 修改：`apps/worker-py/media_agent_worker/worker.py` 和 `apps/worker-py/media_agent_worker/__main__.py`  
  注册 `generate_caption` 和 `embed_text_asset`。

- 修改：`apps/web/lib/api-client.ts`、`apps/web/lib/display-labels.ts`、`apps/web/components/search-workspace.tsx`  
  Phase 15A 展示 `caption_match`；Phase 15B 再增加 blocking high precision 开关。

- 更新：`docs/api-contract.md`、`docs/job-protocol.md`、`docs/vector-index-design.md`、`docs/implementation-plan.md`、`docs/tasks/todo.md`。

## 任务 1：共享协议与配置

**文件：**
- 修改：`packages/shared/constants/index.ts`
- 修改：`packages/shared/schemas/index.ts`
- 修改：`apps/server/src/config/settings.ts`

**接口：**
- 产出 job types：`generate_caption`、`embed_text_asset`
- 产出 asset type：`caption`
- 产出 collection name：`caption_text_vectors`
- 产出 settings：`captionIndexingEnabled`、`captionSearchEnabled`、`localVlmEnabled`、`localVlmServiceUrl`、`searchRerankMode`、`searchRerankTopK`、`searchRerankTimeoutMs`

- [ ] **步骤 1：更新 constants**

  给 `jobTypes` 增加：

  ```ts
  'generate_caption'
  'embed_text_asset'
  ```

  给 `mediaAssetTypes` 增加：

  ```ts
  'caption'
  ```

  给 `vectorCollectionNames` 增加：

  ```ts
  'caption_text_vectors'
  ```

- [ ] **步骤 2：增加 `generate_caption` schema**

  输入：

  ```ts
  export const generateCaptionInputSchema = z.object({
    file_id: uuidSchema,
    source_asset_ids: z.array(uuidSchema).min(1),
    prompt_version: z.literal('caption-v1').default('caption-v1'),
    model_name: z.string().min(1).default('Qwen/Qwen2.5-VL-7B-Instruct'),
    model_version: z.string().min(1).default('qwen2.5-vl-7b-instruct'),
  })
  ```

  输出：

  ```ts
  export const generateCaptionOutputSchema = z.object({
    caption_asset_id: uuidSchema,
    source_assets: nonNegativeIntegerSchema,
    text_written: z.boolean(),
  })
  ```

- [ ] **步骤 3：增加 `embed_text_asset` schema**

  输入：

  ```ts
  export const embedTextAssetInputSchema = z.object({
    asset_id: uuidSchema,
    collection: z.literal('caption_text_vectors'),
    model_name: z.string().min(1),
    model_version: z.string().min(1),
  })
  ```

  输出复用 `embeddingOutputSchema`。

- [ ] **步骤 4：增加 settings**

  增加 env：

  ```text
  CAPTION_INDEXING_ENABLED=false
  CAPTION_SEARCH_ENABLED=false
  LOCAL_VLM_ENABLED=false
  LOCAL_VLM_SERVICE_URL=http://127.0.0.1:4030
  SEARCH_RERANK_MODE=off
  SEARCH_RERANK_TOP_K=10
  SEARCH_RERANK_TIMEOUT_MS=30000
  FRAME_CACHE_ENABLED=false
  FRAME_CACHE_MAX_BYTES=1073741824
  FRAME_CACHE_IMAGE_MAX_WIDTH=512
  ```

  `SEARCH_RERANK_MODE` 第一版只允许：

  ```text
  off
  blocking
  ```

- [ ] **步骤 5：验证**

  运行：

  ```bash
  corepack pnpm --filter @local-media-agent/shared check
  corepack pnpm --filter @local-media-agent/server exec tsc --noEmit
  ```

  预期：shared schema 生成成功，server 编译通过。

## 任务 2：Caption Vector Collection 与 Model-aware Embedding

**文件：**
- 修改：`apps/server/src/qdrant/vector-collections.ts`
- 修改：`apps/server/src/model-gateway/model-gateway.service.ts`
- 修改：`apps/server/src/search/search-query-vector.service.ts`
- 修改：`apps/worker-py/media_agent_worker/model_service.py`

**接口：**
- 产出 collection config：`caption_text_vectors`
- 产出 model-aware embedding request：`{ text, model_name, model_version }`

- [ ] **步骤 1：注册 caption collection**

  在 `VECTOR_COLLECTIONS` 增加：

  ```ts
  caption_text_vectors: {
    modality: 'text',
    vectorKind: 'vlm_caption_text_embedding',
    modelName: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    modelVersion: 'paraphrase-multilingual-MiniLM-L12-v2',
    vectorDim: 384,
    distance: 'Cosine',
  }
  ```

- [ ] **步骤 2：修改 `ModelGatewayService.embedText`**

  新签名：

  ```ts
  embedText(
    text: string,
    expected: { modelName: string; modelVersion: string; vectorDim: number },
  ): Promise<number[]>
  ```

  请求 body：

  ```json
  {
    "text": "query",
    "model_name": "expected model",
    "model_version": "expected version"
  }
  ```

- [ ] **步骤 3：校验模型身份**

  如果 model service 返回的 `model_name`、`model_version`、`vector_dim` 或 `vector.length` 不匹配，抛 `BadGatewayException`。错误信息必须包含 expected 和 actual。

- [ ] **步骤 4：修改 query vector cache key**

  cache key 必须包含：

  ```text
  modelName:modelVersion:vectorDim:query
  ```

  不能只用 `vectorDim:query`。

- [ ] **步骤 5：验证**

  运行：

  ```bash
  corepack pnpm --filter @local-media-agent/server exec vitest run tests/qdrant/collections.test.ts
  corepack pnpm --filter @local-media-agent/server exec tsc --noEmit
  ```

  预期：collection registry 测试通过，server 编译通过。

## 任务 3：Caption 生成 Job

**文件：**
- 新建：`apps/worker-py/media_agent_worker/vlm_service.py`
- 新建：`apps/worker-py/media_agent_worker/captioning.py`
- 修改：`apps/worker-py/media_agent_worker/repository.py`
- 修改：`apps/worker-py/media_agent_worker/worker.py`
- 修改：`apps/worker-py/media_agent_worker/__main__.py`
- 测试：`apps/worker-py/tests/test_captioning_worker.py`

**接口：**
- 消费 `generate_caption`
- 产出 `asset_type='caption'`
- 产出 pending `vector_ref`，collection 为 `caption_text_vectors`
- 视频 caption 使用临时帧文件，不持久化 frame cache

- [ ] **步骤 1：实现 `vlm_service.py` 最小 HTTP surface**

  endpoints：

  ```text
  GET /health
  POST /caption
  POST /rerank
  ```

  `/caption` request：

  ```json
  {
    "image_paths": ["/absolute/path/to/frame.jpg"],
    "prompt_version": "caption-v1"
  }
  ```

  `/caption` response：

  ```json
  {
    "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
    "model_version": "qwen2.5-vl-7b-instruct",
    "prompt_version": "caption-v1",
    "caption": "画面描述..."
  }
  ```

- [ ] **步骤 2：实现 `GenerateCaptionHandler`**

  Handler 流程：

  ```text
  1. get media file
  2. get source visual assets
  3. resolve source image path for image assets
  4. extract temporary 512px frame for video_segment assets
  5. POST /caption
  6. delete temporary frame in finally block
  7. validate non-empty caption and model metadata
  8. upsert caption media_asset
  9. upsert caption_text_vectors vector_ref as pending
  ```

- [ ] **步骤 3：定义幂等键**

  Caption asset `content_hash` 使用：

  ```text
  sha256(source_asset_ids + source_content_hashes + prompt_version + vlm_model_version + caption_text)
  ```

  Source asset metadata 中也记录：

  ```json
  {
    "caption_source_key": "sha256(source_asset_ids + source_content_hashes + prompt_version + vlm_model_version)"
  }
  ```

  用它避免同一 source/prompt/model 重复生成多条 caption。

- [ ] **步骤 4：失败必须失败**

  以下情况 job 失败：

  ```text
  source image/video path missing
  representative_frame_time_seconds missing for video_segment
  temporary frame extraction failed
  /caption non-2xx
  invalid JSON
  empty caption
  missing model_name/model_version
  ```

  不创建空 caption asset。临时帧文件必须在成功和失败路径都删除。

- [ ] **步骤 5：验证**

  运行：

  ```bash
  PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_captioning_worker.py
  ```

  预期：覆盖成功创建、重复 job 幂等、VLM 返回空 caption 失败、source path 缺失失败、临时帧失败后被清理。

## 任务 4：Caption Text Embedding Job 与 Coordinator

**文件：**
- 新建：`apps/worker-py/media_agent_worker/text_embedding_worker.py`
- 修改：`apps/worker-py/media_agent_worker/embeddings.py`
- 修改：`apps/worker-py/media_agent_worker/qdrant.py`
- 修改：`apps/worker-py/media_agent_worker/worker.py`
- 修改：`apps/worker-py/media_agent_worker/__main__.py`
- 修改：`apps/server/src/jobs/jobs.service.ts`
- 修改：`apps/server/src/jobs/jobs-coordinator.service.ts`
- 测试：`apps/worker-py/tests/test_text_embedding_worker.py`
- 测试：`apps/server/tests/jobs/jobs.service.test.ts`

**接口：**
- 消费 pending `vector_refs.collection_name='caption_text_vectors'`
- 产出 `embed_text_asset` job
- 产出 indexed Qdrant point

- [ ] **步骤 1：新增 worker text embedder**

  初始模型：

  ```text
  sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
  ```

  embedding 输出必须 normalize，维度必须是 `384`。

- [ ] **步骤 2：实现 `EmbedTextAssetHandler`**

  Handler 流程：

  ```text
  1. get vector ref
  2. load media_assets.text_content
  3. fail if asset_type != caption
  4. fail if text_content empty
  5. embed text
  6. upsert Qdrant
  7. mark vector_ref indexed
  ```

- [ ] **步骤 3：更新 Qdrant payload**

  Payload 必须包含：

  ```text
  asset_id
  file_id
  library_id
  media_type
  asset_type=caption
  model_name
  model_version
  vector_kind=vlm_caption_text_embedding
  content_hash
  index_profile
  source=generated_caption
  start_time_seconds
  end_time_seconds
  ```

- [ ] **步骤 4：更新 server pending embedding queue**

  `JobsService.queuePendingEmbeddingJobs()` 必须识别：

  ```text
  image_vectors -> embed_image
  video_frame_vectors -> embed_video_frame
  video_segment_vectors -> embed_video_frame
  caption_text_vectors -> embed_text_asset
  ```

  不允许 `caption_text_vectors` 落入 `embed_video_frame`。

- [ ] **步骤 5：验证**

  运行：

  ```bash
  PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_text_embedding_worker.py
  corepack pnpm --filter @local-media-agent/server exec vitest run tests/jobs/jobs.service.test.ts
  ```

  预期：caption pending refs 会创建 `embed_text_asset` job，worker 能写入 Qdrant 并标记 indexed。

## 任务 5：Phase 15A 搜索接入 Caption Match

**文件：**
- 修改：`apps/server/src/search/search-hybrid.ts`
- 修改：`apps/server/src/search/search.service.ts`
- 修改：`apps/server/src/database/repositories.ts`
- 修改：`apps/web/lib/display-labels.ts`
- 修改：`apps/web/components/search-workspace.tsx`
- 测试：`apps/server/tests/search/search.service.test.ts`
- 测试：`apps/web/tests/search-workspace.test.tsx`

**接口：**
- 消费 `caption_text_vectors`
- 产出 `caption_match`
- 产出 `source_scores.caption_text_vectors`

- [ ] **步骤 1：扩展 `HybridReason`**

  增加：

  ```ts
  'caption_match'
  ```

  平局排序优先级：

  ```text
  transcript_match
  ocr_match
  caption_match
  vector_match
  ```

- [ ] **步骤 2：不要改 hybrid score 权重**

  Phase 15A 先把 `caption_text_vectors` 作为普通向量来源处理，沿用现有 vector source weight。不要引入 RRF，不要调整 `VECTOR_SOURCE_WEIGHT`、`TEXT_SOURCE_WEIGHT`、`MULTI_SIGNAL_BONUS`。

- [ ] **步骤 3：SearchService 查询 caption vectors**

  当满足以下条件时查询：

  ```text
  CAPTION_SEARCH_ENABLED=true
  media_types empty OR includes image/video
  ```

  命中结果映射：

  ```text
  collection = caption_text_vectors
  reason = caption_match
  source_scores.caption_text_vectors = qdrant score
  ```

- [ ] **步骤 4：FTS 不包含 caption**

  现有 `text_search` 仍只处理 transcript/OCR。不要把 `asset_type='caption'` 纳入 `listTextSearchResultMetadata()` 的默认条件。

- [ ] **步骤 5：Web 展示**

  显示标签：

  ```text
  caption_match -> Caption
  ```

  不新增高精度开关；Phase 15A 只展示 caption 来源。

- [ ] **步骤 6：验证**

  运行：

  ```bash
  corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search.service.test.ts
  corepack pnpm --filter @local-media-agent/web check
  ```

  预期：caption 命中进入 top-level `results`，reason 为 `caption_match`，关闭 `CAPTION_SEARCH_ENABLED` 时搜索响应与 Phase 14 行为一致。

## 任务 6：Phase 15B Blocking VLM Rerank

**文件：**
- 新建：`apps/server/src/search/search-rerank.service.ts`
- 修改：`apps/server/src/search/search.service.ts`
- 修改：`apps/server/src/search/search.controller.ts`
- 修改：`apps/server/src/model-gateway/model-gateway.service.ts`
- 修改：`apps/web/lib/api-client.ts`
- 修改：`apps/web/components/search-workspace.tsx`
- 测试：`apps/server/tests/search/search-rerank.service.test.ts`
- 测试：`apps/server/tests/search/search.service.test.ts`

**接口：**
- 消费 fast hybrid results
- 支持 request `rerank_mode='off' | 'blocking'`
- 产出 response field `rerank`

- [ ] **步骤 1：扩展 search request schema**

  增加：

  ```ts
  rerank_mode: z.enum(['off', 'blocking']).optional()
  ```

  默认使用 `SEARCH_RERANK_MODE`。

- [ ] **步骤 2：定义 rerank response**

  响应增加：

  ```json
  {
    "rerank": {
      "mode": "blocking",
      "status": "succeeded",
      "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
      "model_version": "qwen2.5-vl-7b-instruct",
      "duration_ms": 1234,
      "error": null
    }
  }
  ```

  状态值：

  ```text
  not_requested
  skipped_disabled
  succeeded
  failed
  timed_out
  ```

- [ ] **步骤 3：实现 `/rerank` gateway**

  `ModelGatewayService.rerankCandidates()` 请求：

  ```json
  {
    "query": "用户 query",
    "candidates": [
      {
        "candidate_id": "asset-id",
        "image_paths": ["/absolute/frame.jpg"],
        "caption": "caption text",
        "ocr_text": "optional",
        "transcript": "optional",
        "start_time_seconds": 1.0,
        "end_time_seconds": 3.0
      }
    ],
    "prompt_version": "rerank-v1"
  }
  ```

- [ ] **步骤 4：实现 512px frame cache**

  对 rerank 候选生成或复用缓存图：

  ```text
  image asset -> 生成 512px 派生图，或直接使用原图的 512px cache
  video_segment asset -> 用 representative_frame_time_seconds 抽 512px frame
  video_frame asset -> 用 frame_time_seconds 抽 512px frame
  ```

  cache metadata 写入：

  ```json
  {
    "frame_cache": {
      "path": ".media-agent/cache/frames/...",
      "width": 512,
      "format": "jpg",
      "source_file_id": "file-id",
      "source_asset_id": "asset-id",
      "frame_time_seconds": 12.4,
      "created_at": "ISO timestamp"
    }
  }
  ```

  约束：

  ```text
  FRAME_CACHE_ENABLED=false 时不生成缓存，rerank 对视频候选返回缺图 skip
  cache 超过 FRAME_CACHE_MAX_BYTES 时先执行未引用缓存清理
  cache 文件丢失时可重建
  cache path 不参与 media_assets identity
  ```

- [ ] **步骤 5：只重排 top K**

  只发送 `SEARCH_RERANK_TOP_K` 条候选。VLM 返回的 candidate IDs 排在前面；未返回的候选按原 hybrid 顺序接在后面。

- [ ] **步骤 6：缺图不静默**

  如果候选缺少可读 image path：

  ```text
  该候选不发送给 VLM
  rerank metadata 记录 skipped_candidate_count
  如果全部候选都缺图，rerank.status='failed'
  ```

- [ ] **步骤 7：Web 高精度开关**

  Web 开关只发送：

  ```text
  off -> rerank_mode='off'
  on -> rerank_mode='blocking'
  ```

  第一版允许按钮旁显示“会慢一些”。

- [ ] **步骤 8：验证**

  运行：

  ```bash
  corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search-rerank.service.test.ts
  corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search.service.test.ts -t rerank
  corepack pnpm --filter @local-media-agent/web check
  ```

  预期：`off` 不调用 VLM；`blocking` 会重排 top K；VLM disabled、timeout、缺图都有明确状态。

## 任务 7：文档与质量评估

**文件：**
- 修改：`docs/api-contract.md`
- 修改：`docs/job-protocol.md`
- 修改：`docs/vector-index-design.md`
- 修改：`docs/implementation-plan.md`
- 修改：`docs/tasks/todo.md`
- 新建：`docs/finding-unknowns/2026-07-08-caption-rerank-eval.md`

**接口：**
- 文档化 Phase 15A/15B 行为
- 产出一组人工评估 queries

- [ ] **步骤 1：更新 API contract**

  文档化：

  ```text
  caption_match
  caption_text_vectors
  rerank_mode='off'|'blocking'
  rerank response object
  ```

- [ ] **步骤 2：更新 job protocol**

  文档化：

  ```text
  generate_caption
  embed_text_asset
  caption asset metadata
  VLM service boundary
  failure behavior
  ```

- [ ] **步骤 3：更新 vector index design**

  增加：

  ```text
  caption_text_vectors
  vector_kind=vlm_caption_text_embedding
  source=generated_caption
  rebuild behavior
  ```

- [ ] **步骤 4：写质量评估文档**

  新建 `docs/finding-unknowns/2026-07-08-caption-rerank-eval.md`，包含至少 12 条本地测试 query：

  ```text
  4 条对象/场景查询
  4 条动作查询
  2 条中文查询
  2 条容易误召回的负例查询
  ```

  每条记录：

  ```text
  query
  expected files/time ranges
  Phase 14 result
  Phase 15A result
  Phase 15B result
  notes
  ```

- [ ] **步骤 5：验证**

  运行：

  ```bash
  git diff --check
  ```

  预期：无 whitespace errors。

## 暂不做的内容

这些内容不是否定，而是避免第一版变成无法调试的大球：

- 不做 `async` rerank。
- 不把 RRF 接入默认排序。
- 不给所有 dense video frames 自动生成 caption。
- 不把 caption 纳入默认 PostgreSQL FTS。
- Phase 15A 不持久缓存视频帧。
- Phase 15B 不做无限缓存，只允许受 `FRAME_CACHE_MAX_BYTES` 限制的 512px frame cache。
- 不新增复杂模型 registry 表；先沿用 collection registry。

## 后续 Phase 15C 候选内容

Phase 15A/15B 验证有效后，再考虑：

- RRF 替换或前置现有 hybrid score。
- `SEARCH_RERANK_MODE=async`，使用 PostgreSQL job 或持久化 rerank cache。
- Caption FTS 独立 source：`caption_search`。
- Dense keyframe caption。
- Rerank 结果缓存表。

## 测试策略

Server：

```bash
corepack pnpm --filter @local-media-agent/server check
```

Web：

```bash
corepack pnpm --filter @local-media-agent/web check
```

Shared：

```bash
corepack pnpm --filter @local-media-agent/shared check
```

Python worker：

```bash
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

手动 smoke test：

```text
1. 启动 PostgreSQL、Qdrant、server、web、embedding model service。
2. LOCAL_VLM_ENABLED=true 时启动 vlm_service。
3. CAPTION_INDEXING_ENABLED=true，索引一个小视频目录。
4. 确认 caption assets 和 caption_text_vectors indexed refs 出现。
5. CAPTION_SEARCH_ENABLED=false 搜索，记录 Phase 14 baseline。
6. CAPTION_SEARCH_ENABLED=true 搜索，确认 caption_match 出现。
7. FRAME_CACHE_ENABLED=true 且 SEARCH_RERANK_MODE=blocking 搜索，确认 512px frame cache 生成且 top K 被重排。
8. 停止 VLM service，再请求 blocking rerank，确认 fast results 保留且 rerank.status 明确失败。
```

## 自检

- Spec 覆盖：已覆盖 caption indexing、caption retrieval、blocking VLM rerank、开关、失败可见性、模型版本校验、任务队列、文档和评估。
- 占位检查：没有未解决占位内容。
- 类型一致性：全文使用一致命名：`caption`、`caption_text_vectors`、`caption_match`、`generate_caption`、`embed_text_asset`、`rerank_mode`。
