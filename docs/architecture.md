# 本地多模态媒体 Agent 架构

## 目标

本项目是一个本地优先的 Web 系统，用于搜索、检查和剪辑个人媒体资产。目标素材规模约 1 TB，以视频为主，同时包含图片、音频和文本。

系统默认保留原始文件在用户自己的磁盘上，不上传、不复制源素材。应用只在本地工作目录中保存 metadata、索引、临时抽帧、转写文本、Caption 和导出剪辑。

## 推荐形态

使用可拆分式 monorepo：

```text
apps/web        Next.js 前端
apps/server     TypeScript / NestJS 主控 API
apps/worker-py  Python 媒体与模型 worker
packages/shared 共享类型、API schema 和工具函数
infra           本地基础设施定义
docs            架构、API 和实施文档
```

## 检索评测域

评测域是独立于普通搜索的本地维护工具。它把冻结查询、正式 SearchService 返回的候选快照、盲标判断、当前 hybrid 排名、正式 RRF 排名及指标持久化到 PostgreSQL。Phase 5 起普通搜索默认使用 RRF；`ranking_mode=current` 仍保留旧 hybrid 排序用于对照。Phase 6 的评测视频目标直接引用 `video_scenes.id`，候选同时冻结文件 generation，禁止依赖旧 `video_segment` 或 `metadata_json.scene_id`。

评测候选以图片 Asset 或正式视频场景为语义实体。visual、caption、lexical 是三个独立信号；视频帧的场景 MaxSim 折叠和 RRF 都由生产 SearchService 完成，评测层只保存结果和调用公共指标函数。运行所需来源、Point 回表或 generation 校验失败时整次运行失败，禁止生成部分指标。

仓库统一管理，但前端、TypeScript API server、Python worker 保持独立进程、独立依赖和清晰边界。这样既能让主要业务逻辑使用 TypeScript，也能保留 Python 在媒体处理和多模态模型上的生态优势。

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind。
- 主控 API：TypeScript、NestJS、默认 Express adapter、Zod。
- Agent 持久化执行：NestJS Server + PostgreSQL 租约状态机；Phase B 可按部署开关调用
  RightAPI `qwen3.7-plus` 做一次文本意图分类。
- 数据访问：PostgreSQL、Drizzle、node-postgres。
- 向量数据库：Qdrant，使用 Qdrant JS client。Collection、point、payload 和 PostgreSQL 引用结构见 `docs/vector-index-design.md`。
- 后台任务：PostgreSQL-backed jobs。Redis 只作为可选实时事件/pub-sub 通道。
- Python worker：FFmpeg、ffprobe、PySceneDetect、SigLIP2、faster-whisper、Caption 文本嵌入模型，以及通过 Ollama 调用的 Qwen2.5-VL。
- Agent 编排：Server 固定状态迁移、租约隔离与逐步持久化。Phase B 已接入独立的
  RightAPI `qwen3.7-plus` 单次 AgentIntent Runner；Python 不负责 Agent 决策。
- 外部多模态模型层：通过 TypeScript Model Gateway 接入 OpenAI、Claude、Gemini 或其他提供商。
- 存储：本地文件系统，用于源素材引用、缓存文件、缩略图、抽帧、转写文本和导出剪辑。

## 高层架构

```text
Local Media Disk
  -> TypeScript Job Creator
  -> PostgreSQL jobs
  -> Python Scanner / Media / Model Worker
  -> PostgreSQL metadata
  -> Qdrant vector indexes
  -> TypeScript Retrieval Service
  -> TypeScript Agent Runtime
  -> NestJS API
  -> Next.js UI
```

可选事件通道：

```text
Python Worker / TypeScript Server
  -> Redis pub-sub
  -> NestJS SSE/WebSocket
  -> Next.js UI
```

## 核心模块

### Frontend

前端是本地 Web UI，用于素材库管理、搜索、任务进度、媒体检查、剪辑导出和 agent run。界面应该是信息密度适中的工具型产品，而不是营销落地页。

主要页面：

- Library：添加本地目录、触发扫描、展示已索引数量和错误数量。
- Search：跨图片、视频、音频和文本查询媒体。
- Jobs：展示扫描、索引、剪辑导出和 agent 任务进度。
- Media detail：展示 metadata、视频场景帧、transcripts 和剪辑操作。
- Agent panel：接收自然语言任务，展示工具调用、候选结果和最终结果。

### TypeScript API Server

