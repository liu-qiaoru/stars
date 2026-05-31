# API 契约

本文档定义第一版 Next.js 前端与 TypeScript / NestJS 后端之间的 HTTP 契约。除非实现过程中发现具体冲突，字段名在 MVP 中保持稳定。

## 通用类型

Job status：

```json
"queued" | "running" | "succeeded" | "failed"
```

Media type：

```json
"image" | "video" | "audio" | "text" | "unknown"
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
      "progress": 0.42,
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
  "progress": 1.0,
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
          "score": 0.82,
          "reason": "vector_match"
        }
      ]
    }
  ]
}
```

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
      "text_content": null
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
  "mode": "fast"
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
  "export_path": ".media-agent/exports/clips/57c0e91b-4112-4791-8b0c-af67c4d01aa0.mp4"
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
"run_started" | "tool_call_started" | "tool_call_finished" | "candidate_results" | "user_confirmation_required" | "run_succeeded" | "run_failed"
```

MVP 可以通过轮询 `GET /agent/runs/{id}` 返回累计事件。后续 SSE 或 WebSocket 应复用同一事件结构。

Response：

```json
{
  "run_id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "queued"
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
      "name": "search_media",
      "summary": "Searched video segments for product launch presentation."
    }
  ],
  "events": [
    {
      "event_id": "01J...",
      "type": "tool_call_finished",
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
