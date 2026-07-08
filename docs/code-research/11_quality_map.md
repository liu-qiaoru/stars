# 代码质量与维护风险地图

## 评价范围

本文件基于当前源码、测试和文档，不做安全扫描、性能压测或逐行审查。风险级别是模块级维护风险，不是项目总评分。

## 总体判断

项目边界意识强，测试覆盖主链路较充分，关键复杂逻辑多有注释和单测。主要风险来自运行拓扑复杂、跨语言常量和协议同步、长任务 heartbeat 粒度、文本检索能力边界，以及 repository 层文件继续膨胀。

## 风险一：跨语言模型和 collection 配置需要手工同步

**级别**：中高。

**是什么**：TypeScript `VECTOR_COLLECTIONS` 和 Python `VECTOR_CONFIGS` 都维护模型名、版本、维度、vector kind、distance。

**为什么重要**：如果一边修改模型版本或维度，另一边未同步，可能导致 pending refs、Qdrant collection、embedding job 写入不一致。

**源码证据**：

- `apps/server/src/qdrant/vector-collections.ts` 定义 SigLIP 和文本 collection registry。
- `apps/worker-py/media_agent_worker/indexing.py` 定义 `VECTOR_CONFIGS`，注释要求与 TypeScript 对齐。
- `apps/worker-py/media_agent_worker/embeddings.py` 会在维度不一致时失败，但这是运行时兜底，不是编译期保障。

**已有缓解**：

- `qdrant-collections.service.ts` 会在 collection 维度变化时重建并 reset refs。
- `embedding_worker.py` 会校验向量长度。
- 测试覆盖 collection registry 和 embedding 维度。

**建议方向**：未来可以从 shared 生成 Python vector config，或增加跨语言配置一致性测试。

## 风险二：长任务 heartbeat 还不够细

**级别**：中。

**是什么**：`WorkerRunner.run_once()` 在任务开始前 heartbeat，但长时间的 FFmpeg、Whisper、OCR、SigLIP 推理期间没有统一续约接口。

**为什么重要**：长视频转写和 OCR 可能接近或超过 timeout；如果 heartbeat 不更新，server 的 stale 回收可能把仍在运行的 job 放回 queued，造成重复执行。

**源码证据**：

- `apps/worker-py/media_agent_worker/worker.py` 在 handler 前调用一次 `heartbeat()`。
- `apps/server/src/database/repositories.ts` 的 `reclaimStaleJobs()` 按 `heartbeatAt` 和 `timeoutSeconds` 判断 stale。
- `probe.py` 给 `transcribe_audio` 设置 `14400` 秒，`jobs.service.ts` 给 OCR 设置 `7200` 秒，说明当前主要靠大 timeout 缓解。

**已有缓解**：长任务 timeout 已调大；handler 多数写入幂等。

**建议方向**：给 handler 提供 heartbeat callback，在长循环、每个 asset、每个 chunk 后续约；同时实现取消检查。

## 风险三：取消状态存在于协议，但执行语义薄

**级别**：中。

**是什么**：shared constants 有 `cancel_requested`、`cancelled`，job protocol 也描述取消，但 worker 当前主循环没有在长任务边界检查取消。

**为什么重要**：用户面对长视频转写或 OCR 时需要取消能力；如果状态只是协议，UI 或 API 后续接入会产生预期落差。

**源码证据**：

- `packages/shared/constants/index.ts` 包含取消相关 job status。
- `apps/worker-py/media_agent_worker/worker.py` 只处理 shutdown，不读取 job cancel status。
- `docs/job-protocol.md` 描述取消，但当前 handler 没有统一 cancel token。

**建议方向**：先实现 server cancel endpoint，再在 worker repository 增加 `is_cancel_requested(job_id)`，长任务阶段检查。

## 风险四：FTS 使用 simple 配置，中文召回有限

**级别**：中。

**是什么**：PostgreSQL FTS 查询使用 `plainto_tsquery('simple', query)` 和 `to_tsvector('simple', text_content)`。

**为什么重要**：项目默认 OCR 语言是中文 `ch`，但 simple config 对中文分词弱，中文画面文字或转写召回会受限。

**源码证据**：

- `apps/server/drizzle/0001_phase_12_transcripts.sql` 使用 `to_tsvector('simple', coalesce(text_content,''))`。
- `apps/server/src/database/repositories.ts` 的 `listTextSearchResultMetadata()` 使用 `plainto_tsquery('simple', ...)`，注释说明中文分词优化留给后续。
- `apps/worker-py/media_agent_worker/ocr.py` 默认 `OCR_LANGUAGE=ch`。

**已有缓解**：FTS 是 MVP 路径，文本向量 collection 已预留。

