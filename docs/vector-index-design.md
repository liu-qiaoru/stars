# 向量索引设计

## 目标

本设计定义 Qdrant 中的 collection、point、payload 结构，以及 PostgreSQL 中用于引用向量的关系数据。目标是让图片、视频、音频和文本检索可以扩展，同时避免把 Qdrant 当成主数据库。

核心原则：

- PostgreSQL 是事实来源。
- Qdrant 只保存向量和轻量 payload。
- 原始文件路径、完整 metadata、transcript、OCR 全文、job 状态都回 PostgreSQL 查询。
- point id 必须可重复生成，支持幂等 upsert。
- 模型名称、模型版本、向量维度和距离算法必须被记录，方便后续重建索引。

不同模型的 raw cosine 分布不可跨 collection 直接比较。SigLIP visual cosine 与 Caption 文本 Embedding cosine 都只在各自来源内部用于排序，不是统一相关概率。实验评测使用来源内 rank 计算无权重 RRF，同时保留 raw score、source rank 和逐信号贡献用于诊断。

## Qdrant Collection 划分

第一版按模态和用途拆 collection：

```text
image_vectors
video_frame_vectors
video_segment_vectors
audio_segment_vectors
text_chunk_vectors
```

不要在第一版把所有向量放进一个 collection。不同模态的模型、向量维度、过滤字段和 reranking 逻辑可能不同，拆开更容易重建和排查。

### image_vectors

用途：

- 图片语义搜索。
- 图搜图。
- 从文本查询召回图片。

典型来源：

- `media_assets.asset_type = image`

### video_frame_vectors

用途：

- 基于关键帧的视频视觉召回。
- 支持文本搜视频画面、图片搜视频画面。

典型来源：

- `media_assets.asset_type = video_frame`

### video_segment_vectors

用途：

- 视频片段级召回。
- MVP 阶段使用代表帧 embedding 作为片段向量。
- 不默认对多个差异很大的关键帧做简单平均，避免抹平 scene 内部差异。
- 后续如果引入聚合，必须在 `vector_kind` 或 payload 中记录聚合策略。

典型来源：

- `media_assets.asset_type = video_segment`

### audio_segment_vectors

用途：

- 音频语义检索。
- 视频或音频转写后的语音内容检索。

典型来源：

- `media_assets.asset_type = audio_segment`

> Phase 12 起：转写产出的 `text_chunk` assets 先只进 PostgreSQL FTS（`text_content` → `text_tsv` 生成列）。`audio_segment_vectors` 在 Phase 12 保持空 collection（启动时创建），等后续阶段接入 sentence-transformers 文本 embedding 后再填充，无需改 schema。

### text_chunk_vectors

用途：

- 文档、transcript、OCR 文本的语义检索。

典型来源：

- `media_assets.asset_type = text_chunk`

> Phase 12 同上：text_chunk 先走 FTS，`text_chunk_vectors` 保持空 collection，文本 embedding 延后。
>
> Phase 13 起：OCR 画面文字同样复用 Phase 12 的 `media_assets.text_content` → `text_tsv` 生成列 + GIN，**写回被 OCR 的 image/video_frame asset 本身的 `text_content`**（不新建 ocr_chunk 行，零新迁移）。`ocr_chunk` asset_type 预留给未来更细 bbox/text-block 粒度。FTS 查询放宽到 `text_chunk`/`image`/`video_frame` 任何有 `text_content` 的 asset；OCR text embedding 同 Phase 12 延后。

## Collection 配置

每个 collection 必须有明确配置。实现时应在 TypeScript server 中维护一个 collection registry。

示例（Phase 10 起使用 SigLIP，向量维度以运行时校验的实际输出为准）：

```ts
VECTOR_COLLECTIONS = {
  image_vectors: {
    modality: "image",
    vectorKind: "image_embedding",
    modelName: "google/siglip-base-patch16-224",
    modelVersion: "siglip-base-patch16-224",
    vectorDim: 768, // 运行时校验：SigLIP-base hidden_size
    distance: "Cosine",
  },
  video_frame_vectors: {
    modality: "video",
    vectorKind: "frame_embedding",
    modelName: "google/siglip-base-patch16-224",
    modelVersion: "siglip-base-patch16-224",
    vectorDim: 768,
    distance: "Cosine",
  },
  video_segment_vectors: {
    modality: "video",
    vectorKind: "representative_frame_embedding",
    modelName: "google/siglip-base-patch16-224",
    modelVersion: "siglip-base-patch16-224",
    vectorDim: 768,
    distance: "Cosine",
  },
  audio_segment_vectors: {
    modality: "audio",
    vectorKind: "text_embedding",
    modelName: "sentence-transformers",
    modelVersion: "all-MiniLM-L6-v2",
    vectorDim: 384,
    distance: "Cosine",
  },
  text_chunk_vectors: {
    modality: "text",
    vectorKind: "text_embedding",
    modelName: "sentence-transformers",
    modelVersion: "all-MiniLM-L6-v2",
    vectorDim: 384,
    distance: "Cosine",
  },
} as const;
```