NestJS 负责 HTTP API、模块组织、依赖注入、请求校验、OpenAPI 输出、数据库访问、Qdrant 查询、任务创建、agent 编排和结果读取。HTTP controller 不执行抽帧、embedding、转写、Caption、剪辑等重任务，只调用 service 创建 PostgreSQL job 并返回状态。

默认使用 NestJS 的 Express adapter。当前用户量级下，极致吞吐不是第一优先级；更重要的是把 Library、Jobs、Media、Search、Agent、Model Gateway 等能力放进清晰模块边界，降低后续功能膨胀时的维护成本。

初始模块划分：

```text
AppModule
  ConfigModule        读取和校验本地环境变量
  HealthModule        暴露 /health 并聚合依赖状态
  DatabaseModule      持有 PostgreSQL 连接、Drizzle schema 和 repository provider
  QdrantModule        持有 Qdrant client、collection registry 和健康检查
```

后续业务模块按 Phase 增量加入：

```text
LibrariesModule
JobsModule
MediaModule
SearchModule
AgentModule        持有 Server Agent 租约、Phase B 固定步骤和恢复 API
ModelGatewayModule
```

### packages/shared

`packages/shared` 存放前端和 TypeScript server 共享的类型与协议：

```text
schemas/      Zod request/response schemas 和 job input/output schemas
types/        TypeScript type definitions
constants/    media types、job types、collection names、event types
api-client/   typed API client
generated/    给 Python worker 使用的 JSON Schema
```

Python worker 不直接 import TypeScript 代码，而是读取 `generated/` 中的 JSON Schema 或由构建流程复制出的协议文件。

### Python Worker

Python worker 负责必须依赖 Python 生态或命令行媒体工具的重任务：

- 递归扫描本地素材库。
- ffprobe 媒体探测。
- FFmpeg 抽帧、缩略图、转码和剪辑导出。
- PySceneDetect scene boundary。
- SigLIP2 图片与视频帧 embedding。
- Whisper 转写。
- Qwen2.5-VL Caption 和 Caption 文本 embedding。

Python worker 从 PostgreSQL `jobs` 表 claim 任务，执行后写回 job 状态和结果。它不拥有 schema，也不直接对外暴露产品 API。TypeScript 侧负责 Drizzle schema 和 job protocol，Python 侧使用 raw SQL 或极薄 query helper 访问明确字段。

Qdrant 写入也由 Python worker 负责。TypeScript server 负责创建/删除 collection、读取 Qdrant 做搜索和管理 collection registry；Python worker 负责生成 mock 或真实 embedding、upsert Qdrant points，并写回 `vector_refs`。

### Scanner

Scanner 由 Python worker 执行。TypeScript API 只创建 `scan_library` job。Scanner 递归发现已注册本地素材库中的文件，记录文件路径、媒体类型、大小、mtime 和索引状态。初次扫描大素材库时应避免计算全文件 hash，因为对 1 TB 素材做完整 hash 成本较高。MVP 使用 `path + size + mtime` 判断变化，后续提供可选 content hash rescan。

### Indexer

Indexer 从文件创建 media assets：

- 图片文件创建 image assets。
- 视频文件创建 `video_scenes` 行和引用场景 UUID 的 `video_frame` assets。
- 音频或视频转写后创建 `text_chunk` assets。

自动化测试使用 mock embeddings 隔离模型下载；本地运行使用真实 SigLIP2 和 Caption 文本 embedding。

### Retrieval

Retrieval 组合 Qdrant 向量搜索、PostgreSQL full-text search 和 PostgreSQL metadata 过滤。Qdrant 只返回召回结果和轻量 payload，最终响应必须回 PostgreSQL 补齐事实数据。

`POST /search` 先依据 `search_scope=visual|spoken|all` 选择召回来源，再 overfetch 合法候选。视频视觉帧由 Qdrant 按正式 `scene_id` 做 MaxSim，场景分数取命中帧最大 cosine，边界从 PostgreSQL `video_scenes` 补齐。默认 `ranking_mode=rrf` 按 visual、caption、lexical 三个通道过滤后的名次融合，输出 `score_kind='rrf_score'`；`current` 保留旧 hybrid 排序用于对照。原始 `groups` 仍保留逐来源结果用于调试。

### Agent Runtime

Agent Runtime 位于 TypeScript/NestJS Server 主控层。Agent 是固定工作流编排器，
不是搜索引擎本身，也不是模型自主 Tool Calling 循环。

Phase B 当前已实现的执行模型：

