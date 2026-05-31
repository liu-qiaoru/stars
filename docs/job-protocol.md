# Job Protocol

## 目标

本文档定义 TypeScript server 与 Python worker 之间的任务协议。TypeScript 负责创建 job、维护 schema 和业务状态；Python worker 负责 claim job、校验 input、执行媒体/模型任务、写回 result。

核心原则：

- TypeScript 是 schema 的事实来源。
- Python worker 不维护独立 ORM 模型。
- Python worker 使用 raw SQL 或极薄 query helper，只访问明确允许的表和字段。
- 每个 `job_type` 必须定义 `input_json` 和 `result_json` 结构。
- Python worker 启动和 CI 阶段必须校验 job protocol 与数据库字段是否可用。

## Schema 同步策略

推荐策略：

```text
packages/shared
  -> Zod job schemas
  -> 生成 JSON Schema
  -> Python worker 用 jsonschema 校验 input_json
```

Python 侧不手写 SQLAlchemy model，避免 Drizzle schema 变更后出现双 ORM 不一致。Python 只写明确 SQL，并把字段访问集中在 repository/helper 文件中。

Phase 3 必须交付：

- Drizzle schema。
- `packages/shared` 中的 job input/output Zod schemas。
- 生成给 Python worker 使用的 JSON Schema。
- Python worker job input 校验。
- 一个 schema consistency test，验证关键表字段存在。

## Job 生命周期

状态：

```text
queued
running
succeeded
failed
cancel_requested
cancelled
stale
```

推荐字段：

```text
id
job_type
status
priority
attempt
max_attempts
locked_by
locked_at
heartbeat_at
timeout_seconds
input_json
result_json
error_message
created_at
updated_at
finished_at
```

Claim 规则：

```sql
SELECT id
FROM jobs
WHERE status = 'queued'
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Claim 后立即写入：

```text
status = running
locked_by = worker id
locked_at = now
heartbeat_at = now
attempt = attempt + 1
```

超时回收：

```text
running 且 heartbeat_at 超过 timeout_seconds 的 job 可重新标记为 queued 或 failed。
```

取消：

```text
TypeScript server 将 status 写为 cancel_requested。
Python worker 在任务边界检查该状态，尽快停止并写为 cancelled。
```

## Job Types

### scan_library

Input：

```json
{
  "library_id": "uuid",
  "root_path": "/Volumes/Media",
  "scan_mode": "mtime_size"
}
```

Result：

```json
{
  "discovered": 1240,
  "created": 1200,
  "updated": 40,
  "skipped": 0,
  "failed": 0
}
```

Python worker 可写字段：

```text
media_files
jobs.status
jobs.progress
jobs.result_json
jobs.error_message
jobs.heartbeat_at
```

### probe_media

Input：

```json
{
  "file_id": "uuid",
  "path": "/Volumes/Media/video.mp4",
  "media_type": "video"
}
```

Result：

```json
{
  "duration_seconds": 360.0,
  "width": 1920,
  "height": 1080,
  "codec": "h264",
  "streams": 2
}
```

Python worker 可写字段：

```text
media_files.duration_seconds
media_files.width
media_files.height
media_files.codec
media_files.index_status
jobs.*
```

### index_media

Input：

```json
{
  "file_id": "uuid",
  "index_profile": "balanced",
  "segment_strategy": "fixed_30s"
}
```

Result：

```json
{
  "assets_created": 120,
  "vector_refs_created": 120,
  "collections": ["video_segment_vectors"]
}
```

Python worker 可写字段：

```text
media_assets
vector_refs
jobs.*
```

触发关系：

```text
1. TypeScript server 创建 index_media job。
2. Python worker 执行 index_media，创建 assets、pending vector_refs，并在 mock 阶段写入 mock vectors。
3. 真实 embedding 阶段，index_media 完成后，TypeScript server 或索引协调任务扫描 pending vector_refs。
4. 协调任务按 collection 和 asset_type 创建 embed_image、embed_video_frame 或 text embedding jobs。
```

推荐该解耦方式，避免 index_media 同时承担资产生成、真实模型推理和下游任务编排。

### embed_image

Input：

```json
{
  "asset_id": "uuid",
  "path": "/Volumes/Media/image.jpg",
  "collection": "image_vectors",
  "model_name": "openclip",
  "model_version": "ViT-B-32-laion2b"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "image_vectors",
  "vector_dim": 512,
  "model_name": "openclip",
  "model_version": "ViT-B-32-laion2b"
}
```

### embed_video_frame

Input：

```json
{
  "asset_id": "uuid",
  "frame_path": ".media-agent/cache/frames/file/frame.jpg",
  "collection": "video_frame_vectors",
  "model_name": "openclip",
  "model_version": "ViT-B-32-laion2b"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "video_frame_vectors",
  "vector_dim": 512,
  "model_name": "openclip",
  "model_version": "ViT-B-32-laion2b"
}
```

### scene_detection

Input：

```json
{
  "file_id": "uuid",
  "path": "/Volumes/Media/video.mp4",
  "index_profile": "balanced"
}
```

Result：

```json
{
  "scenes_detected": 15,
  "keyframes_selected": 30,
  "assets_created": 15
}
```

### transcribe_audio

Input：

```json
{
  "file_id": "uuid",
  "path": "/Volumes/Media/video.mp4",
  "model": "faster-whisper",
  "language": "auto"
}
```

Result：

```json
{
  "chunks_created": 42,
  "language": "zh",
  "duration_seconds": 360.0
}
```

### run_ocr

Input：

```json
{
  "asset_ids": ["uuid"],
  "engine": "paddleocr"
}
```

Result：

```json
{
  "assets_processed": 1,
  "text_blocks_created": 12
}
```

### export_clip

Input：

```json
{
  "file_id": "uuid",
  "path": "/Volumes/Media/video.mp4",
  "start_time_seconds": 120.0,
  "end_time_seconds": 150.0,
  "mode": "fast"
}
```

Result：

```json
{
  "export_path": ".media-agent/exports/clips/job-id.mp4",
  "duration_seconds": 30.0
}
```

## Python Worker 写入边界

Python worker 可以：

- claim 和更新 `jobs`。
- 写入媒体探测结果。
- 创建 `media_assets`。
- 创建或更新 `vector_refs`。
- 写入 transcript / OCR 结果。
- 写入 clip export 结果。
- upsert Qdrant points，并写回 `vector_refs`。

Python worker 不可以：

- 修改 library 配置。
- 修改 API contract。
- 直接改变 schema。
- 删除用户源文件。
- 调用外部多模态模型，除非 TypeScript server 创建了明确 job。

## Qdrant 写入边界

Python worker 负责写入 Qdrant points：

- Phase 5 mock vectors 由 Python worker 写入 Qdrant。
- Phase 10 真实 embeddings 由 Python worker 写入 Qdrant。
- Python worker 写入成功后更新 `vector_refs`。

TypeScript server 负责：

- 创建和删除 Qdrant collections。
- 管理 collection registry。
- 执行 Qdrant search。
- 回 PostgreSQL 补齐结果 metadata。

这样可以避免在 TypeScript 和 Python 之间传递大向量数组，也避免 mock 写入和真实写入分属两个进程。
