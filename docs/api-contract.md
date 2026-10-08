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
  "model": "glm-5.3",
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
    "allowed_fields": ["full_user_query", "rrf_top20_derived_pngs"]
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
  "allow_external_media_text": false,
  "workflow": "retrieval_agent",
  "library_ids": [],
  "media_types": ["video"]
}
```

- `workflow` 默认 `retrieval_agent`，执行多轮检索后将有效视觉候选交给最终重排。`legacy` 保留原有重排与导出确认路径，必须具备视觉重排配置和独立图片授权。
- `allow_external_media_text` 默认 `false`，只在用户独立授权后允许发送候选标识、有限媒体信息、已有画面描述、重叠转录和证据标识。未授权时意图识别完成后进入可恢复的等待态。该授权不包含图片或路径。
- `prompt` 最多 4000 个 Unicode 字符，超限拒绝，不静默截断。
- `allow_external_text` 是本 run 发送用户原 prompt 的授权，Agent V1 必须为 `true`。
- `allow_external_visual` 是独立视觉授权。默认 `false`；只有产品 Rerank 已通过
  `AGENT_RERANK_PROVIDER=dashscope` 显式启用时才能设为 `true`。授权范围固定为完整原查询和
  最多 20 张派生图片（视频先生成 PNG，发送时按预算编码为 JPEG），不包含路径、Caption、转录、候选 Key 或指纹。
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

多轮任务新增 `retrieval`：包含 `pending`（下一工具名）、`tool_calls`、`model_calls`、`queries`（实际查询、候选标识、逐轮 ranks 与 sources）、`baseline`（完整原文、步骤与冻结候选）、`details`（有来源、真实时间及截断标志的证据）、`assessments`（逐候选逐条件 satisfied/not_satisfied/unknown）、`stop_reason`。新记录的 `queries[].ranks[].hits` 包含折叠前各素材的 `asset_id`、该次搜索原始 `rank` 和 `sources`；历史记录可缺省此字段，不能凭空补造历史命中。`gaps` 保存每次行动的原条件身份、缺口类型、检查候选与证据、缺失证据及下一步目的；`checked[].read_status` 由程序确定，not_read 不代表读过正文。`rejected_judgments` 记录被降为unknown的判断与固定原因，不保存模型思考。`clarification_question` 为当前待回答的问题。原始工具结果仍在步骤表保存；`retrieval.unavailable_candidates` 标记完成后又失效的候选，这些候选不会出现在可预览列表。`usage.external_calls_dispatched` 按步骤派发表计数，包含失败和未知结果，不能直接当成成功请求数或账单。

多轮任务最终 `candidates` 包含真实文件、场景和预览时间，并附 `query_sources`。成功按最终重排顺序返回；准备期间不返回内部候选作为最终结果。质量未验收时 `result_mode=baseline`、`quality_status=not_accepted`、`fallback_reason` 说明为何正式保留原文基线。增强、重排超时或未知失败时可返回已提交基线的前10条检索顺序，明确 `final_rerank_status=not_completed`；取消不返回新结果。`experimental_candidate_keys` 仅审计实验选择，不替换正式名单。 冻结验收报告的`frozen_suite_accepted`仅表示有限查询集不下降；`enhanced_selection_quality_accepted`另表示新增席位是否经过不同输入的人工对照。报告不是任务成功状态，不通过HTTP自动启用增强；本次同输入响应复用不授予新增席位策略推广资格。步骤输出以 `rerank_candidate_keys` 冻结最多20条正式候选，基线不能因描述缺失或GLM判断被删除；不同轮原始分数不混算。纯音频或没有场景身份的转录保留只读展示，以 `retrieval.rerank_not_applicable=true` 标记。条件判断是模型意见，程序仅检查引用真实性，排序不证明所有条件满足。无需新增数据库迁移，字段使用已有JSON状态；历史缺口不能补还原。

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
另支持 `model_timeout_ms`（外部意图/决策模型的独立等待上限，单位毫秒，范围 1000～120000，启动默认 60000）；旧客户端省略该字段时保留当前值。
未知字段返回 400。Server 强制 `lease_duration_ms >= max(activity_timeout_ms,
tool_timeout_ms, model_timeout_ms) + 5000`。本地工具与模型分别使用各自时限，仍受活动步骤和整任务剩余时间限制。响应的 `apply_behavior` 标注当前字段均立即生效；当前实现只在
本 Server 进程保存覆盖值，进程重启后重新读取环境变量。

## POST /agent/runs/{id}/resume

只处理 `waiting_for_user_input` 澄清。`client_request_id` 在同一 run 内唯一，重复请求
返回同一接受结果，不写第二条输入。`response` 最多 2000 个 Unicode 字符。

```json
{
  "waiting_step_id": "11111111-1111-4111-8111-111111111111",
  "client_request_id": "resume-001",
  "response": "只找白天道路上的红色汽车",
  "allow_external_media_text": true
}
```

`retrieval_agent` 保存真实补充文本，恢复后同时保留原目标、条件和硬范围；回答中的指令不能扩大素材库权限。素材文字授权必须通过独立布尔字段表达，文本中写“同意”不会自动授权。恢复请求省略该字段保留已有授权；显式 true 授权，显式 false 撤回。`allow_external_visual` 同样为可选独立布尔授权，省略时保留原选择。检索完成后缺少图片授权会返回 `retrieval.awaiting_rerank_authorization=true` 并保存选中集合；页面提交固定确认“开始最终重排”和勾选字段，恢复后直接进入重排，不重新解释查询或再次调用决策模型。
`legacy` 仍只接受固定 `continue_as_read_only_search_with_resolved_scope`，其他文本返回 409。
成功返回 `{ "run_id": "...", "status": "queued" }`。等待步骤过期返回 410；步骤身份或状态不匹配返回 409。成功恢复使用已完成意图和原任务候选，不创建新 run。

## POST /agent/runs/{id}/cancel

```json
{
  "client_request_id": "cancel-001",
  "reason": "用户不再需要"
}
```

`queued`、等待态和 `outcome_unknown` 可直接进入 `cancelled`。其中放弃
`outcome_unknown` 只结束本地 run、写入 `finished_at` 并清除活动步骤指针，不会再次调用外部 Provider；
原未知结果尝试仍保留在步骤和事件记录中供审计。
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

Phase C 主 run 仍不改变固定意图、一次原文搜索和安全导出协议。产品 Rerank 是独立可选后处理，
不会改写主 run 的 RRF 候选，也不接入 VLM 条件复核或 Agent 自主循环。

## Agent 产品 Rerank API

Rerank（重排）在同一次 Agent 查询的 RRF Top-20 已冻结后执行。RRF 是只利用多个召回通道名次
合并结果的基线；Rerank 把查询与候选派生 PNG 交给 `qwen3-vl-rerank`，返回独立 Top-10。

### POST /agent/runs/{id}/rerank

```json
{ "confirmed": true, "max_cost_cny": 0.216 }
```

只有本 run 已保存 `allow_external_visual=true`、产品 Provider 可用、搜索已完成且候选为连续视觉
Top-20 时才会执行。少于 20 条或包含音频时保存 `not_applicable`，外部调用为 0。视频候选先异步
创建 `contact_sheet_v1`；图片由 Server 校验 generation/Asset 后等比缩放为最长边 1600 像素的
PNG。网络前先提交 `external_call_status=dispatched`；无明确响应时进入 `outcome_unknown`，不自动
重试。一次 run 最多一个 Rerank 事实，重复 POST 幂等返回原结果。

### GET /agent/runs/{id}/rerank

没有启用时返回 `null`。存在时返回状态、请求审计、token/费用/耗时、错误、20 条 ranking 身份和
当前反馈。Top-10 行包含 `rerank_rank` 与 `relevance_score`，其余 10 行保持 null；原始
`rrf_rank` 始终保留。相关分数不是概率，只能在本次请求内比较。

### PUT /agent/rerank-runs/{id}/feedback

```json
{ "verdict": "rerank_better" }
```

`verdict` 只接受 `rerank_better | rrf_better | same`。只有成功的 Rerank 可反馈；重复选择会更新
同一行，因此后续汇总每次查询最多计一票。

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

RRF Top-20 中由 Caption 单独召回的视频候选继续保留原 Caption Asset，不能改写冻结快照。Server
验证 Caption 属于同一冻结 file/scene 后，确定性选择该场景第一条非 stale 且已有 indexed
`video_frame_vectors` 引用的帧作为证据 Job 锚点；Agent 与 Evaluation 使用相同规则。
找不到合格帧时返回 409，不删除候选、不补位或重新搜索。

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
- `POST /evaluation/versions/{id}/queries`：向草稿版本添加查询。必须提供查询文本、类型、意图分类、非空的必须满足条件，以及人工冻结的 `search_scope=visual|spoken|all`。Phase E 只对 `visual` 外发视觉证据；旧查询的 null 不会被猜测为视觉。
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

### Phase E 影子重排

- `POST /evaluation/runs/{id}/shadow-rerank`：只允许已生成 `reported` 报告的运行。以
  `(evaluation_run_id, qwen3-vl-rerank-top20-v1, execution_number=1)` 幂等创建或复用影子 run，先返回
  PostgreSQL 事实，再由 Server 后台执行。重复或并发 POST 不会创建第二个
  attempt。
- `POST /evaluation/runs/{id}/shadow-rerank/retry`：只允许上一次影子执行失败后显式调用。
  为同一 Evaluation 创建递增 `execution_number` 的新 run/attempt，继续读取原冻结查询、RRF
  Top-20 与证据，并在派发前核对 query/evidence 指纹。旧 request ID、错误和用量事实不覆盖；
  已成功执行不能重试。
- `GET /evaluation/runs/{id}/shadow-rerank`：返回已保存事实；尚未运行时返回
  `null`。有多次执行时，主字段展示最新 execution，并在 `execution_history` 返回各次完整只读
  PostgreSQL 快照。历史读取不调 Provider、不读取 Qdrant，也不会从文件重算排名。
- `GET /evaluation/runs/{id}/shadow-rerank/preflight`：只读组装视觉查询的冻结 Top-20，
  返回候选/文档数、真实 DashScope JSON UTF-8 字节数和查询/证据指纹。响应固定
  `external_call_count=0`，不创建 shadow run、不调用 Provider，也不返回查询文本、Base64、
  文件名或路径；用于真实 smoke 授权前确认准确外发规模。
- `POST /evaluation/shadow-rerank/attempts/{id}/usage-reconciliation`：仅用于 Provider
  响应未通过 Schema、token 保持 null 后，由维护者把阿里云模型监控中的同一 Request ID
  用量另行核对入库。请求固定为 `source=aliyun_model_monitor`、`provider_request_id`、
  `total_tokens`、`text_input_tokens`、`image_input_tokens`；三项必须为非负整数且总数等于
  文本与图片之和。它不修改 Provider 响应字段、attempt 结果或排名，只为预算门提供有来源的
  已知费用事实；相同内容幂等，冲突内容拒绝。

run 状态为 `pending | running | succeeded | completed_with_errors | failed |
not_applicable`；attempt 还可以为 `outcome_unknown`。`spoken`、`all` 或未冻结范围的
查询保存为 `not_applicable` 且 `external_call_status=not_dispatched`。只有同一个
`visual` 查询的完整 RRF Top-20 和完整本地证据通过身份/SHA-256 校验后，
才能形成一次 `qwen3-vl-rerank` 请求。

简化响应：

```json
{
  "id": "shadow-run-uuid",
  "evaluation_run_id": "evaluation-run-uuid",
  "status": "succeeded",
  "provider": "dashscope",
  "requested_model": "qwen3-vl-rerank",
  "response_model": null,
  "model_snapshot": null,
  "region": "cn-beijing",
  "protocol_version": "qwen3-vl-rerank-top20-v1",
  "execution_number": 1,
  "query_count": 1,
  "succeeded_count": 1,
  "failed_count": 0,
  "not_applicable_count": 0,
  "actual_sample_count": 1,
  "request_bytes": 123456,
  "input_tokens": null,
  "output_tokens": null,
  "total_tokens": 1244,
  "latency_ms": 2300,
  "billed_cost_cny": null,
  "estimated_cost_cny": 0.0022392,
  "review_status": "not_run",
  "error": null,
  "attempts": [
    {
      "status": "succeeded",
      "external_call_status": "completed",
      "provider_request_id": "provider-request-id",
      "query_fingerprint": "sha256",
      "evidence_fingerprint": "sha256",
      "response_fingerprint": "sha256",
      "actual_candidate_count": 20,
      "actual_result_count": 10,
      "usage_reconciliation": null,
      "metrics": { "rrf": {}, "shadow": {} },
      "rankings": [
        {
          "candidate_id": "uuid",
          "candidate_key": "scene-uuid",
          "rrf_rank": 4,
          "shadow_rank": 1,
          "relevance_score": 0.87
        }
      ]
    }
  ]
}
```

根响应还包含 `metric_summary`：`successful_samples` 只对 Provider 严格成功的查询
分别宏平均 RRF/影子指标；`full_product_samples` 覆盖全部适用查询，技术失败
时 `shadow_with_rrf_fallback` 使用已冻结 RRF 指标。`n` 是实际进入该口径的
查询数，不是候选数。

`relevance_score` 不是概率，不设阈值，也不能跨请求比较。非有限分数、非法或
重复 index、非按 score 非递增排序、少于/多于 10 条返回都使整个 attempt 失败，
不保存部分排名；但仍保存脱敏 Provider 请求 ID、已提供的模型/用量、耗时、费用、
实际返回数和响应指纹，并把 `external_call_status` 明确标为 `completed`。
`billed_cost_cny` 只表示供应商实际账单；官方响应未提供时为 null。
`estimated_cost_cny` 是按图片最高单价计算的本地保守预算，不得当成实际账单。
运行汇总的 `total_tokens`、`latency_ms`、`billed_cost_cny` 与 `estimated_cost_cny` 均可为
null：只要任一已外发 attempt 缺少对应事实，汇总就保持未知，不能返回部分总量或零。
API 和普通日志不返回绝对路径、Base64、文件名、Caption、转录或图片字节。
`review_status` 固定为 `not_run`，表示尚未执行 Phase F VLM 审核。

### Phase F VLM 候选审核（本地）

- `GET /evaluation/vlm-blind/datasets`：列出已保存的候选审核批次，只返回身份、状态和指纹。
- `GET /evaluation/vlm-blind/datasets/{dataset_id}`：读取 60 对查询—候选快照、原子条件、
  建议分组和审核进度。返回文件/场景 UUID 和秒级时间，不返回绝对路径、文件名、
  Caption、转录或图片字节。
- `POST /evaluation/vlm-blind/datasets`：导入 `phase-f-vlm-candidate-review-v1` 建议包。请求必须
  恰好包含 60 对，五组各 12 对且候选唯一。Server 在单个 PostgreSQL 事务内对照
  已完整召回的 Evaluation 快照，任何身份、时间或条件差异都整体拒绝。同一内容指纹
  并发或重复导入时返回已存在批次，不重复创建案例。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/cases/{case_id}/review`：保存候选审核。
  `accepted` 必须同时提交 `reviewed_group`；`rejected` 表示需要替换，不得携带组别。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/replacements`：为所有尚无后继的有效
  案例生成替代。任一查询文本只要曾被人工 `rejected`，该文本及当前所有同文本叶子都会
  永久退出盲测池；旧 rejected/accepted/pending 行保持只读。Server 从数据集已有冻结
  Evaluation runs 中选择从未被拒绝、尚未使用且符合目标分组的查询—候选，新行通过
  `replaces_case_id` 关联并回到 `pending`。选择同时维持每个查询最多两对和至少 50 个唯一
  查询；任一槽位没有替代时整批回滚。请求可显式携带
  `source_evaluation_run_id`，但该 run 必须已经处于 `ready_for_labeling | labeled | reported`，
  Server 只把它加入本次冻结候选读取范围，不在替代接口内重新搜索。该接口本身不读写
  Qdrant、不调用 Provider。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/rebalance`：仅在 60 条有效候选全部
  `accepted` 后，根据人工 `reviewed_group` 将五组重新配到各 12 条。Server 不改写超额组的
  accepted 审核，而是保留其历史行，并从同一冻结 run、同一 query 的未使用候选中，为缺额组
  追加 pending 后继。任一缺额无法完整匹配时整批回滚；接口不重搜、不读写 Qdrant、不调用
  Provider。详情响应的 `historical_accepted` 与 `historical_rejected` 分别显示被后继取代的两类
  人工审计记录，不能与当前有效候选混算。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/freeze`：候选审核的本地终态操作。Server 在
  同一 PostgreSQL 事务内锁定批次与案例，重新验证有效叶子恰好 60 条、全部 accepted、候选
  身份唯一、至少 50 个不同查询、每个查询最多两对、历史拒绝文本不再有效、五组各 12 条且
  条件快照完整。通过后将规范化查询—候选—条件快照计算为 SHA-256 指纹，并把批次更新为
  `status=frozen`；重复请求只返回同一冻结事实。SHA-256 是一种把任意内容压缩成固定 64 位
  十六进制摘要的哈希算法，这里用于发现快照是否变化，不包含原始媒体。该接口不构建证据、
  不调用 VLM、不读写 Qdrant；冻结后 review/replacements/rebalance 都拒绝继续修改。

上述路由只写人工审核事实，不调用 Provider、不创建证据 Job、不读写 Qdrant，也不产生
`passed/rejected/insufficient_evidence` 等模型复核结论。候选的 `review_status=rejected` 只表示
“不适合进入本轮盲标”，不是 VLM 对媒体相关性的判断。

#### Phase F 条件级人工盲标

候选数据集保持 `status=frozen`，条件标签使用独立的 labeling session（标注会话）记录进度。
这样“候选身份已经冻结”和“人工真值是否完成”不会复用同一个状态词，也不会为了开始标注而
重新开放候选审核。

- `GET /evaluation/vlm-blind/datasets/{dataset_id}/labeling`：只读返回证据、`first / second /
final` 三阶段进度、有效 60 条案例、条件标签和 fake 报告。GET 不创建 Job、不读取 Qdrant、
  不执行 Provider。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/evidence`：只对 60 条有效叶子的
  `source_evaluation_run_id + source_candidate_id` 创建或复用 `all_indexed_frames_v1`。它使用
  已有 `build_candidate_evidence` 后台 Job，不重新搜索、扫描、抽帧或索引；失败项可通过同一
  接口重试，成功项按冻结身份复用。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/cases/{case_id}/conditions/{condition_row_id}/labels/{stage}`：
  `stage=first|second|final`，body 严格为 `verdict=yes|no|uncertain` 和可选 `notes`。稳定
  condition row UUID 与 stage 组成幂等写入位置。全部一审完成后才能进入复核；复核开始后一审
  锁定；只有两轮不一致或含 `uncertain` 的条件能进入最终裁决。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/labels/freeze`：全部条件完成两轮；两轮一致的
  `yes/no` 直接成为 resolved verdict，两轮不一致或含 `uncertain` 时必须由人工 final 明确裁成
  `yes/no`。Server 不自动填充 `final_verdict`，只对完整人工事实生成 SHA-256 指纹并关闭写入口。