```text
POST /agent/runs
→ 短事务原子写入 agent_runs + 逐 run 授权 + run_queued 事件
→ HTTP 立即返回 run_id/status=queued
→ AgentExecutorService 使用条件 UPDATE 领取租约并递增 lease_version
→ 同一短事务创建唯一 step_attempt_id
→ 若为外部步骤，先持久化 dispatched + 输入指纹
→ 在事务外调用一次 qwen3.7-plus AgentIntent Runner
→ 提交严格校验后的意图和 Server 本地解析的素材范围
→ 用用户完整原文、original、rrf 在事务外调用一次 SearchService
→ 短事务用 lease_owner + lease_version + status + step_attempt_id 提交
→ 同一事务冻结 agent_run_candidates 和 succeeded 状态
```

Lease（租约）是 Server 执行器的限时工作证。`lease_version` 是 Fencing Token
（隔离旧持有者的令牌）：新执行器接管后版本递增，旧执行器的迟到结果只会
更新 0 行，必须丢弃。外部请求若已记为 `dispatched` 但未完成，当前执行器仍在运行时会在
活动硬超时点立即提交 `outcome_unknown`；若进程已经崩溃，则由租约过期恢复扫描提交同一状态。
两条路径都只能由 `/retry-unknown` 的新用户授权重试。
纯本地活动步骤受 `AGENT_ACTIVITY_TIMEOUT_MS` 硬上限约束，默认 120 秒；超时后
run、step 和审计事件在同一短事务内进入 `timed_out`。已经标记 `dispatched` 的外部请求
不按纯本地超时处理或自动重放，而是按上述两条路径进入 `outcome_unknown`。

PostgreSQL 中的恢复事实分工：

- `agent_runs`：用户可见状态、下一步、租约、等待到期和脱敏错误。
- `agent_run_steps`：每次步骤尝试、输入指纹、外部派发状态和规范化输出。
- `agent_run_inputs`：`resume`/`cancel`/`retry-unknown` 用户输入，由
  `(run_id, client_request_id)` 唯一约束保证幂等。
- `agent_run_authorizations`：每个 run 的文本/视觉外发授权，两者不能互相替代。
- `agent_run_candidates`：Phase B 搜索后冻结 `file_generation`、Asset/场景身份、边界、
  RRF 排名和召回证据。提交前重新核对文件版本及 Server 强制范围。
- `agent_side_effects`：Phase C 使用的唯一副作用幂等键；Phase A 只建协议，不创建导出 job。

Phase B 注册了独立、可注入的 RightAPI `qwen3.7-plus` AgentIntent Runner。它使用
Anthropic Messages 兼容接口、非思考模式和唯一强制 `extract_agent_intent` Tool Call，
只接收本次用户原文与去标识化能力边界。模型不输出 query，也看不到候选、Caption、转录、
文件名或路径。HTTP/Tool Call/Zod Schema/原文连续子串/范围任一校验失败时 run 明确失败，
不会从自由文本猜 JSON 或自动修复。`ALLOW_EXTERNAL_LLM`、RightAPI 配置或执行器未就绪时，
创建接口仍在数据库写入前拒绝。Phase C 才实现 Web 轮询、候选选择与安全确认导出。

NestJS AgentModule 组织：

```text
apps/server/src/agent/
  agent.controller.ts          run、恢复、取消和能力 HTTP API
  agent.service.ts             输入校验、capabilities 和用例边界
  agent-run.repository.ts      短事务、租约、幂等输入和恢复状态机
  agent-executor.service.ts    定时领取、过期恢复与事务外步骤执行
  qwen-agent-intent.runner.ts  唯一强制 Tool Call 和严格 AgentIntent 校验
  agent-v1-step.handler.ts     一次意图识别、一次原文搜索和候选快照
  agent.types.ts               可注入的步骤 handler 协议
```

### Model Gateway

Model Gateway 位于 TypeScript 主控层，用统一接口封装本地 Python worker 能力和外部多模态模型。外部多模态模型只检查小规模候选集，例如 top search results 或选中的 keyframes。它们不应接收完整媒体库。

在线搜索需要低延迟 query embedding。真实 embedding 阶段默认增加本地 Python model service，只监听 localhost，负责加载模型并提供 `/embed/text`、`/embed/image` 等轻量 RPC。批量索引仍通过 PostgreSQL jobs 进入 Python worker。

Python worker 和 Python model service 是两个独立进程，但共享同一套推理代码。`python -m media_agent_worker.model_service` 默认监听 `127.0.0.1:4020`，TypeScript `ModelGatewayService` 通过 `MODEL_SERVICE_URL` 同步调用 `/embed/text` 获取查询向量。为避免 MPS/内存压力，在线查询 embedding 由 model service 常驻模型处理；worker 进程内的 image/video embedding handlers 共享一个 SigLIP2 embedder，避免同一 worker 重复加载模型。Apple Silicon 上可用 `SIGLIP_DEVICE=mps`，资源紧张时用 `SIGLIP_DEVICE=cpu`，CUDA 机器可用 `SIGLIP_DEVICE=cuda`。

