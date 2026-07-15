# API 契约

本文档定义第一版 Next.js 前端与 TypeScript / NestJS 后端之间的 HTTP 契约。除非实现过程中发现具体冲突，字段名在 MVP 中保持稳定。

## 通用类型

Job status：

```json
"queued" | "running" | "succeeded" | "failed"
```

Media type：

```json
"image" | "video" | "audio" | "document" | "unknown"
```

Error response：

```json
{
  "detail": "Human readable error message"
}
```

## GET /health

返回后端健康状态。

Response：

```json
{
  "status": "ok",
  "dependencies": {
    "database": "ok",
    "qdrant": "ok"
  }
}
```

## POST /libraries

注册一个本地媒体目录。

Request：

```json
{
  "name": "Main Media Drive",
  "root_path": "/Volumes/Media"
}
```

Response：

```json
{
  "id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e",
  "name": "Main Media Drive",
  "root_path": "/Volumes/Media",
  "enabled": true,
  "created_at": "2026-05-26T10:00:00Z",
  "updated_at": "2026-05-26T10:00:00Z"
}
```

## GET /libraries

列出已注册的 libraries。

Response：

```json
{
  "items": [
    {
      "id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e",
      "name": "Main Media Drive",
      "root_path": "/Volumes/Media",
      "enabled": true,
      "media_count": 1240,
      "indexed_count": 300,
      "failed_count": 2
    }
  ]
}
```

`indexed_count` 统计 `media_files.index_status='indexed'` 的 active 文件。任意一个 active vector ref 成功写入 Qdrant 后，worker 会在同一事务中把对应文件标记为 indexed；不要求该文件所有 vector refs 都完成。升级前已有 indexed refs 的文件由 `0002_backfill_indexed_media_files.sql` 回填。

## GET /libraries/{id}

返回单个 library。

Response：

```json
{
  "id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e",
  "name": "Main Media Drive",
  "root_path": "/Volumes/Media",
  "enabled": true,
  "created_at": "2026-05-26T10:00:00Z",
  "updated_at": "2026-05-26T10:00:00Z"
}
```

## GET /libraries/{id}/media

按素材库分页返回 active media files。`limit` 默认 25、范围 1～100；`offset` 默认 0，必须为非负整数；可选 `query` 按 `relative_path` 做不区分大小写的包含筛选。结果按 `relative_path`、`id` 稳定升序，供素材库浏览和评测目标选择器复用。

Response：

```json
{
  "items": [
    {
      "id": "6a9f...",
      "relative_path": "Movies/concert.mp4",
      "media_type": "video",
      "index_status": "indexed"
    }
  ],
  "total": 1240,
  "limit": 25,
  "offset": 0
}
```

library 不存在返回 404；非法分页参数返回 400。软删除文件不返回。

## PATCH /libraries/{id}/disable

禁用一个 library。禁用后不再主动创建新的 scan job，但历史媒体记录保留。

Response：

```json
{
  "id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e",
  "name": "Main Media Drive",
  "root_path": "/Volumes/Media",
  "enabled": false,
  "created_at": "2026-05-26T10:00:00Z",
  "updated_at": "2026-05-26T10:10:00Z"
}
```

## DELETE /libraries/{id}

软删除一个 library。MVP 不立即删除源文件，也不删除本地缓存文件；后续清理策略单独处理。

Response：

```json
{
  "deleted": true
}
```

## POST /libraries/{id}/scan

为一个 library 启动扫描任务。

Response：

```json
{
  "job_id": "cdb55173-624f-4ba9-b1d5-f6d0c0f2b1fb",
  "status": "queued"
}
```

## GET /jobs

分页列出 jobs，按 `created_at` 倒序返回。

Query：

- `limit`：可选，默认 `100`，最大 `500`
- `offset`：可选，默认 `0`

`file_paths` 是该任务关联的本地文件路径列表。Server 会优先读取 job input 中的 `path`、`frame_path`、`root_path`，也会按 `file_id`、`asset_id`、`asset_ids` 回表补齐 `media_files.path`。

Response：

