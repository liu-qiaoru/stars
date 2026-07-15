# 视频检索重建、SigLIP2、RRF 与异步视频 VLM 校验实施计划

**目标：** 删除 OCR 和旧 `video_segment` 兼容能力，从空 PostgreSQL 和空 Qdrant 重建图片/视频检索。视频使用真实镜头边界、最长 30 秒场景和固定 2.5 秒抽帧；视觉召回替换为 SigLIP2；生产排序加入 RRF；视觉搜索默认异步校验 Top-3 视频场景的完整视频内容。

**核心原则：** 不迁移旧数据，不自动掩盖场景检测错误，不直接混合不同模型的原始分数，不用单帧冒充视频理解。普通检索先返回 RRF 结果；耗时的视频 VLM（Vision-Language Model，视觉语言模型）校验在后台执行，失败时明确保留 RRF 原排序。

## 已确认的产品与架构决策

### 数据重建和兼容边界

- 当前 PostgreSQL、Qdrant、任务、Caption、评测和派生缓存都是可删除的开发数据，不导出、不迁移、不回填。
- 源图片和源视频目录永远不属于删除范围；重建工具不得移动、改写或删除源媒体。
- 实施开始前先停止所有业务服务并删除旧 PostgreSQL 数据、Qdrant 向量和评测数据。实施期间本地应用不可用，代码开发和测试使用隔离的 PGlite/测试替身。
- 最终 Drizzle Schema 完成后生成新的 `0000` 基线迁移，再创建本地表和 Qdrant Collection，重新添加素材库并索引。
- 删除 OCR 的代码、任务、依赖、Schema、接口、检索通道、UI、测试和当前文档，不保留“以后也许还会用”的占位能力。
- 删除 `video_segment`、`video_segment_vectors`、`VIDEO_SEGMENT_SEARCH_ENABLED`、readiness 接口和所有兼容分支。

### 场景和抽帧

- `video_scene` 不再是 `media_assets.asset_type`。新增独立的 `video_scenes` 表保存场景身份和时间边界。
- `media_assets.scene_id` 是可空 UUID 外键，引用 `video_scenes.id`；视频帧和视频 Caption 必须引用真实场景行。
- PySceneDetect 成功且没有检测到镜头转换时，整个视频是一个原始场景；随后仍按最长 30 秒拆成连续、不重叠窗口。
- 删除自动 `fixed_30s` fallback。检测器不可用、视频解码失败、非法边界或场景数量异常都让索引任务失败并通知用户。
- `SCENE_MIN_SECONDS=0.5`：保留大于等于 0.5 秒的短场景；小于 0.5 秒的噪声边界按确定性规则并入相邻场景。
- `SCENE_MAX_SECONDS=30`：长场景拆成最长 30 秒的连续窗口；场景前后不扩 1 秒。
- 删除 `KEYFRAME_DENSITY`。保留唯一抽帧配置 `VIDEO_FRAME_INTERVAL_SECONDS=2.5`，允许合理范围配置；修改后必须清理并重新索引视频。
- 每个场景按最长 2.5 秒的小区间划分，每个区间取中点；任何保留场景至少一帧。
- `SCENE_CAPTION_MAX_FRAMES=6` 是应用层资源上限，不是 Qwen2.5-VL 的硬限制。超过 6 帧时均匀选择 6 帧。

### 检索和排序

- SigLIP2 视觉通道只使用忠实英文译文；Caption 通道只使用中文原查询。查询扩展模式保留用于消融，但每个通道只执行适合自己的查询版本。
- Qdrant 对视频帧按 `scene_id` 分组检索，`group_size=1`。所有帧都参与相似度计算，每个场景只返回最高分的最佳命中帧。
- RRF（Reciprocal Rank Fusion，倒数排名融合）使用 `k=60` 和单位权重，只根据各通道内部名次融合，不把余弦分数当概率。
- 搜索范围为 `visual | spoken | all`，默认 `visual`：
  - `visual`：SigLIP2 视觉 + Caption。
  - `spoken`：语音转录全文检索。
  - `all`：视觉 + Caption + 语音转录。