- `POST /evaluation/vlm-blind/datasets/{dataset_id}/fake-run`：只允许人工标签冻结后执行一次本地
  fake 协议演练。Server 读取并校验私有帧 bundle，在内存中组装严格请求；fake 不访问网络，
  `external_call_count` 恒为 0。数据库和 API 只保存条件输出、固定派生状态与指标，不保存或返回
  Base64、图片字节、绝对路径、文件名、Caption 或转录。

`labels_status` 为 `evidence_pending | evidence_preparing | evidence_failed | first_pass |
second_pass | adjudication | ready_to_freeze | labels_frozen`。证据准备由 Python Worker 异步执行；
人工标签与 fake 演练由 NestJS Server 同步校验并写入 PostgreSQL。fake 指标中的
`condition_accuracy` 是“fake 条件判断与冻结人工结论相同的条件数 ÷ fake 实际返回的条件数”，
`case_status_accuracy` 是“Server 派生状态相同的案例数 ÷ 全部案例数”；范围都是 0～1，越高只
表示固定假输出碰巧一致得越多，不能代表真实模型质量。

`POST /jobs/{id}/retry` 只接受 `failed` 任务，并复制原任务已经校验的输入创建新的
`queued` 任务。原失败任务保持不变，便于保留错误详情和审计链。