```json
{
  "total": 160,
  "limit": 100,
  "offset": 0,
  "items": [
    {
      "id": "cdb55173-624f-4ba9-b1d5-f6d0c0f2b1fb",
      "job_type": "scan_library",
      "status": "running",
      "progress": 42,
      "file_paths": ["/Volumes/Media"],
      "error_message": null,
      "created_at": "2026-05-26T10:01:00Z",
      "updated_at": "2026-05-26T10:02:00Z"
    }
  ]
}
```

## GET /jobs/{id}

返回单个 job。

Response：

```json
{
  "id": "cdb55173-624f-4ba9-b1d5-f6d0c0f2b1fb",
  "job_type": "scan_library",
  "status": "succeeded",
  "progress": 100,
  "input": {
    "library_id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e"
  },
  "result": {
    "discovered": 1240,
    "created": 1240,
    "updated": 0,
    "skipped": 0
  },
  "error_message": null,
  "created_at": "2026-05-26T10:01:00Z",
  "updated_at": "2026-05-26T10:05:00Z"
}
```

## POST /jobs/embedding/queue-pending

手动补漏入口。默认运行时 `JobsCoordinatorService` 会自动扫描 pending `vector_refs` 并创建下游 worker jobs；该接口用于 worker 中断、Qdrant 重建或排查时主动补队列。接口不传递向量数据，只创建 `embed_image` 或 `embed_video_frame` jobs。

Request：

```json
{
  "limit": 100
}
```

Response：

```json
{
  "scanned": 2,
  "created": 2,
  "skipped": 0
}
```

## POST /jobs/ocr/queue-pending

扫描待 OCR 的 `image` / `video_frame` asset（`text_content IS NULL` 或 `metadata_json` 无 `ocr` 标记），按 `library_id` / `file_id` 过滤后批量创建 `run_ocr` jobs。不强制全库执行。为避免失败循环，同一 asset 只要已有 `run_ocr` 尝试记录（queued/running/succeeded/failed），自动补队列会跳过；重新 OCR 需要后续显式重置/force 入口。

Request：

```json
{
  "library_id": "uuid",
  "file_id": "uuid",
  "batch_size": 20,
  "limit": 100
}
```

`library_id` / `file_id` 可选（不传则全库扫描）；`batch_size` 为单个 `run_ocr` job 的 asset 数量上限；`limit` 为本次最多扫描的待 OCR asset 数量。

Response：

```json
{
  "scanned": 50,
  "created": 3,
  "skipped": 0
}
```

## POST /search

搜索已索引的 media assets。

Request：

```json
{
  "query": "red car on road",
  "media_types": ["image", "video"],
  "library_ids": [],
  "limit": 20,
  "offset": 0,
  "query_expansion_mode": "translate",
  "include_diagnostics": false
}
```

Response：

```json
{
  "limit": 20,
  "offset": 0,
  "results": [
    {
      "asset_id": "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
      "merged_asset_ids": [
        "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
        "asset-uuid"
      ],
      "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
      "media_type": "video",
      "path": "/Volumes/Media/video.mp4",
      "start_time_seconds": 120.0,
      "end_time_seconds": 150.0,
      "scene_id": "scene-0007",
      "score": 0.91,
      "score_kind": "hybrid_score",
      "primary_reason": "transcript_match",
      "confidence": "high",
      "reasons": ["vector_match", "transcript_match"],
      "source_scores": {
        "video_segment_vectors": 0.82,
        "video_frame_vectors": 0.76,
        "text_search": 0.16
      }
    }
  ],
  "groups": [
    {
      "collection": "video_segment_vectors",
      "score_kind": "cosine_similarity",
      "results": [
        {
          "asset_id": "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
          "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
          "media_type": "video",
          "path": "/Volumes/Media/video.mp4",
          "start_time_seconds": 120.0,
          "end_time_seconds": 150.0,
          "scene_id": "scene-0007",
          "score": 0.82,
          "reason": "vector_match"
        }
      ]
    },
    {
      "collection": "text_search",
      "score_kind": "ts_rank_cd",
      "results": [
        {
          "asset_id": "asset-uuid",
          "file_id": "file-uuid",
          "media_type": "audio",
          "path": "/Volumes/Media/interview.mp3",
          "start_time_seconds": 30.0,
          "end_time_seconds": 55.0,
          "scene_id": null,
          "score": 0.16,
          "reason": "transcript_match"
        },
        {
          "asset_id": "ocr-asset-uuid",
          "file_id": "image-file-uuid",
          "media_type": "image",
          "path": "/Volumes/Media/poster.png",
          "start_time_seconds": null,
          "end_time_seconds": null,
          "scene_id": null,
          "score": 0.21,
          "reason": "ocr_match"
        }
      ]
    }
  ]
}
```