- 视频 VLM 校验只允许 `search_scope=visual` 且 `ranking_mode=rrf`。语音查询和全部查询不能开启视频校验。
- 默认搜索组合是 `visual + rrf + async VLM`；否则“高精度默认开启”会与请求校验规则互相冲突。

### 异步视频 VLM 校验

- 用户在检索前选择“VLM 高精度”，页面默认开启，用户可关闭。
- `VIDEO_VERIFY_TOP_K=3`，配置范围 1～10。它只统计排名最靠前的视频场景，不统计图片。
- VLM 读取每个命中场景裁剪后的完整 MP4，不使用“最佳命中帧”代替视频。
- Caption 继续通过 `/caption` 使用 Ollama；同一个 Python VLM 服务新增 `/verify-video`，使用 Transformers 直接加载 Qwen2.5-VL 视频模型。
- `/verify-video` 延迟加载模型并固定并发为 1。Python Worker 调用它时同步等待，但 Web 和 NestJS Server 不阻塞。
- VLM 只接收用户输入的中文原查询，不接收英文译文、扩展词、Caption 或转录文本。
- VLM 返回严格的 `relevance: 0 | 1 | 2`、`matched_constraints`、`missing_constraints` 和 `reason`。
- Top-K 全部成功才应用排序；任一视频失败则整组保留 RRF 原排序。VLM 永远不能删除候选或加入新候选。
- 图片位置保持不变，只在被选中视频原来占据的位置之间重排。同等级视频保持 VLM 前顺序。
- 不增加 VLM 结果缓存。相同查询再次执行时重新校验。
- 同一搜索页面只保留最新校验任务：取消尚未运行的旧任务；运行中的旧任务完成当前场景后停止。
- 视频被重新索引、场景版本变化时，以 `SEARCH_INDEX_CHANGED` 终止校验，提示用户重新搜索；搜索校验不阻止索引重建。
- VLM 后端不可用只使高精度校验失败，不阻断 RRF 搜索，也不能伪装成“VLM 未调整排名”。

## 最终数据模型

### `video_scenes`

```text
id                    uuid primary key
file_id               uuid not null -> media_files.id
scene_key             text not null，例如 scene-0001-part-001
start_time_seconds    double precision not null
end_time_seconds      double precision not null
detection_strategy    text not null
strategy_fingerprint  text not null
index_generation      integer not null
created_at            timestamptz not null
updated_at            timestamptz not null
```

约束：

- `(file_id, scene_key, index_generation)` 唯一。
- `end_time_seconds > start_time_seconds`。
- 删除场景时级联删除引用它的派生 Asset；源文件不受影响。
- `index_generation` 用于识别异步搜索校验期间发生的重索引。

### `media_assets`

`asset_type` 只保留：

```text
image        整张图片
video_frame  场景内抽取的视频帧
text_chunk   音频或视频语音转录片段
caption      图片或视频场景的 VLM 描述
```

新增 `scene_id uuid nullable`：

- 视频 `video_frame` 和视频 `caption` 必须引用 `video_scenes.id`。
- 图片、图片 Caption 和纯音频 `text_chunk` 可以为空。
- Qdrant Payload 冗余保存 `scene_id` 只用于分组和诊断，最终事实以 PostgreSQL 为准。
- Qdrant 中不存在场景本身的向量 Point。

### `media_files` 和 `jobs`

- `media_files` 增加 `index_generation`；每次破坏性重索引递增。
- `media_files.index_status` 增加或明确使用 `purge_queued | failed` 等状态。
- `jobs.file_id uuid nullable` 是正式外键并建立索引；所有单文件媒体任务必须填写。
- `jobs` 增加 `error_code`、`error_details_json`，与现有 `error_message` 一起形成用户错误和技术诊断。
- `jobs.status` 正式支持 `cancelled`，并增加可安全轮询的取消请求/取代任务信息；运行中的模型调用不强杀，只在候选边界响应取消。
- `verify_video_search` 可能涉及多个文件，因此候选文件和场景快照保存在 `input_json`；它不使用单个 `file_id` 表达全部候选。

### 最终检索来源

```text
image_vectors         SigLIP2 图片向量
video_frame_vectors   SigLIP2 视频帧向量
caption_text_vectors  Caption 文本向量
text_search           PostgreSQL text_chunk 全文检索
```

## 实施阶段 0：立即停服并删除旧索引数据