### Clip Export

Clip Export 由 TypeScript API 创建 job，Python worker 使用 FFmpeg 直接处理原始本地视频文件。Fast mode 可以使用 stream copy。Accurate mode 可以重新编码以获得更精确的时间边界。

## 数据归属

原始媒体保留在用户自己的目录中。应用保存：

```text
.media-agent/
  cache/
    thumbs/
    frames/
    transcripts/
    scenes/
  exports/
    clips/
    montages/
  logs/
```

PostgreSQL 保存事实数据和任务状态。Redis 不再作为核心任务队列，因为 PostgreSQL-backed jobs 已经承担跨语言任务事实状态；Redis 只作为可选实时事件通道，不作为长期业务状态存储。Qdrant 保存向量和轻量 payload，payload 引用 PostgreSQL asset IDs。Qdrant 不是媒体 metadata 的事实来源。向量结构必须显式定义，避免后续索引重建、模型升级、删除同步和 payload filter 难以维护。

## 关键决策

### TypeScript 主控，Python 辅助

主语言使用 TypeScript，因为前端、API contract、业务状态、检索接口和 agent orchestration 都可以共享类型与工具链。Python 只负责媒体处理和模型推理，避免让不熟 Python 的维护者承担主业务逻辑。

### NestJS

NestJS 用作本地 API server。此前 Phase 2 已用 Fastify 建立基础服务，但用户明确希望切换为 NestJS，以获得严格模块化、依赖注入、Controller/Service/Module 边界和更稳定的长期组织方式。

为什么使用 NestJS：

- 后续模块数量多，包含 libraries、jobs、media、search、agent、model gateway、database、qdrant 等边界；NestJS 的模块系统能把这些依赖关系显式化。
- 依赖注入适合封装 PostgreSQL、Qdrant、job repository、agent tools 和 model gateway，便于测试时替换 provider。
- 当前本地工具的用户量级较小，极致性能不是最初目标；可维护性和边界清晰优先。
- 默认 Express adapter 足够满足 MVP。除非后续压测证明 HTTP 层成为瓶颈，否则不引入 Fastify adapter。

不用于：

- 不在 controller 中执行媒体重任务。
- 不让 NestJS 直接承担 Python worker 的长任务执行职责。
- 不把所有能力塞进单个 `AppModule`；每个业务域必须独立 module。

### PostgreSQL-backed jobs

跨 TypeScript 和 Python 的任务队列不绑定 Dramatiq 或 Celery。TypeScript API 将任务写入 PostgreSQL `jobs` 表，Python worker 使用 `SELECT ... FOR UPDATE SKIP LOCKED` claim 任务并更新状态。这样任务事实状态天然可查询，后续如需更复杂队列再迁移。

任务协议见 `docs/job-protocol.md`。TypeScript 维护 Zod schema 和 Drizzle schema，Python worker 不维护独立 ORM 模型。

### PostgreSQL 和 Qdrant

PostgreSQL 用于 metadata、jobs、事实数据和关系查询。Qdrant 用于向量，因为当前素材库已接近 1 TB，最终向量规模不确定。当前在线 Qdrant collection 按用途拆分为 `image_vectors`、`video_frame_vectors` 和 `caption_text_vectors`；转录文本仍由 PostgreSQL 全文检索承载。

### FFmpeg 和 PySceneDetect

FFmpeg 是媒体引擎，负责 probe、抽帧、转换和剪辑。PySceneDetect 是 scene boundary 决策工具。OpenCV 和 PyAV 可在后续用于高级帧处理或更精细的解码控制，但不是第一版媒体管线。

### 外部多模态模型

允许通过 Model Gateway 接入外部多模态模型。它们用于候选验证、结果解释、reranking 和 clip summary，不用于全库索引。

## MVP 边界

第一版应产生一个可运行的本地 Web 闭环：

1. 添加本地素材库路径。
2. 扫描文件并写入 PostgreSQL。
3. 创建索引任务。
4. Python worker 写入 media assets 和 placeholder vectors。
5. 从前端搜索。
6. 查看媒体详情。
7. 导出视频 clip。
8. 运行一个调用 search 并总结候选结果的 agent 任务。

MVP 不需要达到完整视频理解质量。它必须先建立系统边界，并证明从本地磁盘到前端结果的完整路径可行。