`POST /search` 返回 `{ limit, offset, results, groups }`。`results` 是统一 hybrid retrieval + reranking 后的主结果列表，使用 `score_kind='hybrid_score'`；`groups` 保留为原始来源分组，用于兼容旧响应形状和调试召回质量。

向量 group 来自 Qdrant。`video_frame_vectors` 在 top-level `results` 中按 `(file_id, scene_id)` 做 MaxSim，最大 cosine 的帧作为代表证据，时间边界来自 PostgreSQL `video_segment`；原始 `groups` 继续保留逐帧结果。`video_segment_vectors` 仅由 `VIDEO_SEGMENT_SEARCH_ENABLED=true` 的迁移兼容期开启，新索引不再创建该 ref。`text_search` group 来自 `media_assets.text_tsv`：`text_chunk` 为 transcript 命中，`image`/`video_frame` 为 OCR 命中。

- top-level result 使用 `primary_reason`、`confidence`、`reasons`、`source_scores` 和 `merged_asset_ids` 表达命中解释。`confidence='low'` 表示当前只找到弱视觉向量候选，前端应提示“相关性较弱”；带 transcript/OCR 的文本命中或较强视觉向量命中返回 `confidence='high'`。跨 asset 合并时，`asset_id` 是代表命中的 asset，`merged_asset_ids` 总是包含代表 asset，长度至少为 1。
- `query_expansion_mode` 支持 `original | translate | expand`，默认 `expand`。`original` 只使用原查询并完全跳过外部扩展 Provider；`translate` 保留原查询并最多增加一个忠实英文翻译，生成后再独立调用 DeepSeek 校验人物、物体、动作、关系和约束是否等价；缺少译文、校验不通过或校验响应非法都会明确失败，不会静默降级；`expand` 使用完整查询扩展。`translate`/`expand` 仍受 `QUERY_EXPANSION_PROVIDER` 控制：Provider 为 `none` 时实际只使用原查询。`QUERY_EXPANSION_MAX_VARIANTS` 默认是 3，包含原始 query；Prompt 和 Server 标准化都强制该上限。同一 Point 多次命中时保留加权后的最高分。扩展服务返回的基础扩展词权重低于原始 query；仅在 `translate` 模式下，已经通过语义等价校验的英文译文在 SigLIP 视觉 collection 中会提升到 `1.0`，与原查询同权竞争，Caption 等文本 collection 仍使用基础权重。系统不会把本地媒体路径或搜索结果发送给 DeepSeek。
- `include_diagnostics` 默认 `false`。显式设为 `true` 时，响应增加顶层 `query_diagnostics`，并在每个向量 group result 增加 `diagnostics`：`source_rank` 是该来源过滤无效 PostgreSQL 记录后的名次；`query_variant_hits` 保留每个实际查询版本的 `raw_score`、`weight`、`weighted_score` 和唯一 `winning` 标记；Caption 结果还返回 `caption.text` 与 `caption.prompt_version`。Caption 原文属于本地媒体派生内容，只能出现在显式诊断响应中，不得写入普通搜索日志或默认响应。
- 转写命中使用 `transcript_match`，OCR 使用 `ocr_match`，向量使用 `vector_match`。`document_match` 预留给 document pipeline，Phase 14 不主动产生。
- `source_scores` key 使用固定 source key：当前为 `image_vectors`、`video_segment_vectors`、`video_frame_vectors`、`text_search`；后续新增向量来源时使用 Qdrant collection 名。同 source 多次命中时保留最大分数；启用 query expansion 时，向量来源分数会先乘以 query variant 权重。`source_scores` 不能跨 source 直接比较。
- 纯向量弱相关候选不会被静默丢弃；系统会保留候选并标记 `confidence='low'`，避免搜索结果变成空数组又不给用户任何线索。带 transcript/OCR 的文本命中不受该向量置信度阈值影响。
- `offset` 和 `limit` 作用于合并/rerank 后的 top-level `results`，不是单个来源 group。实现会先从各来源 overfetch，再合并、去重、rerank，最后分页。深分页下如果 overfetch 上限被截断且合并折叠较多，返回数量可能少于 `limit`，甚至为空。
- image 和 future document 结果的 `start_time_seconds` / `end_time_seconds` 为 `null`；video/audio 片段返回秒级时间范围。
- `library_ids`、`media_types` 和软删除过滤属于 metadata filters，但普通语义搜索结果不把 `metadata_filter` 当作默认 reason；只有未来 metadata-only 搜索才使用 `metadata_filter`。