### Agent 任务详情的执行进度

`GET /agent/runs/:id` 新增 `progress` 数组，供检索页在运行中及恢复后展示实际步骤。
每项包含 `id`、`label`、`status`、`started_at`、`finished_at` 和 `parent_id`。
时间为 ISO 格式，`finished_at=null` 表示没有完成时间；`parent_id` 将检索内部的召回/排名融合关联到实际执行步骤。
状态包含 `running`、`succeeded`、`failed`、`outcome_unknown`、`lease_expired`、`interrupted`、`stopped` 等；应结合标签区分等待输入、取消与任务结束。

该字段由已持久化的任务、步骤和安全轨迹生成，不包含原始模型响应、隐藏思考、Caption、转录或路径。
页面沿用任务详情轮询；短阶段可能首次出现时已完成。普通 `/search` 的响应与排序保持不变。


### 多轮检索预算与候选选择补充（2026-10-06）

GET任务的retrieval.budget包含limits.maximum_tools/maximum_searches/maximum_details/maximum_models及已执行searches/details，模型实际次数继续用model_calls。额度在首轮冻结，失败也计入；progress_facts记录新候选/新正文数量，不能解释为语义验证成功。settings.retrieval_limits同时展示分类部署上限，但HTTP不能扩大它们。

retrieval.selection保存policy_version、qualification_id、正式candidate_keys、experimental_candidate_keys、result_mode、fallback_reason及配置/素材摘要。正式result_mode可能为baseline或enhanced；后者quality_status=accepted_for_frozen_case，仅表示同版本、同原文/范围/素材及同名单已经通过完整人工对照。无资格、损坏、范围或配置不符等仍baseline/not_accepted；失败原因与最终重排状态分别展示。evaluation只来自隔离验收的内部装配，不是创建任务的HTTP参数，不配置正式资格。原始基线名单和各轮来源保留。