**目的：** 确保后续代码不再为旧数据库、旧 Qdrant Point 或旧评测数据增加兼容逻辑。

### 0.1 先实现受保护的重置入口

- 创建仓库标准的本地重置脚本，默认只做 dry-run。
- dry-run 打印 PostgreSQL 数据库、Qdrant URL/Collection、派生缓存绝对路径和源素材目录。
- 只有显式 `--confirm-reset-local-data` 才执行。
- 拒绝空数据库名、非 localhost 地址、不可识别环境或仍在运行的业务服务。
- 重置前再次列出将删除与绝不会删除的路径；脚本不得对源素材目录执行写操作。
- 删除动作必须整体前置校验；条件不满足时快速失败，不开始部分删除。

### 0.2 实际顺序

```text
停止 Web / Server / Worker / model_service / vlm_service
→ dry-run 核对 PostgreSQL、Qdrant、派生缓存和源素材路径
→ 用户确认
→ 删除 PostgreSQL 旧数据和旧迁移事实
→ 删除 Qdrant Collections
→ 删除派生缓存
→ 保持业务服务停止，进入代码实施
```

删除完成后，本地应用暂时不可用；PGlite、Vitest 和 Python fake repository 测试继续可用。

## 实施阶段 1：Qwen2.5-VL 视频可行性门槛

**目的：** 在完整集成前证明 M5、32GB 机器能够理解真实视频，而不是先建设大量接口再发现模型不可用。

- 在隔离脚本中直接加载官方 `Qwen/Qwen2.5-VL-7B-Instruct` Transformers 权重。
- 分别测试 5 秒、15 秒、30 秒 MP4，输入采样尝试 1 FPS 和 2 FPS。
- 记录模型下载大小、首次加载时间、首次推理时间、热模型推理时间、峰值内存、交换内存和失败类型。
- 使用至少 10 个真实场景核对短动作、人物关系和环境约束；必须包含“单手比耶”等短暂动作。
- 选择不明显损失准确性的最低输入 FPS；短于一个采样周期的场景仍需至少提供有效帧序列。

通过条件：

- 30 秒场景无内存不足、进程退出或持续大量交换内存。
- 模型加载后，单个 30 秒场景不超过 60 秒。
- Top-3 最坏总等待约 3 分钟以内。
- 结构化输出稳定，短动作测试没有因降低 FPS 出现明显漏判。

未通过时：停止完整 VLM 集成，保留 RRF；页面将高精度选项标为不可用并解释原因。不得未经重新决策自动切换到小模型、量化模型或多帧图片方案。

## 实施阶段 2：重建 Schema 并删除 OCR/Segment 能力

**主要文件：**

- `packages/shared/constants/index.ts`
- `packages/shared/schemas/index.ts`
- `packages/shared/generated/job-schemas.json`
- `apps/server/src/database/schema.ts`
- `apps/server/src/database/repositories.ts`
- `apps/worker-py/media_agent_worker/repository.py`
- OCR、Segment 相关 Server/Worker/Web 文件和测试

任务：

- 先写失败测试，固定最终 Asset、Job、Collection 类型。
- 新增 `video_scenes`、正式 UUID `scene_id`、`index_generation`、`jobs.file_id` 和结构化错误字段。
- `media_assets.asset_type` 不包含 `video_scene`、`video_segment` 或 OCR 类型。
- 从共享 Job Schema 删除 `run_ocr`，重新生成 JSON Schema；Python 不维护第二份手写结构。
- 删除 PaddleOCR 初始化、任务处理器、依赖、补偿接口、全文召回、展示标签和测试。
- 删除 `video_segment_vectors` Collection、配置、查询和 readiness 兼容逻辑。
- 为外键、唯一键、任务 claim 和常用过滤条件建立索引。

验证：