## GET /media/{id}

返回单个媒体文件的 metadata 和 assets。

Query：

```text
assets_limit=50
assets_offset=0
include_assets=true
```

Response：

```json
{
  "id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
  "library_id": "8e4b7f3e-40b4-4a9a-8c1e-6d16e7e39a8e",
  "path": "/Volumes/Media/video.mp4",
  "media_type": "video",
  "size_bytes": 734003200,
  "duration_seconds": 360.0,
  "width": 1920,
  "height": 1080,
  "codec": "h264",
  "index_status": "indexed",
  "assets_limit": 50,
  "assets_offset": 0,
  "assets_total": 120,
  "assets": [
    {
      "id": "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
      "asset_type": "video_segment",
      "start_time_seconds": 120.0,
      "end_time_seconds": 150.0,
      "cache_path": null,
      "text_content": null,
      "metadata_json": {
        "scene_id": "scene-0007",
        "keyframe_index": 0,
        "segment_strategy": "scene_detection"
      }
    }
  ]
}
```

## GET /media/{id}/content

按 `media_files.id` 返回数据库记录对应的本地源文件内容，用于前端预览搜索结果和详情页素材。该端点只接受已入库的 file id，不接受任意本地 path。

Headers：

- 支持 `Range: bytes=start-end`，视频/音频预览会返回 `206 Partial Content`
- 返回 `Content-Type`、`Content-Length`、`Accept-Ranges`

## POST /clips/export

创建一个 clip export job。

Request：

```json
{
  "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
  "start_time_seconds": 120.0,
  "end_time_seconds": 150.0,
  "output_format": "mp4"
}
```

Response：

```json
{
  "job_id": "57c0e91b-4112-4791-8b0c-af67c4d01aa0",
  "status": "queued"
}
```

Completed job result：

```json
{
  "export_path": ".media-agent/exports/clips/54b83d84-7ff5-4b9a-8d11-fb27fbaf44db-120-150.mp4",
  "duration_seconds": 30.0
}
```

## POST /agent/runs

启动一次单次 agent task。

Request：

```json
{
  "prompt": "Find clips that look like a product launch presentation.",
  "allow_external_vlm": false
}
```

Agent run 事件结构：

```json
{
  "event_id": "01J...",
  "run_id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "type": "tool_call_started",
  "created_at": "2026-05-26T10:06:00Z",
  "payload": {
    "tool_name": "search_media",
    "summary": "Searching video segments."
  }
}
```

事件类型：

```json
"run_started" | "tool_call_started" | "tool_call_finished" | "candidate_results" | "user_confirmation_required" | "user_confirmation_pending" | "run_succeeded" | "run_failed"
```

`user_confirmation_required` 事件用于副作用工具（`export_clip`、`create_index_job`）。LLM 提出操作建议后，AgentService 不直接执行，而是写入该事件等待前端确认。前端通过 `POST /agent/runs/{id}/confirm` 确认后才创建实际 job。

MVP 可以通过轮询 `GET /agent/runs/{id}` 返回累计事件。后续 SSE 或 WebSocket 应复用同一事件结构。

Response：

```json
{
  "run_id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "succeeded"
}
```

## GET /agent/runs/{id}

返回 agent run 状态和结果。

Response：

```json
{
  "id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "succeeded",
  "prompt": "Find clips that look like a product launch presentation.",
  "tool_calls": [
    {
      "tool_call_id": "search-1",
      "name": "search_media",
      "status": "succeeded",
      "summary": "search_media completed",
      "requires_confirmation": false
    }
  ],
  "events": [
    {
      "event_id": "01J...",
      "type": "tool_call_finished",
      "tool_call_id": "search-1",
      "created_at": "2026-05-26T10:06:10Z",
      "payload": {
        "tool_name": "search_media",
        "summary": "Found candidate video segments."
      }
    }
  ],
  "results": [
    {
      "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
      "asset_id": "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
      "start_time_seconds": 120.0,
      "end_time_seconds": 150.0,
      "score": 0.82,
      "summary": "Candidate segment from a stage presentation."
    }
  ]
}
```