等待图片授权后沿用已提交名单，身份失效停止外发并返回明确错误AGENT_RERANK_SELECTION_CHANGED，不能恢复时换一组图片。结果未知不自动重放。新增字段复用JSON步骤状态，无本次迁移/回填/重新索引；旧记录缺少字段时只从实际已提交工具结果补账，不能补造语义证据。
# 检索内部决策上下文补充（2026-10-06）

`inspection_checkpoint`、文件UUID分组和最近缺口历史是服务端生成的内部模型输入，不是客户端可更改的权限或预算。最低现有候选检查数已达到不等于证据支持目标，也不强制补搜。未达到当前版本人工质量资格时API仍返回基线结果；模型请求字节限制、分类预算和未知结果禁止重放继续适用。该补充没有新增HTTP启用开关或数据库字段。

已确定收到的动作格式错误可在审计步骤`diagnostics.issues`及内部下一轮`last_decision_error.issues`查看：`code`、`path`、可选`expected_type`/`received_type`（固定类型名称）和`unrecognized_key_count`（仅数量）。字段位置由共享动作Schema白名单限制，最多20项；`omitted_issue_count`表示其余省略数量。错误值、自造字段名、响应正文及模型思考不保存；未知外发仍不重试。内部反馈不是新增客户端授权字段。

