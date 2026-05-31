# 向量索引设计

## 目标

本设计定义 Qdrant 中的 collection、point、payload 结构，以及 PostgreSQL 中用于引用向量的关系数据。目标是让图片、视频、音频和文本检索可以扩展，同时避免把 Qdrant 当成主数据库。

核心原则：

- PostgreSQL 是事实来源。
- Qdrant 只保存向量和轻量 payload。
- 原始文件路径、完整 metadata、transcript、OCR 全文、job 状态都回 PostgreSQL 查询。
- point id 必须可重复生成，支持幂等 upsert。
- 模型名称、模型版本、向量维度和距离算法必须被记录，方便后续重建索引。

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

### text_chunk_vectors

用途：

- 文档、transcript、OCR 文本的语义检索。

典型来源：

- `media_assets.asset_type = text_chunk`

## Collection 配置

每个 collection 必须有明确配置。实现时应在 TypeScript server 中维护一个 collection registry。

示例：

```ts
VECTOR_COLLECTIONS = {
  image_vectors: {
    modality: "image",
    vectorKind: "image_embedding",
    modelName: "openclip",
    modelVersion: "ViT-B-32-laion2b",
    vectorDim: 512,
    distance: "Cosine",
  },
  video_frame_vectors: {
    modality: "video",
    vectorKind: "frame_embedding",
    modelName: "openclip",
    modelVersion: "ViT-B-32-laion2b",
    vectorDim: 512,
    distance: "Cosine",
  },
  video_segment_vectors: {
    modality: "video",
    vectorKind: "segment_embedding",
    modelName: "openclip",
    modelVersion: "ViT-B-32-laion2b",
    vectorDim: 512,
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

`vector_dim` 必须来自实际 embedding 模型，不应硬编码成无法追踪的魔法数字。模型变更时，应创建新版本记录，并重建对应 collection 或对应 points。

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
    "model_name": "openclip",
    "model_version": "ViT-B-32-laion2b",
    "vector_kind": "segment_embedding",
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

MVP 中 `video_segment_vectors` 使用代表帧策略：

```text
1. 每个 video segment 选一个代表帧。
2. 代表帧优先选择 scene 中点。
3. 如果中点帧质量差，再选择最清晰或最接近命中条件的关键帧。
4. segment point 的 `vector_kind` 使用 `representative_frame_embedding`。
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
unique(asset_id, collection_name, model_name, model_version, vector_kind, content_hash)
```

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
3. Python worker 生成 mock vector 或真实 embedding。
4. Python worker 根据 collection registry 的生成副本校验 vector_dim。
5. 生成 deterministic point_id。
6. Python worker upsert point 到 Qdrant。
7. Python worker upsert vector_refs 到 PostgreSQL。
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