`vector_dim` 必须来自实际 embedding 模型输出，不应硬编码成无法追踪的魔法数字。SigLIP 公开配置主线显示 hidden_size 768，但实现必须在模型加载或首次推理时读取并校验实际输出维度。模型变更时，应创建新版本记录，并重建对应 collection 或对应 points。Qdrant 不支持修改已有 collection 的向量维度，因此模型升级需要删除并重建 collection。

## Qdrant Point 结构

每个 point 包含：

```json
{
  "id": "deterministic-point-uuid",
  "vector": [0.012, -0.031, 0.44],
  "payload": {
    "asset_id": "media_assets.id",
    "file_id": "media_files.id",
    "library_id": "libraries.id",
    "media_type": "video",
    "asset_type": "video_segment",
    "start_time_seconds": 120.0,
    "end_time_seconds": 150.0,
    "model_name": "siglip",
    "model_version": "siglip-base-patch16-224",
    "vector_kind": "representative_frame_embedding",
    "content_hash": "hash-of-segment-input",
    "index_profile": "balanced"
  }
}
```

Payload 只放检索过滤和回表所需字段。不要放完整 transcript、OCR 全文、大块 metadata 或源文件内容。

## Point ID 策略

Point ID 使用确定性 UUID，避免重复索引产生重复 points。

推荐输入：

```text
asset_id
collection_name
model_name
model_version
vector_kind
content_hash
```

生成规则：

```text
point_id = uuid5(namespace, joined_inputs)
```

好处：

- 同一 asset 重复索引可以安全 upsert。
- 模型版本变化会生成不同 point。
- content hash 变化会生成不同 point。
- 删除和重建更可控。

## Payload 字段

通用字段：

```text
asset_id
file_id
library_id
media_type
asset_type
model_name
model_version
vector_kind
content_hash
index_profile
```

时序媒体字段：

```text
start_time_seconds
end_time_seconds
```

可选字段：

```text
scene_id
frame_time_seconds
language
source
```

`source` 可用于标识向量来源，例如：

```text
image
keyframe
scene_aggregate
transcript_chunk
ocr_chunk
document_chunk
```

## Segment Vector 策略

`video_segment_vectors` 是迁移前的代表帧策略。新索引保留 `video_segment` 资产作为边界与 caption 容器，但不再创建该 collection 的 vector ref；迁移完成后通过 `VIDEO_SEGMENT_SEARCH_ENABLED=false` 停止在线读取，旧 points 不删除、旧 refs 标记 stale。

当前视频视觉索引策略：

1. PySceneDetect 得到原始 scene，超过 `SCENE_MAX_SECONDS` 的长镜头继续拆窗，fallback 也使用固定 30 秒窗口。
2. 每个窗口至少创建一个带相同 `scene_id` 的 `video_frame`，并根据密度创建额外关键帧；每帧独立写入 `video_frame_vectors`。
3. 在线检索按 `(file_id, scene_id)` 做 MaxSim，最佳帧提供分数和证据，`video_segment` 提供真实时间边界。

旧策略记录如下：

```text
1. 每个 scene 选一个代表帧，取 scene 中点。
2. 代表帧写入 video_segment asset（vector_kind='representative_frame_embedding'）→ video_segment_vectors。
3. 代表帧只进 video_segment_vectors，不重复进 video_frame_vectors。
4. scene 另按 `KEYFRAME_DENSITY` 生成关键帧（video_frame asset，vector_kind='frame_embedding'）→ video_frame_vectors；默认 `dense` 下短 scene 也会补帧，中长 scene 按时长增加，单 scene 最多 10 个额外关键帧，与代表帧不重复。
5. scene 代表帧 asset 与其关键帧 asset 在 media_assets.metadata_json 中共享同一 scene_id（不新增 DB 列）；固定切片 scene_id 为 null。
```

不在 MVP 中使用简单平均池化作为默认策略。原因是一个 scene 内可能包含镜头移动、主体变化或字幕切换，平均后可能削弱关键视觉信号。

后续允许新增聚合策略：

```text
mean_pooling
max_pooling
weighted_keyframe_pooling
multimodal_segment_embedding
```

新增策略时必须：

- 写入 `vector_kind`。
- 在 payload 中记录 `aggregation_strategy`。
- 保留可重建输入，例如代表帧或参与聚合的 frame asset IDs。