隔离质量报告另保存`validation_scope`、逐查询`evidence.experiment_source`/`decision_model_substitute`及`autonomous_glm_supplement_verified`。`local_selection_control`表示本地替身选名单后执行真实图片重排：可以检验该有限名单的排序质量，不能作为GLM自主决策或完整新协议质量资格。正式`retrieval.selection`仍由服务端重新验证资格，无客户端启用参数。

### 多轮概要与批量详情协议（2026-10-06）

内部动作增加`get_segment_details_batch { candidate_keys: string[1..3], gap }`，身份不得重复或属于其他任务。单条动作兼容旧步骤。每个候选分别占用`retrieval.budget.details`和`tool_calls`一个位置；`tool_calls`表示操作额度用量，不是模型请求数或付费次数。不能通过批量扩大HTTP请求的预算。

新任务GET的`retrieval.evidence_protocol=overview-batch-v1`；`overviews`按候选身份保存`candidate_key/level=overview/status/evidence[0..1]/truncated/continuous_action_verified=false`。正文仅为当前有效预生成Caption，最多240个Unicode字符，来源、时间及指纹仍可检查，不含转录、图片或路径。`overview_budget`含`maximum_candidates/maximum_characters_per_candidate/inspected`，默认最多3轮搜索乘20即60个唯一候选读取尝试；失败也计数。无素材文字授权时不准备概要；独立授权恢复后先本地提交概要，再请求模型。