```bash
corepack pnpm --filter @local-media-agent/shared check
corepack pnpm --filter @local-media-agent/server exec vitest run tests/database tests/jobs
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

## 实施阶段 3：场景检测、固定抽帧和破坏性重索引

### 3.1 场景检测

- PySceneDetect 输出原始镜头边界；检测成功但无切点时创建一个覆盖原视频的原始场景。
- 小于 0.5 秒的噪声场景按固定、可测试的相邻合并规则处理；大于等于 0.5 秒的场景必须保留。
- 超过 30 秒的场景拆成不重叠连续窗口。
- 校验所有边界有限、递增、不越过视频时长且没有非法重叠。
- 场景数量超过安全上限时失败，不生成固定窗口 fallback。
- 每个最终窗口写入 `video_scenes`，再创建引用其 UUID 的 `video_frame` Asset。

结构化错误至少包括：

```text
SCENE_DETECTOR_UNAVAILABLE
VIDEO_DECODE_FAILED
INVALID_SCENE_BOUNDARIES
SCENE_COUNT_EXCEEDED
VIDEO_DURATION_MISSING
```

任务失败时：

- `jobs.status: running -> failed`。
- `media_files.index_status -> failed`。
- Jobs 页面显示短错误、展开后的技术详情和“修复后重试”。
- 确定性错误不做无意义自动重试。

### 3.2 固定 2.5 秒抽帧

实现纯函数：

```python
sample_frame_times(start_seconds, end_seconds, interval_seconds=2.5) -> list[float]
```

- 将场景划分为最长 2.5 秒区间并取每段中点。
- 最后不足 2.5 秒的区间也取中点。
- 帧必须严格处于场景边界内。
- 30 秒场景得到 12 帧；0.5 秒场景至少得到中点帧。
- 删除所有密度补帧、分布式关键帧和 `KEYFRAME_DENSITY` 代码。

### 3.3 独立 `purge_video_index` 任务

```text
用户请求重索引
→ Server 检查该文件是否存在 queued/running 媒体任务
→ 有任务：返回 VIDEO_INDEX_JOBS_ACTIVE 和任务 ID
→ 无任务：同一事务把文件设为 purge_queued 并创建 purge_video_index
→ Worker 先删除 Qdrant Points
→ 再在 PostgreSQL 事务中删除场景、帧、Caption、Vector Ref 等派生数据
→ index_generation + 1
→ purge 成功后创建 index_media
```

- 不支持强制取消正在写索引的媒体任务。
- Coordinator 必须排除 `purge_queued` 文件。
- 重复执行使用稳定 ID、状态条件和事务保证幂等。
- Qdrant 已删除但 PostgreSQL 清理失败时，任务必须失败并可安全重试，不能标记成功。

测试覆盖正常检测、无切点、0.5 秒边界、长场景拆窗、所有结构化失败、抽帧边界、并发阻止、清理重试和级联删除。

## 实施阶段 4：Caption 与 SigLIP2 索引

### 4.1 场景 Caption

- `generate_caption` 输入使用 `scene_id`，不再把场景伪装成来源 Asset。
- Worker 通过 `video_scenes.id` 查询按时间排序的场景帧。
- 帧数不超过 6 时全部使用；超过时均匀选择 6 帧，包含首尾，结果稳定。
- Caption Asset 引用相同 `scene_id`，记录总帧数、选中帧数、帧时间、模型和 Prompt 版本。
- 临时图片在成功、失败和超时路径中全部清理。
- Caption 成功后创建 `caption_text_vectors` pending Vector Ref。

### 4.2 SigLIP2

统一使用：

```text
model_name    google/siglip2-base-patch16-224
model_version siglip2-base-patch16-224
```

- 图片、视频帧和同步查询文本使用同一 checkpoint 和真实投影维度。
- Python Worker 负责批量媒体嵌入并写 Qdrant；NestJS Server 搜索时同步调用模型服务生成查询向量。
- TypeScript registry、Python 配置、Qdrant Collection 维度和模型服务响应必须一致。
- SigLIP2 查询只接收经过语义等价校验的英文忠实译文；Caption 召回只接收中文原查询。
- 真实模型 smoke test 必须验证 MPS/CPU 选择、首次和后续耗时、内存以及中英文消融，fake 测试不能代替真实加载。

## 实施阶段 5：按场景召回、搜索范围与 RRF

### 5.1 Qdrant 场景分组

- `video_frame_vectors` 查询使用 Qdrant grouped search：`group_by=scene_id`、`group_size=1`。
- 所有索引帧都参与相似度比较，返回帧是该场景 MaxSim（最大相似度）代表帧。
- 召回深度按不同场景数计算，例如内部取 Top-50/Top-100 场景，再生成最终 Top-20。
- PostgreSQL 回表必须拒绝过期 generation、不存在场景、stale Asset 和模型版本不匹配 Point。

### 5.2 搜索范围

请求增加：

```json
{
  "search_scope": "visual | spoken | all",
  "ranking_mode": "current | rrf"
}
```

- 默认 `search_scope=visual`。
- 默认 `ranking_mode=rrf`，使默认开启的视频高精度校验具有合法的前置排序。
- `visual` 的独立通道为 SigLIP2 visual 和 Caption。
- `spoken` 只检索 `text_chunk`，不调用视觉或 Caption 向量。
- `all` 才融合 visual、Caption 和 transcript。
- 视频 VLM 仅允许 `visual + rrf`；非法组合由 Server 明确拒绝，Web 同时禁用选项并解释。

### 5.3 公共 RRF

- 从评测模块提取纯函数，生产搜索与评测共用同一实现。
- 每个通道贡献为 `1 / (60 + source_rank)`；RRF score 只表示顺序，不是概率。
- 图片候选身份使用图片 Asset ID；视频候选身份使用场景 UUID。
- Caption 通过正式 `scene_id` 与视觉场景合并。
- 通道完成 PostgreSQL 过滤后重新生成连续 `source_rank=1..N`。
- 稳定并列规则使用语义候选键，不能依赖数据库偶然顺序。
- 诊断响应显示各通道名次、贡献、最佳命中帧和帧时间。

测试覆盖单通道、多通道、缺失必需通道、同场景多帧、场景去重、并列、Top-K 截断和分页稳定性。

## 实施阶段 6：异步完整视频 VLM 校验

### 6.1 任务和 API（应用程序接口）

搜索请求：

```json
{
  "search_scope": "visual",
  "ranking_mode": "rrf",
  "visual_verification_mode": "off | async",
  "search_slot_id": "浏览器当前搜索页生成的稳定 UUID"
}
```

默认 `visual_verification_mode=async`。流程：

```text
Web 发起搜索
→ Server 同步生成查询向量并完成 Qdrant/PostgreSQL 召回
→ Server 执行 RRF
→ Server 返回初始结果和 verification_job_id
→ Server 创建 verify_video_search 异步任务
→ Worker 领取任务并逐个裁剪 Top-3 视频场景
→ Worker 调用 VLM /verify-video
→ Worker 把最终判断写入 jobs.result_json
→ Web 轮询 /search/verifications/:id
→ 全部成功后更新视频名次并展示升降
```

- 复用 `jobs.input_json/result_json`，不新建 `search_sessions` 或 VLM 缓存表。
- `input_json` 保存中文原查询、RRF 候选快照、场景 UUID、边界、文件 generation、VLM 前名次和 Prompt/模型要求。
- URL 保存 `verification_job_id`，刷新页面后可恢复任务状态和结果。
- `search_slot_id` 相同的新任务会取消旧 queued 任务；running 任务完成当前场景后停止，并记录 `superseded_by_job_id`。
- 没有视频候选时不创建任务，响应状态为 `not_applicable`，图片的 RRF 排序保持不变。
- Server 在创建任务前发现视频后端未配置或健康检查失败时，返回 `unavailable` 且不创建必然失败的任务；任务创建后后端才发生故障时，任务以结构化错误失败。

### 6.2 VLM 服务

- 现有 `vlm_service:4030` 保留 `/caption` Ollama 路径。
- 新增 `/verify-video` Transformers 路径，直接加载 Qwen2.5-VL，支持 MP4 输入。
- 两个后端分别报告健康状态；一个失败不能伪装成另一个失败。
- 视频模型延迟加载，推理并发固定为 1。
- Worker 使用 FFmpeg 按场景原始边界裁剪临时 MP4，通过受限的 multipart 文件上传传入 `/verify-video`，同时传入中文原查询；接口不接受任意本地文件路径。Worker 和 VLM 服务在成功、失败、超时和取消路径都清理各自临时文件。
- 调用前后验证 `scene_id` 和 `index_generation`；变化时返回 `SEARCH_INDEX_CHANGED`。

### 6.3 严格输出与排序

单个候选输出：

```json
{
  "candidate_id": "scene-uuid",
  "relevance": 2,
  "matched_constraints": ["背景是海边", "人物单手比耶"],
  "missing_constraints": [],
  "reason": "人物在海边场景中短暂举起一只手比耶",
  "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
  "model_version": "固定版本",
  "prompt_version": "video-verify-v1"
}
```

- `relevance` 只允许 `0 | 1 | 2`；候选 ID、重复 ID、模型版本和 Prompt 版本都要严格校验。
- 选取 RRF 中最靠前的 K 个视频场景；图片不占 K。
- 图片保持位置不变，只在这些视频原来占据的位置间按 `2 > 1 > 0` 重排。
- 同等级保持 RRF 顺序。
- 全部候选成功才应用重排；任何裁剪、超时、服务、JSON 或版本错误都让整组失败并保留 RRF。
- `verify_video_search.max_attempts=1`，不自动重试昂贵的视频校验；用户可重新搜索。任务超时值在可行性测试后按实测设定。

成功响应至少保存：

```text
pre_vlm_rank
final_rank
rank_delta
relevance
matched_constraints
missing_constraints
reason
duration_ms
```

失败必须区分 `VLM_BACKEND_UNAVAILABLE`、`VIDEO_CROP_FAILED`、`VLM_TIMEOUT`、`VLM_INVALID_RESPONSE`、`SEARCH_INDEX_CHANGED` 和 `SUPERSEDED`。

## 实施阶段 7：Web 搜索和任务反馈

- 保持现有紧凑控件风格，不增加突兀的大卡片。
- 检索前显示：

```text
搜索范围：视觉 | 语音 | 全部
排序方式：当前混合排序 | RRF（默认）
视频校验：关闭 | VLM 高精度（默认）
```

- `spoken/all` 或非 RRF 时禁用视频校验并解释原因。
- 点击搜索后立即显示 RRF 结果和“正在进行视频理解校验”。
- 页面只轮询最新任务；同一页面发起新查询时由新请求取代旧任务。
- 成功后展示：
  - `VLM 提升 3 位：#5 → #2`
  - `VLM 降低 6 位：#1 → #7`
  - `VLM 排名未变化`
