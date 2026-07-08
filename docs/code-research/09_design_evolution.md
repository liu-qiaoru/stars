# 从 0 设计这套系统

## 问题原点

用户有大量本地图片、视频、音频和文本素材，尤其视频很多。真正需求不是“存文件”，而是：

- 按画面语义搜索。
- 按讲话内容搜索。
- 按画面文字搜索。
- 定位到视频片段。
- 导出可用剪辑。
- 默认保护隐私，不上传源文件。

## 设计推演一：最小设计

**最小设计**：做一个本地文件索引器，递归扫描目录，把文件名、路径、mtime、大小存到 SQLite 或 JSON，然后按文件名搜索。

**暴露问题**：

- 文件名不能表达画面内容。
- 视频内部片段无法定位。
- 音频讲话和画面文字不可搜索。
- 处理 1 TB 媒体不能每次全量重扫。

**新增设计**：引入 `media_files` 和 `media_assets`，把文件和可检索片段拆开。

**复杂度代价**：需要资产 id、时间范围、索引状态、幂等 upsert。

**当前代码落点**：`apps/server/src/database/schema.ts` 的 `media_files`、`media_assets`。

## 设计推演二：同步处理还是后台任务

**最小设计**：HTTP 请求里直接扫描、探测、抽帧、embedding。

**暴露问题**：

- 扫描和模型推理耗时太长，HTTP 会超时。
- 大任务失败后难恢复。
- 多个本地模型不能阻塞 API 线程。

**新增设计**：PostgreSQL-backed job 队列。

**复杂度代价**：需要 job 状态机、claim、heartbeat、stale 回收、worker 进程。

**当前代码落点**：`jobs` 表、`JobsService`、`PostgresJobRepository`、`WorkerRunner`。

## 设计推演三：单语言还是双语言

**最小设计**：全部用 TypeScript 写。

**暴露问题**：

- FFmpeg 可以被 Node 调用，但 PySceneDetect、faster-whisper、PaddleOCR、transformers 的生态主要在 Python。
- TypeScript 不适合承担模型推理细节。

**新增设计**：TypeScript 主控，Python worker 做重任务。

**复杂度代价**：跨语言 schema、JSON Schema 生成、raw SQL 字段一致性。

**当前代码落点**：`packages/shared/schemas/index.ts`、`job-schemas.json`、Python `repository.py`。

## 设计推演四：向量库是否当主库

**最小设计**：把 metadata 和向量都放 Qdrant payload。

**暴露问题**：

- Qdrant payload 不适合保存完整 metadata、全文、job 状态。
- 删除、软删除、模型升级、回表权限都会变复杂。

**新增设计**：PostgreSQL 是事实源，Qdrant 只召回，`vector_refs` 桥接二者。

**复杂度代价**：每次搜索要 hydrate；payload 和事实字段要保持可调试但不权威。

**当前代码落点**：`vector_refs` 表、`listSearchResultMetadata()`、`embedding_worker.py` payload 写入。

## 设计推演五：query embedding 是否也走 job

**最小设计**：所有 embedding 都是 job。

**暴露问题**：

- 搜索 query 需要立即得到向量。
- 如果 query 进入队列，会被全库索引 backlog 阻塞。

**新增设计**：常驻 localhost model service 处理 query embedding；批量媒体 embedding 仍走 worker job。

**复杂度代价**：运行拓扑多一个进程，模型内存管理更复杂。

**当前代码落点**：`ModelGatewayService`、`SearchQueryVectorService`、`model_service.py`。

## 设计推演六：视频切片策略

**最小设计**：固定 30 秒切片。

**暴露问题**：

- 真实视频语义按镜头或场景变化，不按固定时间。
- 搜索命中可能跨越自然场景边界。

**新增设计**：PySceneDetect scene detection，失败 fallback 固定切片。

**复杂度代价**：需要 scene metadata、keyframe 策略、旧资产 stale 标记、fallback 结果解释。

**当前代码落点**：`indexing.py` 的 `_video_asset_inputs()`、`invalidate_video_index_assets()`。

## 设计推演七：文本检索先 FTS 还是先 embedding

**最小设计**：给 transcript/OCR 也做文本 embedding。

**暴露问题**：

- 会引入第二套文本模型、第二条在线 embedding 路径和更多向量 collection。
- MVP 先需要能搜到讲话和 OCR。

**新增设计**：先用 PostgreSQL FTS，文本向量 collection 预留。

**复杂度代价**：中文召回有限，语义文本检索不足。

**当前代码落点**：`0001_phase_12_transcripts.sql`、`listTextSearchResultMetadata()`。

## 设计推演八：Agent 是执行者还是协调者

**最小设计**：让 LLM 直接调用搜索、导出、重建索引。

**暴露问题**：

- 外部 LLM 有隐私风险。
- 导出和索引是本地副作用，不能交给模型自动授权。

**新增设计**：外部 LLM 默认关闭；工具输出脱敏；副作用工具只写确认事件，用户确认后 server 创建 job。

**复杂度代价**：Agent 体验更保守，需要前端确认 UI 和 tool call 状态。

**当前代码落点**：`AgentService.createRun()`、`agent.tools.ts`、`confirmToolCall()`。

## 当前设计的本质

这套系统不断把“不可控的重任务”和“需要低延迟的交互”分开，把“可重建的派生状态”和“不可丢的事实状态”分开，把“模型建议”和“用户授权副作用”分开。复杂度主要来自这些分离，但这些分离正是本地优先媒体系统可维护的基础。