`gaps[].gap.checked[].evidence_level`由程序标记identity/overview/detail。概要与完整详情不同；概要截断不能作为未提及或反证的依据。至少两份完整概要的引用可支持补搜规划，非unknown的最终判断仍需可见完整详情；程序身份校验不保证模型语义正确。概要读取不计入逐候选完整详情预算，另有固定独立读取上限。

基线搜索先原子提交候选/原文/名次/来源，概要另步提交正文及计数；`evidence_preparation=candidate_overviews`为纯本地步骤。`stop_reason=overview_timeout`表示概要准备超时，先前基线保留；`context_limit`表示实际编码请求超过100000字节，决策派发为0。旧任务缺失概要字段时不隐式扩额。最终名单、授权恢复与基线资格门不改变。


### 明确模型失败的使用量投影（2026-10-06）

`GET /agent/runs/:id`的`retrieval.model_calls`以已派发的searching步骤为下限；HTTP拒绝、失败和结果未知也计入，不能因失败步骤没有成功状态快照而显示0。意图步骤仍单独列入总体`usage.external_calls_dispatched`。模型明确失败且未保存停止原因时投影`stop_reason=model_failed`；已提交原文候选可以基线顺序展示，`final_rerank_status=not_completed`。这是只读状态投影，不调用模型、不重排、不改历史证据；实际费用/用量缺失不能从调用次数推断为0。


### 当前真实验收边界（2026-10-06 下午）

RightAPI下午已返回正常响应；统一概要/批量协议的五视觉查询真实最终对照与本地空结果控制均逐项不下降，使用已有104条人工标签，不以任务成功状态作为判据。动作/位置/排除各2次决策、3详情主动found，没有工具额度停止。但本查询集无GLM自主补搜新候选，frozen_suite_accepted=true与enhanced_selection_quality_accepted=false必须分开；正式retrieval.selection仍baseline/quality_not_accepted，qualified-report未生成。普通模型条件判断与人工相关性存在差异，身份校验不能证明语义，不能据此删除基线。缺失对照阻塞已解除，后续需真实有缺口的案例才能补验新增路径，禁止强制补搜或冒充人工真值。有限样本结果不保证未来查询；详细报告位于.scratch/retrieval-quality/GOAL20-STATUS-2026-10-06.md。
## 2026-10-06 文字支持与视觉核实边界

决策协议 evidence-planning-v6-text-verification。Caption 为预生成模型描述，可能误认对象、位置或静态动作；证据身份、同帧、版本检查只验证来源，不能验证语义。模型的 satisfied/not_satisfied 保留为文字判断，不代表视觉条件已核实。详情工具仍只读取已有文字，没有增加视觉检查工具。

视觉条件存在时，模型 finish 的提交保存程序字段 `retrieval.visual_verification={status:"unverified",reason:"text_only_tools",model_stop_reason:原模型停止原因}`。原动作仍在步骤审计记录。通过引用校验的 found 或 conditions_not_met 转为 `stop_reason=visual_evidence_unverified`；缺条件支持仍为 insufficient_evidence；空结果、调用失败、预算原因分别保留。新字段可缺省以兼容历史任务。页面显示“文字规划已结束，画面条件尚未核实”与“文字线索支持/不支持（模型判断）”。