- 同时显示相关等级、命中条件和缺失条件。
- 整组失败时列表保持 RRF 排序，并在列表上方显示明确错误；不得显示为“排名未变化”。
- VLM 后端不可用时提示“当前展示 RRF 排序”，普通搜索仍可用。
- 结果页若要重新校验，提供“重新使用 VLM 高精度搜索”，它会重新执行查询，不把旧页面候选当新事实。
- Jobs 页面显示索引结构化错误、详情和修复后重试入口。

## 实施阶段 8：生成基线、重建本地服务和素材索引

### 8.1 新基线迁移

- 删除旧迁移文件后，根据最终 Drizzle Schema 生成新的 `0000`。
- 基线不得包含 OCR、`video_segment`、旧 Collection 或兼容列。
- 人工核对外键、级联行为、唯一约束、generation、任务 claim 和评测表。
- 在全新 PGlite 和临时 PostgreSQL 中运行基线迁移测试。

```bash
corepack pnpm --filter @local-media-agent/server exec drizzle-kit generate
corepack pnpm --filter @local-media-agent/server db:migrate
```

### 8.2 恢复运行

```text
应用新 PostgreSQL 基线迁移
→ 创建 SigLIP2 与 Caption Qdrant Collections
→ 启动 Server
→ 启动 SigLIP2 model_service
→ 启动 Python Worker
→ 启动 VLM 服务和 Ollama
→ 启动 Web
→ 重新添加素材库
→ 扫描、探测、场景检测、抽帧、Embedding、Caption
```

