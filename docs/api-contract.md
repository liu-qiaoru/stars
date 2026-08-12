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

`indexed_count` 统计 `media_files.index_status='indexed'` 的 active 文件。任意一个 active vector ref 成功写入 Qdrant 后，worker 会在同一事务中把对应文件标记为 indexed；不要求该文件所有 vector refs 都完成。Phase 7 使用空库重建，不再保留历史状态回填迁移。

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

手动补漏入口。默认运行时 `JobsCoordinatorService` 会自动扫描 pending `vector_refs` 并创建下游 worker jobs；该接口用于 worker 中断、Qdrant 重建或排查时主动补队列。接口不传递向量数据，只创建 `embed_image`、`embed_video_frame` 或 Caption 使用的 `embed_text_asset` jobs。

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
  "include_diagnostics": false,
  "search_scope": "all",
  "ranking_mode": "rrf"
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
      "merged_asset_ids": ["75c1157b-21b7-4a90-8c2f-2aa4ae7c9331", "asset-uuid"],
      "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
      "media_type": "video",
      "path": "video.mp4",
      "start_time_seconds": 120.0,
      "end_time_seconds": 150.0,
      "scene_id": "scene-0007",
      "score": 0.0327868852,
      "score_kind": "rrf_score",
      "primary_reason": "vector_match",
      "reasons": ["vector_match", "caption_match"],
      "source_scores": {
        "video_frame_vectors": 0.76,
        "caption_text_vectors": 0.84
      }
    }
  ],
  "groups": [
    {
      "collection": "video_frame_vectors",
      "score_kind": "cosine_similarity",
      "results": [
        {
          "asset_id": "75c1157b-21b7-4a90-8c2f-2aa4ae7c9331",
          "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
          "media_type": "video",
          "path": "video.mp4",
          "start_time_seconds": 120.0,
          "end_time_seconds": 150.0,
          "scene_id": "scene-0007",
          "score": 0.76,
          "reason": "vector_match"
        }
      ]
    },
    {
      "collection": "caption_text_vectors",
      "score_kind": "cosine_similarity",
      "results": [
        {
          "asset_id": "asset-uuid",
          "file_id": "54b83d84-7ff5-4b9a-8d11-fb27fbaf44db",
          "media_type": "video",
          "path": "video.mp4",
          "start_time_seconds": 120.0,
          "end_time_seconds": 150.0,
          "scene_id": "scene-0007",
          "score": 0.84,
          "reason": "caption_match"
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
          "path": "interview.mp3",
          "start_time_seconds": 30.0,
          "end_time_seconds": 55.0,
          "scene_id": null,
          "score": 0.16,
          "reason": "transcript_match"
        }
      ]
    }
  ]
}
```

`POST /search` 返回 `{ limit, offset, results, groups }`。`results` 是统一排序后的主结果列表；默认 `ranking_mode='rrf'` 时使用 `score_kind='rrf_score'`，显式选择 `current` 时保留旧 `score_kind='hybrid_score'`。`groups` 保留 PostgreSQL 过滤后的原始来源分组，用于兼容旧响应形状和调试召回质量。

向量 group 来自 Qdrant。`video_frame_vectors` 直接使用 Qdrant grouped search，按正式 `scene_id` 执行 MaxSim（同一场景只保留相似度最高的代表帧），时间边界从 PostgreSQL `video_scenes` 回表获取。`text_search` group 来自 `media_assets.text_tsv`，当前只返回 `text_chunk` transcript 命中。

- `search_scope` 支持 `visual | spoken | all`，默认 `visual`。`visual` 只调用 SigLIP2 视觉和已启用的 Caption 通道；`spoken` 只查询 PostgreSQL transcript，不调用查询扩展、模型服务或 Qdrant；`all` 才执行三类召回。
- `ranking_mode` 支持 `current | rrf`，默认 `rrf`。`current` 保留历史加权混合排序用于对照；`rrf`（Reciprocal Rank Fusion，倒数排名融合）只利用各通道过滤后的连续名次，每个贡献为 `1/(60+source_rank)`。RRF 分数只表示顺序，不是相关概率。
- top-level result 使用 `primary_reason`、`reasons`、`source_scores` 和 `merged_asset_ids` 表达命中解释。`current` 模式还会返回启发式 `confidence`；RRF 不从名次分数推导置信概率。跨 Asset 合并时，`asset_id` 是代表命中，`merged_asset_ids` 总是包含代表 Asset，长度至少为 1。
- `query_expansion_mode` 支持 `original | translate | expand`，默认 `expand`。`original` 只使用原查询并完全跳过外部扩展 Provider；`translate` 保留原查询并最多增加一个忠实英文翻译，生成后再独立调用 DeepSeek 校验人物、物体、动作、关系和约束是否等价；缺少译文、校验不通过或校验响应非法都会明确失败，不会静默降级；`expand` 使用完整查询扩展。`translate` 必须配置 `QUERY_EXPANSION_PROVIDER=deepseek`，Provider 为 `none` 时请求会明确失败，避免静默跳过整个 SigLIP2 视觉通道；`expand` 在 Provider 为 `none` 时仍只使用原查询。`QUERY_EXPANSION_MAX_VARIANTS` 默认是 3，包含原始 query；Prompt 和 Server 标准化都强制该上限。同一 Point 多次命中时保留加权后的最高分。仅在 `translate` 模式下按模型分流查询语言：SigLIP2 图片和视频帧通道只执行经过语义等价校验的英文译文，并使用权重 `1.0`；`caption_text_vectors` 只执行中文原查询。`original` 和 `expand` 模式不应用这条分流规则，便于进行可比的消融实验。系统不会把本地媒体路径或搜索结果发送给 DeepSeek。
- `include_diagnostics` 默认 `false`。显式设为 `true` 时，响应增加顶层 `query_diagnostics`，并在每个向量 group result 增加逐 Point `diagnostics`。RRF top-level result 另增 `ranking_diagnostics`，包含 `source_ranks`、`rrf_contributions` 和 `primary_signal`；最佳视觉帧时间继续由 `best_frame_time_seconds` 返回。Caption 原文属于本地媒体派生内容，只能出现在显式诊断响应中，不得写入普通搜索日志或默认响应。
- 转写命中使用 `transcript_match`，Caption 使用 `caption_match`，视觉向量使用 `vector_match`。
- `source_scores` key 使用固定 source key：当前为 `image_vectors`、`video_frame_vectors`、`caption_text_vectors`、`text_search`。同 source 多次命中时保留最大分数；启用查询扩展时，向量来源分数会先乘查询版本权重。原始分数只能在各自 source 内解释，不能跨 source 直接比较。
- 视频向量与视频 Caption 在 Qdrant 命中后必须回 PostgreSQL 核对正式 `scene_id`；缺少场景身份的旧数据不会进入 `groups` 或最终 `results`。RRF 使用图片 Asset ID 或视频场景 UUID 作为语义身份，同场景 Caption 与视觉帧合并，不同场景保持独立；没有场景身份的 transcript 以自己的 Asset ID 作为候选。
- `current` 模式继续保留弱视觉候选并可标记 `confidence='low'`。RRF 不使用原始向量阈值决定最终名次，也不会把 RRF score 当置信概率。
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
      "asset_type": "video_frame",
      "start_time_seconds": null,
      "end_time_seconds": null,
      "cache_path": null,
      "text_content": null,
      "metadata_json": {
        "scene_key": "scene-0007",
        "detection_strategy": "content",
        "frame_time_seconds": 135.0
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

## GET /agent/capabilities

返回 Agent V1 的部署开关、RightAPI 配置和步骤处理器可用性。响应不包含 API Key。

Phase C 只有在外部文本部署开关、RightAPI URL/Key、后台执行器和 AgentIntent Runner
同时就绪时才返回 `run_creation_available=true`。任一条件缺失都会阻止创建假成功 run。

```json
{
  "phase": "C",
  "provider": "rightapi",
  "model": "qwen3.7-plus",
  "run_creation_available": false,
  "external_text": {
    "deployment_enabled": false,
    "configured": false,
    "step_handler_ready": false,
    "available": false,
    "allowed_fields": ["user_prompt", "deidentified_capability_boundary"]
  },
  "external_visual": {
    "deployment_enabled": false,
    "configured": false,
    "available": false,
    "allowed_fields": []
  },
  "unavailable_reasons": [
    "external_text_deployment_disabled",
    "rightapi_not_configured",
    "agent_executor_or_step_handler_not_ready"
  ]
}
```

## POST /agent/runs

创建可恢复 Agent run。Server 只等待 PostgreSQL 短事务完成，不等待模型或检索；
成功时立即返回 `run_id` 和 `queued`。

```json
{
  "prompt": "帮我找红色汽车的视频",
  "allow_external_text": true,
  "allow_external_visual": false,
  "library_ids": [],
  "media_types": ["video"]
}
```

- `prompt` 最多 4000 个 Unicode 字符，超限拒绝，不静默截断。
- `allow_external_text` 是本 run 发送用户原 prompt 的授权，Agent V1 必须为 `true`。
- `allow_external_visual` 是独立视觉授权；Phase B 必须为 `false`，且没有发图入口。
- `library_ids` / `media_types` 是 Server 强制范围上限，不由模型扩大。

```json
{
  "run_id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "queued"
}
```

Provider 部署开关、RightAPI 配置、Server handler 或本 run 文本授权不满足时，
Server 在写数据库前返回 503/400，不创建假成功 run。

## GET /agent/runs/{id}

返回用户可见状态、下一步、逐 run 授权、规范化步骤尝试、冻结候选、脱敏错误和事件。
活动执行时间超过 `AGENT_ACTIVITY_TIMEOUT_MS`（默认 120000 毫秒，即 120 秒）时进入
`timed_out`；等待用户输入的时间不计入该上限。

```json
{
  "id": "0bfec861-c770-47ed-8e0d-1642a7a76591",
  "status": "queued",
  "next_step": "extracting_intent",
  "prompt": "帮我找红色汽车的视频",
  "summary": null,
  "enforced_scope": { "library_ids": [], "media_types": ["video"] },
  "lease_version": 0,
  "attempt_count": 0,
  "waiting_step_id": null,
  "waiting_expires_at": null,
  "error": null,
  "intent": null,
  "conditions": [],
  "resolved_scope": null,
  "authorization": {
    "allow_external_text": true,
    "allow_external_visual": false,
    "granted_at": "2026-08-12T03:00:00.000Z"
  },
  "steps": [],
  "candidates": [],
  "events": [
    {
      "event_id": "event-uuid",
      "type": "run_queued",
      "tool_call_id": null,
      "created_at": "2026-08-12T03:00:00.000Z",
      "payload": { "next_step": "extracting_intent" }
    }
  ],
  "created_at": "2026-08-12T03:00:00.000Z",
  "updated_at": "2026-08-12T03:00:00.000Z",
  "finished_at": null
}
```

意图步骤提交后，`intent` 返回严格校验的分类结果；`conditions` 中每项包含由 Server
生成的 `condition_id`、原始 `source_text` 和仅用于校验的归一化文本；`resolved_scope`
返回 Server 本地解析后的 `search_scope`、媒体类型和素材库 UUID。候选还会返回
`file_id`、`file_generation`、`asset_id`、`scene_id`、场景秒数、`rank` 和 `retrieval`。
`retrieval` 只保存 RRF 排名证据，不包含文件路径、Caption 或转录原文。
每个候选还固定返回 `review_status="not_run"`，页面必须显示“尚未审核”；RRF 分数只表示
来源名次融合后的排序值，不是相关概率。确认创建 Job 后另返回 `export_job`，其状态独立于 run。

## GET /agent/settings

返回 Provider、固定模型、Prompt/Schema 版本、能力/禁用原因、Key 是否配置，以及 Server
allowlist 的非敏感运行参数。响应不包含 Key、Provider URL或任意环境变量值。

## PUT /agent/settings

请求必须完整且只能包含：`enabled`、`tool_timeout_ms`、`lease_duration_ms`、
`activity_timeout_ms`、`waiting_ttl_seconds`、`executor_interval_ms`、`web_poll_interval_ms`。
未知字段返回 400。Server 强制 `lease_duration_ms >= max(activity_timeout_ms,
tool_timeout_ms) + 5000`。响应的 `apply_behavior` 标注当前字段均立即生效；当前实现只在
本 Server 进程保存覆盖值，进程重启后重新读取环境变量。

## POST /agent/runs/{id}/resume

只处理 `waiting_for_user_input` 澄清。`client_request_id` 在同一 run 内唯一，重复请求
返回同一接受结果，不写第二条输入。`response` 最多 2000 个 Unicode 字符。

```json
{
  "waiting_step_id": "11111111-1111-4111-8111-111111111111",
  "client_request_id": "resume-001",
  "response": "continue_as_read_only_search_with_resolved_scope"
}
```

Phase B 只接受固定动作 `continue_as_read_only_search_with_resolved_scope`，表示用户明确把
歧义目标覆盖为“无副作用的只读搜索”，并接受页面展示的 `resolved_scope`；这同时排除导出等
副作用解释。其他自由文本不符合共享 Schema，返回 400，不会保存后静默忽略，也不会再次调用 AgentIntent。
成功后返回 `{ "run_id": "...", "status": "queued" }`。等待步骤过期返回 410，
同时 run 进入 `expired` 终态；步骤身份或状态不匹配返回 409。成功恢复后固定
`next_step=searching`，不会再次执行已经完成的 AgentIntent。

## POST /agent/runs/{id}/cancel

```json
{
  "client_request_id": "cancel-001",
  "reason": "用户不再需要"
}
```

`queued` 和等待态没有正在提交的步骤，可直接进入 `cancelled`。
`extracting_intent` / `searching` 先进入 `cancel_requested`，立即使旧结果的状态条件失效；
租约安全到期后由 Server 转成 `cancelled`。已经创建的导出 Job 是独立事实，不随 run 取消。

## POST /agent/runs/{id}/retry-unknown

```json
{
  "step_attempt_id": "22222222-2222-4222-8222-222222222222",
  "client_request_id": "retry-001"
}
```

只允许当前 run 为 `outcome_unknown`，且 `step_attempt_id` 匹配未知结果尝试。
接受后创建新的用户授权输入并回到 `queued`；下次领取会生成新
`step_attempt_id`。普通 `/resume` 不得代替该授权。

## POST /agent/runs/{id}/export-selection

只允许 `waiting_for_export_selection`。请求包含 `candidate_key`、开始/结束秒数和固定 `mp4`。
Server 在响应预览前重新校验候选属于当前 run、`file_generation`、enforced scope、当前视频场景
及文件时长；过期 generation 返回 409，场景外范围返回 400。成功进入
`waiting_for_confirmation`，返回新的 `waiting_step_id`、`tool_call_id` 和
`requires_confirmation=true` 预览。

## POST /agent/runs/{id}/confirm

请求包含 `waiting_step_id`、`tool_call_id` 和幂等 `client_request_id`。Server 在一个 PostgreSQL
事务中完成等待态和 `requires_confirmation=true` 条件守卫、确认记录、唯一副作用、Job 创建或
复用、run 与事件更新。重复/并发确认最多创建一个 `export_clip` Job，并始终返回同一 `job_id`。
run 进入 `succeeded` 只表示确认事实完成；导出是否完成必须读取独立 Job 状态。

Phase C 仍不提供 Rerank、VLM 复核或 Agent 自主循环。

## 候选证据 API（Agent V1 Phase D）

候选证据只支持已冻结的视频场景。API（应用程序接口）只创建和读取本地派生图片，不调用外部
Provider（模型服务提供方），不改变候选顺序，也不返回审核结论或本机绝对路径。

### POST /candidate-evidence

Agent 来源请求示例：

```json
{
  "source": { "type": "agent_run_candidate", "run_id": "uuid" },
  "candidate_key": "video:scene-uuid",
  "strategies": ["contact_sheet_v1", "all_indexed_frames_v1"]
}
```

Evaluation 来源把 `source` 改为
`{"type":"evaluation_candidate","run_id":"uuid","candidate_id":"uuid"}`。Server 重新校验
候选属于该 run，当前文件仍是视频且 `index_generation` 未变化，场景与代表帧 Asset 身份一致。
过期 generation 返回 HTTP 409 和 `STALE_FILE_GENERATION`，不会改用新 generation。

响应为 `{ "items": [...] }`，每项使用 snake_case，包含 `id`、`candidate_key`、
`file_generation`、`job_id`、`status`、`strategy`、`protocol_version`、`manifest`、
`frame_count`、`artifact_url`、`error`、期限和冻结时间。`artifact_url` 只在 `succeeded` 时出现；
响应不包含 `artifact_path`。重复或并发请求复用同一 evidence 和活动 Job；失败或取消后可用同一
evidence 身份创建新 Job 重试。

`build_candidate_evidence` 虽关联 `file_id`，通用 `GET /jobs` 与 `GET /jobs/{id}` 也固定返回空
`file_paths`，避免从旁路泄露绝对路径。通用 `POST /jobs/{id}/retry` 对该 Job 返回 409 和
`CANDIDATE_EVIDENCE_RETRY_REQUIRES_SOURCE`；证据重试必须回到冻结候选调用本节 POST，才能在
同一事务重新关联 `candidate_evidence.job_id`。

### GET /candidate-evidence

使用 `source_type`、`source_id` 和可选 `candidate_key` 查询 PostgreSQL 已有状态，用于页面刷新或
Server 重启后恢复。Agent 的 `source_id` 是 run UUID；Evaluation 的 `source_id` 是 candidate UUID。
该读取不会创建 Job。

### GET /candidate-evidence/{id}

读取单条证据状态、manifest 和结构化错误。状态为 `queued | running | cancel_requested |
succeeded | failed | cancelled`。`succeeded` 只表示本地证据准备完成，不表示候选符合条件。

### GET /candidate-evidence/{id}/artifact

只允许读取 `succeeded` 证据。Server 从私有数据库列定位文件并重新计算 SHA-256；文件缺失或指纹
不一致返回 HTTP 409。响应使用 `private, no-store`，浏览器无法指定任意本机路径。

### POST /candidate-evidence/{id}/cancel

排队中的 Job 与同 Job 的全部策略立即转为 `cancelled`；运行中的 Job 转为
`cancel_requested`，由 Worker 在安全边界清理 partial 后写入 `cancelled`。终态重复取消幂等返回。

Web 文案必须区分“证据准备完成”“尚未执行 Rerank”“尚未执行 VLM 审核”。页面隐藏时暂停轮询，
恢复可见时立即刷新，终态停止，卸载时取消 HTTP 请求。普通候选展示不得自动调用 POST。

## 单视频重索引接口

`POST /jobs/video/reindex` 为一个 active 视频创建破坏性重索引任务。body 只接受
`file_id`。Server 先检查该文件是否存在 queued/running 的媒体索引任务；存在时返回
HTTP 409 和 `VIDEO_INDEX_JOBS_ACTIVE`，避免清理与写入并发。通过检查后，
`media_files.index_status` 变为 `purge_queued`，并创建 `purge_video_index` Job。

Worker 领取该 Job 后删除此文件在 PostgreSQL 和 Qdrant 中的可重建派生数据，提升
`index_generation`，再创建新的 `index_media`。接口不提供批量、dry-run 或 readiness
参数；Phase 7 已从空库完成旧视频结构切换。

## 检索评测 API

`/evaluation` 是仅供本地维护者使用的评测域，不改变普通 `/search` 的生产排序。

- `GET /evaluation/sets`：列出评测集及最新版本。
- `GET /evaluation/targets/random`：按可选 `library_id`、`limit`（最大 20）和 `seed` 返回已索引图片与稳定视频 scene 的随机目标。相同 seed 返回稳定顺序；响应只含媒体身份、路径与时间范围，不返回 Caption 或 Transcript。同一视频一批最多返回一个 scene。
- `POST /evaluation/sets`：创建评测集和首个草稿版本。
- `GET /evaluation/versions/{id}`：读取版本与查询。
- `POST /evaluation/versions/{id}/queries`：向草稿版本添加查询。必须提供查询文本、类型、意图分类和非空的必须满足条件。
- `POST /evaluation/versions/{id}/freeze`：冻结非空版本；冻结后不可修改。
- `POST /evaluation/versions/{id}/runs`：使用 `library_ids` 启动基线运行。基线固定关闭查询扩展，只使用当前 visual/caption/lexical 三路来源；每路深度为 20，RRF `k=60`，三路权重均为 1。
- `GET /evaluation/runs/{id}`：读取运行与盲标候选。未标候选默认不返回来源证据、分数和排名；诊断读取可传 `reveal_evidence=true`。
- `POST /evaluation/runs/{run_id}/candidates/{candidate_id}/judgment`：幂等保存 `relevance=0|1|2` 或 `unjudgeable=true`，可附加诊断与备注。
- `POST /evaluation/runs/{id}/finalize`：全部主池候选完成判断后计算 current/RRF 报告。

运行状态为 `pending | retrieving | ready_for_labeling | labeled | reported | failed`。所需来源、元数据或场景边界失败时必须进入 `failed`，不得省略来源后生成成功报告。RRF score 只是排序值，不是概率或百分比。

Phase 6 重建后，视频目标和候选的 `scene_id` 均为正式 `video_scenes.id` UUID，并且必须
与文件当前 `index_generation` 一致。候选快照保存文件 generation、来源名次、RRF 贡献和
current/RRF 名次；人工标注完成前普通读取隐藏这些证据。运行固定调用正式 Search API 的
`search_scope=all`、`query_expansion_mode=original`，不维护第二套召回或 RRF 公式。任一
必需通道缺失、Qdrant Point 无法回表或 generation 不一致时，会清空该运行的候选并把整次
运行标为 `failed`。

`POST /jobs/{id}/retry` 只接受 `failed` 任务，并复制原任务已经校验的输入创建新的
`queued` 任务。原失败任务保持不变，便于保留错误详情和审计链。
