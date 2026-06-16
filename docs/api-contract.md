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

列出最近的 jobs。

Response：

```json
{
  "items": [
    {
      "id": "cdb55173-624f-4ba9-b1d5-f6d0c0f2b1fb",
      "job_type": "scan_library",
      "status": "running",
      "progress": 42,
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

扫描 pending `vector_refs`，为真实视觉 embedding 创建下游 worker jobs。该接口不传递向量数据，只创建 `embed_image` 或 `embed_video_frame` jobs。

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

扫描待 OCR 的 `image` / `video_frame` asset（`text_content IS NULL` 或 `metadata_json` 无 `ocr` 标记），按 `library_id` / `file_id` 过滤后批量创建 `run_ocr` jobs。不强制全库执行。

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
  "offset": 0
}
```

Response：

```json
{
  "limit": 20,
  "offset": 0,
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
          "reason": "text_match"
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

向量 group（`image_vectors` / `video_segment_vectors`，`reason='vector_match'`，`score_kind='cosine_similarity'`）来自 Qdrant。`text_search` group（`score_kind='ts_rank_cd'`）来自 `media_assets.text_tsv`（对 `text_content` 跑 `to_tsvector('simple', ...)` 的 PostgreSQL FTS）：`text_chunk` asset 命中为 `reason='text_match'`（transcript），`image`/`video_frame` asset 命中为 `reason='ocr_match'`（OCR 画面文字）。触发 media type 为 `image`/`audio`/`video`，受 `library_ids` 过滤。

MVP 中不同 collection 的 `score` 不做全局可比承诺。前端应按 `groups` 分组展示，Phase 14 的 reranking 落地前不要把不同 collection 结果按原始 `score` 混排。

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
