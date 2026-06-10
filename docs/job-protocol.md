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

## Python worker 启动与 Phase 4 扫描策略

启动命令：

```bash
PYTHONPATH=apps/worker-py python3.12 -m media_agent_worker
```

Phase 4 worker 默认单进程循环：

1. 从 PostgreSQL claim 一个 `queued` job。
2. 将 job 标记为 `running`，写入 `locked_by`、`locked_at` 和 `heartbeat_at`。
3. 执行 `scan_library` 时递归遍历本地目录。
4. 执行期间写 heartbeat；完成后写入 `result_json` 并标记 `succeeded`。
5. 收到 `SIGINT` 或 `SIGTERM` 后停止 claim 新 job，当前 job 到安全边界后结束。

MVP 扫描幂等策略为 `path + size + mtime`：

- 路径不存在于 `media_files` 时插入新记录。
- 路径已存在且 size/mtime 不变时计为 skipped。
- 路径已存在但 size 或 mtime 变化时更新记录并将 `index_status` 置回 `pending`。

该策略可能漏掉保留 mtime 和 size 的原地改写。后续 content hash rescan 只在用户手动触发或重点目录上执行，避免默认全库 hash 带来高 I/O。

## Phase 5/10 索引边界

Phase 5 建立索引骨架，Phase 10 起切换为真实 SigLIP embedding。TypeScript server 与 Python worker 的写入边界保持不变：

- TypeScript server 维护 Qdrant collection registry，并负责初始化缺失 collection。
- TypeScript server 不生成或传递大向量数组。
- Python worker 执行 `probe_media` 和 `index_media`。
- Python worker 为图片、视频 scene（或固定 30s fallback）创建 `media_assets`。
- Phase 10 起，`index_media` 只创建 pending `vector_refs`；真实向量由下游 embedding jobs 写入 Qdrant。
- `point_id` 使用 deterministic UUID，输入包含 `asset_id`、collection、model name/version、vector kind 和 content hash。

### 管线触发链

Python worker 负责管线内部的 job 链式触发，区别于 TypeScript server 的用户 API 层面 job 创建：

```text
scan_library 完成 → 为每个 created/updated file 创建 probe_media job
probe_media 完成 → 为该 file 创建 index_media job（视频默认 segment_strategy='scene_detection'，图片为 image 路径）
index_media 完成 → 创建 assets 和 pending vector_refs
POST /jobs/embedding/queue-pending → 为 pending vector_refs 创建 embed_image / embed_video_frame jobs
embedding job 完成 → Qdrant point 已写入，vector_ref.status = indexed
```

`media_files.index_status` 状态流转：

```text
pending → probed（probe_media 完成后由 worker 写入）
probed → indexed（真实 embedding 完成后）
```

`probed` 表示文件 metadata（duration、width、height、codec）已探测完毕，可以创建 index job。scene detection 在 `index_media` 内部完成，不引入新的 `index_status`。

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
media_files.index_status（probe 完成后写入 'probed'）
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

`segment_strategy` 取值：

- `fixed_30s`：固定 30 秒切片（Phase 5/10 默认）。
- `scene_detection`：Phase 11。用 PySceneDetect 检测 scene 边界替代固定切片。每个 scene 生成 1 个代表帧（中点）`video_segment` asset → `video_segment_vectors`，并按 scene 时长生成 0-2 个关键帧 `video_frame` asset → `video_frame_vectors`（关键帧与代表帧不重复）。scene 短于 `SCENE_MIN_SECONDS`（默认 3s）时并入相邻 scene。PySceneDetect 抛错、检测到 0 个 scene 或 scene 数超过上限（默认 2000）时回退 `fixed_30s`。详见 `docs/implementation-plan.md` Phase 11。

仅视频受 `segment_strategy` 影响；图片固定走 `image_vectors` 单 asset 路径。

Result：

```json
{
  "assets_created": 120,
  "vector_refs_created": 120,
  "collections": ["video_segment_vectors", "video_frame_vectors"],
  "segment_strategy": "scene_detection",
  "fallback": false
}
```

`segment_strategy` 记录实际使用的策略（fallback 触发时为 `fixed_30s` 且 `fallback=true`）。

Python worker 可写字段：

```text
media_assets（scene/keyframe/strategy 写入 metadata_json）
vector_refs
jobs.*
```

触发关系：

```text
1. TypeScript server 创建 index_media job。
2. Python worker 执行 index_media，按 segment_strategy 创建 assets（图片为 image；视频为 video_segment + video_frame）和 pending vector_refs。重索引/策略切换时先失效该 file 下旧 video_segment/video_frame assets 及 vector_refs。
3. TypeScript server 的索引协调入口扫描 pending vector_refs。
4. 协调任务按 collection 和 asset_type 创建 embed_image 或 embed_video_frame jobs。
```

推荐该解耦方式，避免 index_media 同时承担资产生成、真实模型推理和下游任务编排。

### embed_image

Input：

```json
{
  "asset_id": "uuid",
  "path": "/Volumes/Media/image.jpg",
  "collection": "image_vectors",
  "model_name": "google/siglip-base-patch16-224",
  "model_version": "siglip-base-patch16-224"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "image_vectors",
  "vector_dim": 768,
  "model_name": "google/siglip-base-patch16-224",
  "model_version": "siglip-base-patch16-224"
}
```

### embed_video_frame

Input：

```json
{
  "asset_id": "uuid",
  "frame_path": "/Volumes/Media/video.mp4",
  "frame_time_seconds": 45.0,
  "collection": "video_segment_vectors",
  "model_name": "google/siglip-base-patch16-224",
  "model_version": "siglip-base-patch16-224"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "video_segment_vectors",
  "vector_dim": 768,
  "model_name": "google/siglip-base-patch16-224",
  "model_version": "siglip-base-patch16-224"
}
```

### export_clip

Input：

```json
{
  "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
  "start_time_seconds": 120.0,
  "end_time_seconds": 150.0,
  "output_format": "mp4"
}
```

约束：

- `end_time_seconds` 必须大于 `start_time_seconds`。
- Phase 8 只支持视频文件导出。
- TypeScript server 只创建 `export_clip` job，不读取源媒体，也不运行 FFmpeg。
- Python worker 根据 `file_id` 回 PostgreSQL 查询源文件路径，然后用 FFmpeg stream copy 导出。

Result：

```json
{
  "export_path": ".media-agent/exports/clips/54b83d84-7ff5-4b9a-8d11-fb27fbaf44db-120-150.mp4",
  "duration_seconds": 30.0
}
```

Python worker 可写字段：

```text
jobs.status
jobs.progress
jobs.result_json
jobs.error_message
jobs.heartbeat_at
```

> Scene detection 不是独立 job。它是 `index_media` 的 `segment_strategy='scene_detection'` 分支，见上文 `index_media` 与 `docs/implementation-plan.md` Phase 11。

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

- Phase 10 真实 embeddings 由 Python worker 写入 Qdrant。
- Python worker 写入成功后更新 `vector_refs`。

TypeScript server 负责：

- 创建和删除 Qdrant collections。
- 管理 collection registry。
- 执行 Qdrant search。
- 回 PostgreSQL 补齐结果 metadata。

这样可以避免在 TypeScript 和 Python 之间传递大向量数组，也避免索引协调逻辑和真实模型推理耦合在同一个 job 中。
