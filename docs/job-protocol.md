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

协调器创建的 `embed_image`、`embed_video_frame` 和 `embed_text_asset` 使用优先级 `10`；
扫描、探测、转录和 Caption 默认优先级为 `0`。这样大素材库先把已生成的 Asset 写成可检索
Qdrant Point，再继续处理较慢的 Caption 队列；高优先级只改变领取顺序，不跳过或取消低
优先级任务。

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

## 当前索引边界

TypeScript server 与 Python worker 的写入边界如下：

- TypeScript server 维护 Qdrant collection registry，并负责初始化缺失 collection。
- TypeScript server 不生成或传递大向量数组。
- Python worker 执行 `probe_media` 和 `index_media`。
- Python worker 为图片创建 `image` asset；为视频创建 `video_scenes` 行和引用场景 UUID 的 `video_frame` asset。
- `index_media` 只创建 pending `vector_refs`；真实向量由下游 embedding jobs 写入 Qdrant。
- `point_id` 使用 deterministic UUID，输入包含 `asset_id`、collection、model name/version、vector kind 和 content hash。

### 管线触发链

Python worker 负责管线内部的 job 链式触发，区别于 TypeScript server 的用户 API 层面 job 创建：

```text
scan_library 完成 → 为每个 created/updated file 创建 probe_media job
probe_media 完成 → 对视频并行创建 index_media + transcribe_audio job；对音频只创建 transcribe_audio job；对图片创建 index_media job
index_media 完成 → 创建 assets 和 pending vector_refs
transcribe_audio 完成 → 创建 text_chunk assets（text_content + start/end），FTS tsvector 由生成列自动维护
JobsCoordinatorService 自动扫描 pending vector_refs → 创建 embed_image / embed_video_frame / embed_text_asset jobs
POST /jobs/embedding/queue-pending → 手动补漏，为 pending vector_refs 创建 embed_image / embed_video_frame / embed_text_asset jobs
embedding job 完成 → Qdrant point 已写入，vector_ref.status = indexed
index_media 完成 → Caption 开启时为图片或每个视频场景创建 generate_caption job
generate_caption 完成 → 创建 caption asset 和 pending caption_text_vectors ref
```

`media_files.index_status` 状态流转：

```text
pending → probed（probe_media 完成后由 worker 写入）
probed → indexed（任意一个 active vector ref 首次真实 embedding 成功并写入 Qdrant 后）
```

`probed` 表示文件 metadata（duration、width、height、codec）已探测完毕，可以创建 index job。scene detection 在 `index_media` 内部完成，不引入新的 `index_status`。

`mark_vector_ref_indexed(point_id)` 在同一数据库事务中更新 `vector_refs.status` 和对应 `media_files.index_status`。Phase 7 使用空库重建，不导入旧 vector ref，因此不再需要历史回填迁移。其余 pending/failed refs 不阻止文件被计为“已索引”，因为至少一个成功向量已经使该文件可检索。

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
  "index_profile": "balanced"
}
```

图片创建一个 `image` Asset 和一个 `image_vectors` pending Vector Ref。视频必须通过
PySceneDetect 生成正式 `video_scenes`；短于 0.5 秒的噪声场景合并，超过 30 秒的场景拆窗，
随后每 2.5 秒创建一个引用正式 `scene_id` 的 `video_frame` Asset。检测器不可用或视频解码
失败时任务结构化失败，不再回退固定窗口，也不再创建 `video_segment`。

Result：

```json
{
  "assets_created": 120,
  "vector_refs_created": 120,
  "collections": ["video_frame_vectors"],
  "scenes_detected": 30,
  "frames_created": 120
}
```

Python worker 可写字段：

```text
video_scenes
media_assets（视频帧通过正式 scene_id 外键引用场景）
vector_refs
jobs.*
```

触发关系：

```text
1. TypeScript server 创建 index_media job。
2. Python Worker 执行 index_media，创建图片 Asset，或创建 `video_scenes`、视频帧 Asset 和 pending Vector Ref。
3. TypeScript server 的 `JobsCoordinatorService` 定期扫描 pending vector_refs。
4. 协调任务按 collection 和 asset_type 创建 embed_image 或 embed_video_frame jobs。`POST /jobs/embedding/queue-pending` 保留为手动补漏入口。
```

推荐该解耦方式，避免 index_media 同时承担资产生成、真实模型推理和下游任务编排。

### embed_image

Input：

```json
{
  "asset_id": "uuid",
  "path": "/Volumes/Media/image.jpg",
  "collection": "image_vectors",
  "model_name": "google/siglip2-base-patch16-224",
  "model_version": "siglip2-base-patch16-224"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "image_vectors",
  "vector_dim": 768,
  "model_name": "google/siglip2-base-patch16-224",
  "model_version": "siglip2-base-patch16-224"
}
```

### embed_video_frame

Input：

```json
{
  "asset_id": "uuid",
  "frame_path": "/Volumes/Media/video.mp4",
  "frame_time_seconds": 45.0,
  "collection": "video_frame_vectors",
  "model_name": "google/siglip2-base-patch16-224",
  "model_version": "siglip2-base-patch16-224"
}
```

Result：

```json
{
  "point_id": "uuid",
  "collection": "video_frame_vectors",
  "vector_dim": 768,
  "model_name": "google/siglip2-base-patch16-224",
  "model_version": "siglip2-base-patch16-224"
}
```

### export_clip

Input：

```json
{
  "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
  "start_time_seconds": 120.0,
  "end_time_seconds": 150.0,
  "output_format": "mp4",
  "export_request_id": "agent-side-effect-uuid（仅 Agent 确认导出提供）"
}
```

约束：

- `end_time_seconds` 必须大于 `start_time_seconds`。
- Phase 8 只支持视频文件导出。
- TypeScript server 只创建 `export_clip` job，不读取源媒体，也不运行 FFmpeg。
- Python worker 根据 `file_id` 回 PostgreSQL 查询源文件路径，然后用 FFmpeg stream copy 导出。
- `export_request_id` 可选；Agent 确认必须提供，用于生成唯一最终文件名。Media Detail 旧入口不提供。
- Worker 使用 FFmpeg `-n` 写唯一 `.partial` 文件；成功后在同一文件系统原子发布，目标已存在时
  明确失败，不使用 `-y`。失败、冲突和成功后都清理 `.partial`。

Result：

```json
{
  "export_path": ".media-agent/exports/clips/agent-side-effect-uuid.mp4",
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
  "media_type": "video",
  "model": "base",
  "language": "auto"
}
```

仅视频/音频适用。worker 用 FFmpeg 抽取音轨到临时文件，再用 faster-whisper 转写，按 15-30 秒窗口把 segments 累积切成 `text_chunk` assets（`asset_type='text_chunk'`，写入 `text_content`、`start_time_seconds`、`end_time_seconds`）。text chunk 不产生 vector_refs（Phase 12 FTS-only，文本 embedding 延后）。详见 `docs/implementation-plan.md` Phase 12。

Result：

```json
{
  "chunks_created": 42,
  "language": "zh",
  "duration_seconds": 360.0
}
```

Python worker 可写字段：

```text
media_assets（asset_type='text_chunk'，写入 text_content / start_time_seconds / end_time_seconds）
jobs.*
```

## Python Worker 写入边界

Python worker 可以：

- claim 和更新 `jobs`。
- 写入媒体探测结果。
- 创建 `media_assets`。
- 创建或更新 `vector_refs`。
- 写入 transcript 和 Caption 结果。
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