这不会强制补搜、删除基线候选或额外调用图片模型。可结束文字规划，再进行独立授权的最终图片重排；排序完成也不保证全部条件或连续动作满足。纯转录词语匹配保留现有边界。新协议配置指纹改变，旧验收不能启用当前增强，正式名单继续基线。

### 检索Agent v7：独立场景图片授权及观察

`POST /agent/runs`新增可选`allow_external_scene_visual: boolean`（默认false，仅retrieval_agent）。`POST /agent/runs/:id/resume`支持同名可选字段：省略保留授权，false撤销，true只授权RightAPI deepseek-v4-flash的有界采样图；不能代替allow_external_visual（百炼最终重排）或allow_external_media_text（素材文字）。授权和等待态恢复同事务提交；重复client_request_id不重复授权/执行。服务未显式启用DeepSeek场景工具时，创建时勾选该权限返回400。

`GET /agent/capabilities`和`GET /agent/settings`的model是实际显式配置（默认glm-5.3）。capabilities额外提供scene_inspection（provider/model、最多3候选、每候选3帧）或scene_inspection_available。外部开关及凭证缺失仍不可用，不返回Key/URL。

`GET /agent/runs/:id`的authorization增加allow_external_scene_visual。retrieval可包含awaiting_scene_authorization、model_configuration、scene_inspections；pending动作增加inspect_segment_frames。观察记录包含candidate_key、file_generation、frames[{frame_id,time_seconds,sha256}]、status=prepared|observed，以及observed时的observation{candidate_key,summary,conditions[{condition_id,status,frame_ids,observation}]}。provider保存已知用量/请求身份；即使观察字段或引用无效、status仍prepared，也保留已知provider元数据，未提供的用量/账单保持null，不把无效观察作为证据。无路径、图像编码或模型思考。details.evidence.source新增scene_visual_observation，引用可追踪采样帧的模型意见。

visual_verification仍status=unverified，reason=text_only_tools|sampled_frames，model_stop_reason保存模型原始结束意见。sampled_frames只证明本任务有模型观察返回，不代表人工验证或连续视频核实。新增停止原因scene_inspection_unavailable、scene_inspection_limit、scene_preparation_failed、scene_evidence_changed、scene_observation_failed、model_configuration_changed；最终重排状态与质量门仍独立。

共享TypeScript Schema是动作/响应的权威定义。HTTP请求不接受路径、帧时间或任意模型覆盖参数。新模型选择通过部署环境AGENT_RETRIEVAL_MODEL，默认GLM；没有自动换模型/未知请求重放逻辑。场景取帧复用服务端本地缩略图组件，不增加Worker Job Schema、迁移或索引重建。

### 显式检索范围与采样覆盖边界（v8）

创建任务可选`search_scope: visual|spoken|all`，省略继续由意图模型解析。显式值作为不可放宽范围与任务一并提交，并发送为意图能力边界`enforced_search_scope`；意图返回不同值以`AGENT_SCOPE_EXCEEDED`停止，不能改查另一种数据。Web多轮设置提供“检索内容范围”；转录只用video/audio，画面只用image/video。原文不改写；转录仍沿用词语选择和全文匹配边界，不套用视觉必需首轮原文规则。

视频`scene_inspections`可包含`normalizations[{condition_id,original_status,reason}]`，reason为`sampled_frames_not_exhaustive|continuous_action_unverified`。采样视频的not_satisfied保守降unknown，不能由三帧没看到目标断言整个场景不存在；连续/先后同理。原模型状态以降级记录保存，返回观察已是程序保守状态。页面解释采样覆盖限制，不删除基线。此检查只证明采样不完整，不验证模型语义。


### 检索Agent v9：命中图文统一决策

创建`POST /agent/runs`新增`allow_external_retrieval_visual?: boolean`，默认false，仅retrieval_agent且matched_multimodal/DeepSeek可用时接受。恢复`POST /agent/runs/:id/resume`同名可选字段：省略保留、false撤销、true只授权RightAPI `deepseek-v4-flash`的最多20候选、每候选1张实际命中JPEG/请求，不能代替素材文字、旧场景看图或百炼重排许可。回复文本不授予图片权限。授权、回复及等待恢复原子提交，client_request_id保证重复请求不重复执行。

capabilities新增`matched_evidence{available,maximum_candidates:20,maximum_frames_per_candidate:1}`；settings.capabilities新增`matched_evidence_available`。GET run.authorization增加`allow_external_retrieval_visual`。`retrieval.awaiting_retrieval_visual_authorization=true`时独立等待，Web显示勾选及“授权并判断命中图文”，不要求填写新检索要求。新创建/恢复请求的字段仍按共享TypeScript Schema严格校验。