**建议方向**：后续可评估中文分词扩展、trigram、或文本 embedding 召回。

## 风险五：Repository 文件持续膨胀

**级别**：中。

**是什么**：Server 和 Python 的 repository 都集中大量数据库访问。

**为什么重要**：集中有利于边界清楚，但文件继续增长后，查询归属、测试定位和变更影响面会变大。

**源码证据**：

- `apps/server/src/database/repositories.ts` 约 711 行，包含 library、media、vector、jobs、search、agent 多类查询。
- `apps/worker-py/media_agent_worker/repository.py` 约 505 行，包含 job repository、media repository、asset/vector/OCR 多类 SQL。
- 多个 service 和 worker handler 都直接依赖这些集中函数。

**已有缓解**：函数命名清楚，注释解释边界，测试覆盖 repository 基本行为。

**建议方向**：等功能继续增长时，可按领域拆成 `jobs.repository`、`media.repository`、`search.repository`、`agent.repository`，但现在不必为了拆而拆。

## 风险六：端到端运行拓扑复杂

**级别**：中。

**是什么**：完整检索需要 PostgreSQL、Qdrant、server、model service、worker、web。

**为什么重要**：任何一个进程缺失都会造成部分能力不可用，例如 model service 缺失时向量搜索不可用，worker 缺失时索引不推进。

**源码与文档证据**：

- `README.md` 明确端到端需要五个主要进程，并解释缺失影响。
- `apps/server/src/model-gateway/model-gateway.service.ts` 调用 model service 失败会抛 `BadGatewayException`。
- `apps/server/src/qdrant/qdrant-collections.service.ts` 初始化失败只 warn，不阻断 Nest 启动，说明服务可能处于部分可用状态。

**已有缓解**：README 启动步骤详细；health 检查覆盖 database 和 Qdrant；前端 health indicator 显示后端状态。

**建议方向**：增加运行时诊断页面，显示 model service、worker heartbeat、pending job backlog、Qdrant collection 状态。

## 风险七：SearchService 承担多来源编排，未来可能继续变重

**级别**：中。

**是什么**：`SearchService` 当前负责请求校验、collection 选择、query embedding、Qdrant search、FTS search、hydration、reason 映射、hybrid 输入转换。

**为什么重要**：Phase 15 若加入外部 VLM candidate validation、文本 embedding 或更多 rerank 策略，SearchService 可能成为变化热点。

**源码证据**：

- `apps/server/src/search/search.service.ts` 约 262 行，已经跨 ModelGateway、Qdrant、DB、hybrid。
- `apps/server/src/search/search-hybrid.ts` 已把复杂合并逻辑拆出，这是良好先例。

**已有缓解**：hybrid ranking 是纯函数，测试充分；Service 注释解释边界。

**建议方向**：新增来源时优先抽象 source adapter 或 candidate provider，而不是继续堆到一个方法里。

## 风险八：前端错误处理较浅

**级别**：低到中。

**是什么**：`api-client.ts` 对失败只抛 `API request failed: status`，workspace 多数 catch 后使用简单 fallback 文案。

**为什么重要**：本地多进程系统常见部分依赖不可用，用户需要知道是 server、Qdrant、model service、worker 还是 job 失败。

**源码证据**：

- `apps/web/lib/api-client.ts` 的 `request()` 只抛状态码。
- `apps/web/components/search-workspace.tsx` 搜索失败后重置 initial results，没有展示具体错误。
- `apps/web/components/media-detail-workspace.tsx` 导出失败只显示“导出任务创建失败”。

**建议方向**：API error response 使用 `detail` 后，前端可展示可操作错误和依赖诊断入口。

## 质量优势

1. **测试覆盖主路径**：server tests 覆盖 search、jobs、agent、qdrant、media、libraries；worker tests 覆盖 scan、index、embedding、transcribe、OCR、export；web tests 覆盖 workspace 和 API client。
2. **复杂逻辑有纯函数**：`search-hybrid.ts` 可独立测试，降低搜索排序修改风险。
3. **注释解释边界**：关键文件中注释多解释为什么和职责边界，不只是复述代码。
4. **隐私边界明确**：Agent 默认关闭外部 LLM，tool 输出脱敏，副作用确认。
5. **幂等意识强**：扫描按 path/size/mtime，asset upsert 按语义字段，point id deterministic，重索引用 stale。

## 优先改进建议

1. 增加跨语言 vector config 一致性测试或生成机制。
2. 给 Python 长任务 handler 增加 heartbeat callback 和取消检查。
3. 为 model service 和 worker 增加 health/diagnostic 状态，让前端能解释部分不可用。
4. 明确中文文本检索路线：中文 FTS 优化、trigram 或文本 embedding。
5. 在 SearchService 继续扩展前，预留 source adapter 结构。