完整性检查：

- 每个视频文件至少一个 `video_scenes` 行。
- 每个场景至少一个引用其 UUID 的视频帧。
- 每个视频帧和图片都有当前 SigLIP2 indexed Vector Ref。
- Caption 开启时，每张图片和每个视频场景都有当前 Caption Vector Ref。
- PostgreSQL 与 Qdrant 中没有 OCR、Segment 或旧模型数据。
- Qdrant Payload 的 scene UUID 能回表到同 generation 的真实场景。
- 失败任务在 Jobs 页面可见且不计入索引完成数。

## 实施阶段 9：重建干净评测集

- 删除旧评测后从零创建评测集，不导出混乱标注。
- 自然发现查询和指定目标查询分开，不混用指标。
- 至少覆盖人物动作、空间关系、环境主体组合、0.5～3 秒短动作、图片、视频、有语音和无语音视频。
- 使用相同素材、查询和召回快照比较：

```text
A：SigLIP2 + current + VLM off
B：SigLIP2 + RRF + VLM off
C：SigLIP2 + RRF + 异步完整视频 VLM
```

- 另做 SigLIP2 中文/忠实英文查询消融；生产路由仍按已确认规则执行。
- 报告 Precision@K、Recall@K、Hit@K、MRR、nDCG@K 时同时解释计算方式、方向、样本量和产品含义。
- 记录每个通道是否召回正确目标、RRF 名次变化、VLM 正确提升与错误降级数量。
- VLM 另外报告热/冷启动延迟、平均延迟、P95、超时率、失败率、峰值内存和队列等待。
- VLM 高精度产品默认保持开启；若评测证明质量回退或性能门槛不成立，必须形成新的明确决策，不能静默改变默认值。