## POST /agent/runs/{id}/confirm

确认一个等待用户确认的副作用操作（例如 `export_clip` 或 `create_index_job`）。LLM 提出操作建议后，AgentService 写入 `user_confirmation_required` 事件但不创建 job。前端展示确认 UI，用户确认后调用此端点。

Request：

```json
{
  "tool_call_id": "01J..."
}
```

Response：

```json
{
  "job_id": "cdb55173-624f-4ba9-b1d5-f6d0c0f2b1fb",
  "status": "queued"
}
```

如果 `tool_call_id` 不存在或已确认，返回 HTTP 404。如果对应的 tool call 不需要确认（例如只读工具），返回 HTTP 400。

## 外部 LLM 未启用时的行为

`ALLOW_EXTERNAL_LLM=false`（默认）时，`POST /agent/runs` 仍然接受请求，但不调用外部 LLM provider。AgentService 返回提示信息，说明当前未启用外部 LLM，用户可在设置中开启。不返回 HTTP 500 或配置错误。

Response（`ALLOW_EXTERNAL_LLM=false`）：

```json
{
  "run_id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "succeeded",
  "message": "外部大模型未启用；已记录任务，但不会调用云端模型。"
}
```

## 视频索引迁移接口

`POST /jobs/video/reindex` 为现有 active 视频分批创建 `index_media` 任务。body 支持 `library_id`、`file_id`、`limit`（1～1000）、`dry_run` 和 `only_not_ready`；已有 queued/running `index_media` 的文件会计入 `skipped_active`，不会重复创建。

`GET /jobs/video/reindex-readiness` 返回视觉切换门槛：`segments_without_frames`、`segments_over_30_seconds`、`active_video_segment_vector_refs` 均为 0 时 `ready=true`。`segments_without_scene_caption_v2` 单独表示 caption 完整度；它会让默认 reindex 继续选中该文件，但不阻断 frame MaxSim 的视觉切换。

## 检索评测 API

`/evaluation` 是仅供本地维护者使用的评测域，不改变普通 `/search` 的生产排序。

- `GET /evaluation/sets`：列出评测集及最新版本。
- `GET /evaluation/targets/random`：按可选 `library_id`、`limit`（最大 20）和 `seed` 返回已索引图片与稳定视频 scene 的随机目标。相同 seed 返回稳定顺序；响应只含媒体身份、路径与时间范围，不返回 Caption、OCR 或 Transcript。同一视频一批最多返回一个 scene。
- `POST /evaluation/sets`：创建评测集和首个草稿版本。
- `GET /evaluation/versions/{id}`：读取版本与查询。
- `POST /evaluation/versions/{id}/queries`：向草稿版本添加查询。必须提供查询文本、类型、意图分类和非空的必须满足条件。
- `POST /evaluation/versions/{id}/freeze`：冻结非空版本；冻结后不可修改。
- `POST /evaluation/versions/{id}/runs`：使用 `library_ids` 启动基线运行。基线固定关闭查询扩展和 `video_segment_vectors`，每路深度为 20，RRF `k=60`，visual/caption/lexical 权重均为 1。
- `GET /evaluation/runs/{id}`：读取运行与盲标候选。未标候选默认不返回来源证据、分数和排名；诊断读取可传 `reveal_evidence=true`。
- `POST /evaluation/runs/{run_id}/candidates/{candidate_id}/judgment`：幂等保存 `relevance=0|1|2` 或 `unjudgeable=true`，可附加诊断与备注。
- `POST /evaluation/runs/{id}/finalize`：全部主池候选完成判断后计算 current/RRF 报告。

运行状态为 `pending | retrieving | ready_for_labeling | labeled | reported | failed`。所需来源、元数据或场景边界失败时必须进入 `failed`，不得省略来源后生成成功报告。RRF score 只是排序值，不是概率或百分比。