## Payload Index

需要为常用过滤字段建立 Qdrant payload index：

```text
library_id
file_id
media_type
asset_type
model_name
model_version
vector_kind
index_profile
start_time_seconds
end_time_seconds
```

这样可以支持：

- 只搜索某个 library。
- 只搜索某个 media type。
- 只搜索某个文件的片段。
- 只搜索某个模型版本的向量。
- 只搜索某个时间范围。
- 区分 light、balanced、dense 索引结果。

## PostgreSQL 引用结构

`vector_refs` 表是 PostgreSQL 和 Qdrant 的连接点。

字段：

```text
id
asset_id
collection_name
point_id
model_name
model_version
vector_kind
vector_dim
distance_metric
content_hash
index_profile
status
created_at
updated_at
```

状态：

```text
pending
indexed
failed
stale
deleted
```

约束：

```text
unique(collection_name, point_id)
```

由于 `point_id` 本身由 `(asset_id, collection_name, model_name, model_version, vector_kind, content_hash)` 确定性生成，`unique(collection_name, point_id)` 已隐含保证同一 asset 在同一模型版本下不会产生重复向量。

用途：

- 查询某个 asset 是否已经索引。
- 模型升级时找到旧版本向量。
- 文件变更时标记旧向量为 stale。
- 删除文件时找到 Qdrant points 并删除。

## 可选模型表

MVP 可以先用代码中的 collection registry。真实模型接入后，建议添加：

```text
embedding_models
- id
- name
- version
- modality
- vector_dim
- distance_metric
- provider
- status
- created_at

vector_collections
- id
- collection_name
- modality
- vector_kind
- model_id
- qdrant_collection_name
- status
- created_at
```

这些表用于记录模型和 collection 的版本关系。它们不是 MVP 的强制前置条件，但进入真实 embedding 阶段前应补齐。

## 写入流程

向量写入流程：

```text
1. 从 PostgreSQL 读取 media_asset。
2. 读取对应缓存或源文件片段。
3. `index_media` 创建 pending `vector_refs`，不直接写入 Qdrant。
4. TypeScript server 的 `JobsCoordinatorService` 自动扫描 pending `vector_refs`，创建 embedding jobs；显式协调入口保留为补漏/恢复手段。
5. Python worker 执行 embedding job，生成 SigLIP embedding 并校验 vector_dim。
6. Python worker upsert point 到 Qdrant。
7. Python worker 将对应 `vector_refs.status` 更新为 `indexed`。
8. Python worker 更新 job progress。
```

如果 Qdrant 写入成功但 PostgreSQL 写入失败，任务应重试。因为 point id 是确定性的，重试不会产生重复 points。

TypeScript server 不负责写入 point。它负责 collection 管理、搜索读取和结果回表。

## 查询流程

搜索流程：

```text
1. 根据 query 和 media_types 选择 collections。
2. TypeScript Retrieval Service 通过 Model Gateway 调用 localhost Python model service 生成 query embedding。
3. 对每个 collection 执行 Qdrant search。
4. 使用 payload filter 限制 library、media type、model version 等条件。
5. 收集 point payload 中的 asset_id。
6. 回 PostgreSQL 查询完整 media file 和 asset metadata。
7. 合并相邻视频命中。
8. 返回统一 SearchResult。
```

Qdrant 返回的 payload 不应直接作为最终 UI 数据。最终响应必须回 PostgreSQL 补齐事实数据。

## 删除与重建

### 文件删除

当扫描发现文件不存在：

```text
1. 将 media_files 标记为 deleted 或 disabled。
2. 查找该文件下所有 media_assets。
3. 查找对应 vector_refs。
4. 删除 Qdrant points 或标记 vector_refs 为 deleted。
```

MVP 可以先标记为 deleted，后续后台清理 Qdrant points。

### 文件变更

当 path 相同但 size 或 mtime 变化：

```text
1. 将旧 assets 标记为 stale。
2. 将旧 vector_refs 标记为 stale。
3. 创建新的 probe/index job。
4. 新向量写入新 point_id。
```

### 模型升级

当 embedding 模型变化：

```text
1. 新建 model_version。
2. 新建或重建 collection。
3. 后台重新生成 vectors。
4. Search 默认使用 active model_version。
5. 旧版本保留到新版本验证完成后再清理。
```

## MVP 简化

MVP 可以先做：

- `image_vectors`
- `video_segment_vectors`
- deterministic mock vectors
- `vector_refs`
- collection registry
- 基础 payload index

MVP 不强制实现：

- `embedding_models` 表。
- `vector_collections` 表。
- named vectors。
- 多模型并行搜索。
- 自动模型升级流程。

这些能力应在真实 embedding 接入前或接入时补齐。