## 实施阶段 10：文档与全仓库验证

- 更新 `AGENTS.md`、`docs/architecture.md`、`docs/api-contract.md`、`docs/job-protocol.md`、`docs/vector-index-design.md`、实施计划、任务和 lessons。
- 文档按时间顺序说明 Web、Server、Worker、模型服务、VLM、PostgreSQL 和 Qdrant 的调用方、同步/异步、输入输出、状态变化、失败与恢复。
- 全仓库搜索并删除仍把 `video_scene` 描述为 Asset、把最佳帧描述为 VLM 视频证据、自动 fallback、3 秒最短场景、Top-10 同步校验、OCR 或 Segment 兼容的当前说明。

```bash
corepack pnpm check
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

真实端到端验收必须从空数据完成：

```text
添加素材库
→ 扫描与探测
→ 镜头检测与最长 30 秒拆窗
→ 每 2.5 秒抽帧
→ SigLIP2 与 Caption 索引
→ visual/spoken/all 搜索
→ Qdrant 场景分组与 RRF
→ 异步完整视频 VLM 校验
→ 页面名次变化与失败提示
→ 新评测
```

## 推荐提交边界

1. `chore: stop services and remove legacy local index data`
2. `spike: validate qwen2.5-vl video inference`
3. `refactor: rebuild scene schema and remove ocr segments`
4. `feat: add strict scene detection and uniform frame sampling`
5. `feat: add destructive per-video reindex jobs`
6. `feat: rebuild caption and siglip2 indexing`
7. `feat: add grouped scene retrieval and production rrf`
8. `feat: add async full-video vlm verification`
9. `feat: expose search scope and verification feedback`
10. `chore: create clean baseline and rebuild local media index`
11. `test: create clean retrieval evaluation baseline`
12. `docs: update retrieval architecture and operations`

## 完成定义

本次工作只有同时满足以下条件才算完成：

- 旧 PostgreSQL、Qdrant 和评测数据在实施前已安全删除，源媒体未被修改。
- OCR、`video_segment` 和兼容逻辑从运行代码、依赖、Schema、UI、测试和当前文档中删除。
- PostgreSQL 用独立 `video_scenes` 表和 UUID 外键表达场景事实。
- 场景检测无自动 fallback，错误结构化展示并可修复后重试。
- 大于等于 0.5 秒的短场景被保留，长场景最长 30 秒，每 2.5 秒稳定抽帧。
- SigLIP2 图片/帧/查询模型一致，Qdrant 按场景返回最佳命中帧。
- visual/spoken/all 路由与 RRF 生产排序通过测试和真实检索验证。
- Qwen2.5-VL 视频可行性门槛通过；异步 Top-3 校验观看完整场景视频，不阻塞搜索。
- VLM 全部成功才重排，失败、取消、后端不可用和索引变化均明确可见。
- 页面默认开启检索前“VLM 高精度”，并显示每条视频被提升或降低的名次。
- 新基线迁移、空库重建、重新索引、新评测和全仓库检查全部通过。