新模式`retrieval.evidence_protocol=matched-multimodal-v1`，`model_configuration.evidence_mode=matched_multimodal`。`matched_evidence{candidate_keys,fingerprint,records}`按候选保存`candidate_key/level=matched/file_generation/status/truncated/continuous_action_verified=false/evidence[]`；证据source为`matched_visual_frame|pre_generated_caption|transcript`，包含真实来源evidence_id及时间，图片text仅帧身份/摘要/查询步骤，不含图片编码或路径。`matched_evidence_query_count`关联本轮准备状态。`queries[].ranks[].hits[].source_matches`保留`asset_id/source=vector_match|caption_match|transcript_match/frame_time_seconds`；对应RRF检索结果也附带该可追溯来源，排序不变。

运行状态边界：当前本地设置接口已确认DeepSeek命中图文模式可用；仅新建`retrieval_agent`且素材文字/命中图片授权齐全才执行此决策，`POST /search`与`legacy`不因此调用检索决策模型。模型可返回`finish:partial`而不补搜，这不是质量验收通过。2026-10-07新增单查询的独立本地选择真实重排对照不下降，也不自动修改产品质量资格或正式结果模式；见仓库`.scratch/retrieval-quality/sofa-phone/final-quality-report-r49.json`。

结构化缺口`checked[].evidence_level`新增matched，引用必须属于本轮已提供证据。命中文字每候选最多两份、每份1200 Unicode字符；视觉每候选最多1张256像素内/20,000字节JPEG，同次请求最多20候选，总请求750,000字节。采样视频的否定仍降unknown并保存sampled_frames_not_exhaustive拒绝依据；连续/先后仍无法确认。新增停止原因matched_evidence_unavailable/failed/changed；最终重排状态、正式结果模式与质量资格仍独立，未通过新版本验收保留baseline。

新图文动作采用共享retrievalMatchedActionSchema：每轮finish最多2份关键候选判断（每份仍含全部原条件），gap.checked最多3份。输入仍最多20候选、最终名单不缩减；这是2000输出token内的解释上限，不能当成候选淘汰。旧动作Schema仍保留20份上限供历史任务兼容。

`gap.kind=stale|tool_failed`可以引用本轮真实`matched`失效/读取失败记录的空`evidence_ids`，服务端覆写实际`read_status`；空引用不支持语义条件判断。费用在外发前拒绝时`stop_reason=cost_limit`，正式基线及最终重排状态独立保存。页面的“命中图文已准备”不代表请求已经发送或模型已经检查。

### 命中决策停止依据（2026-10-07）

新增策略`model_configuration.decision_policy_version=matched-pixel-stop-v2`，不改变素材传输许可`matched-multimodal-v1`或图片/费用上限。旧overview动作可省略`finish.stop_basis`；新命中模式必须提交并通过上下文校验，才保存至`retrieval.stop_basis`及同一已提交步骤。

`stop_basis`包含`kind=sufficient_evidence|no_useful_next_action|no_results`、最多31个原`condition_ids`、最多3个`checked`候选/当前证据引用，以及`search`、`detail`两对象。每个对象含`status=not_useful|exhausted|not_needed`及最多240字符的非空`reason`。partial/insufficient_evidence/conditions_not_met必须解释两种行动不再有用或实际额度耗尽，关联已承认未知的原条件；无判断时关联全部非可选原条件。不能以not_needed回避缺口。完整支持才可sufficient_evidence，实际空搜索才可no_results；预算仍由程序核对，来源身份有效不保证语义正确。

遗漏、伪造条件/候选/证据或虚称预算耗尽：`AGENT_STOP_BASIS_INVALID`写入已有有限纠正记录；不增加调用上限，耗尽纠正后以insufficient_evidence保底。视觉条件仅描述或转录引用时降unknown，`rejected_judgments.reason=visual_requires_pixel_evidence`保留被拒依据，不能据此删除基线。页面展示停止涉及原条件和两种行动理由，并明确属于模型意见。

未完成规划的旧策略任务恢复时`model_configuration_changed`停止增强；已经提交`rerank_candidate_keys`的交接不因此次策略版本变化重新做决策或换名单。质量配置摘要同时改变，旧资格不得用于新策略。上述字段使用已有JSON列，无迁移/回填/重新索引。

`stop_reason=cost_limit`表示外发前的费用预留拒绝，增强决策未发送，已完成基线可继续独立最终重排；页面明确费用停止，不表示质量验证成功。全文查询没有成功搜索快照时不得提交no_results，未搜索空名单与成功空结果独立。
