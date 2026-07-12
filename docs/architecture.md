# 本地多模态媒体 Agent 架构

## 目标

本项目是一个本地优先的 Web 系统，用于搜索、检查和剪辑个人媒体资产。目标素材规模约 1 TB，以视频为主，同时包含图片、音频和文本。

系统默认保留原始文件在用户自己的磁盘上，不上传、不复制源素材。应用只在本地工作目录中保存 metadata、索引、缩略图、抽帧、转写文本、OCR 结果和导出剪辑。

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

评测域是独立于普通搜索的本地维护工具。它把冻结查询、同一次多来源召回快照、盲标判断、当前 hybrid 排名、实验 RRF 排名及指标持久化到 PostgreSQL。普通搜索仍使用现有排序；RRF 在通过质量门槛前不会成为生产默认值。

评测候选以图片文件或视频场景为语义实体。visual、caption、lexical 是三个独立信号；视频帧在分配来源排名前按场景 MaxSim 折叠。运行所需来源失败时整次运行失败，禁止生成部分指标。

仓库统一管理，但前端、TypeScript API server、Python worker 保持独立进程、独立依赖和清晰边界。这样既能让主要业务逻辑使用 TypeScript，也能保留 Python 在媒体处理和多模态模型上的生态优势。

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind。
- 主控 API：TypeScript、NestJS、默认 Express adapter、Zod。
- Agent LLM：Vercel AI SDK（`ai`）、Anthropic provider（`@ai-sdk/anthropic`）。
- 数据访问：PostgreSQL、Drizzle、node-postgres。
- 向量数据库：Qdrant，使用 Qdrant JS client。Collection、point、payload 和 PostgreSQL 引用结构见 `docs/vector-index-design.md`。
- 后台任务：PostgreSQL-backed jobs。Redis 只作为可选实时事件/pub-sub 通道。
- Python worker：FFmpeg、ffprobe、PySceneDetect、OpenCLIP 或 SigLIP、faster-whisper 或 whisper.cpp、PaddleOCR 或 EasyOCR。
- Agent 编排：Vercel AI SDK（`ai`）+ Anthropic provider（`@ai-sdk/anthropic`）。Python 不负责 agent 决策，只负责执行媒体/模型重任务。
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
- Media detail：展示 metadata、segments、transcripts 和剪辑操作。
- Agent panel：接收自然语言任务，展示工具调用、候选结果和最终结果。

### TypeScript API Server

NestJS 负责 HTTP API、模块组织、依赖注入、请求校验、OpenAPI 输出、数据库访问、Qdrant 查询、任务创建、agent 编排和结果读取。HTTP controller 不执行抽帧、embedding、转写、OCR、剪辑等重任务，只调用 service 创建 PostgreSQL job 并返回状态。

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
AgentModule        使用 Vercel AI SDK + Anthropic provider，见 Agent Runtime 章节
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
- OpenCLIP / SigLIP embedding。
- Whisper 转写。
- OCR。

Python worker 从 PostgreSQL `jobs` 表 claim 任务，执行后写回 job 状态和结果。它不拥有 schema，也不直接对外暴露产品 API。TypeScript 侧负责 Drizzle schema 和 job protocol，Python 侧使用 raw SQL 或极薄 query helper 访问明确字段。

Qdrant 写入也由 Python worker 负责。TypeScript server 负责创建/删除 collection、读取 Qdrant 做搜索和管理 collection registry；Python worker 负责生成 mock 或真实 embedding、upsert Qdrant points，并写回 `vector_refs`。

### Scanner

Scanner 由 Python worker 执行。TypeScript API 只创建 `scan_library` job。Scanner 递归发现已注册本地素材库中的文件，记录文件路径、媒体类型、大小、mtime 和索引状态。初次扫描大素材库时应避免计算全文件 hash，因为对 1 TB 素材做完整 hash 成本较高。MVP 使用 `path + size + mtime` 判断变化，后续提供可选 content hash rescan。

### Indexer

Indexer 从文件创建 media assets：

- 图片文件创建 image assets。
- 视频文件创建 video frame 和 video segment assets。
- 音频转写后创建 audio segment assets。
- 文档和转写文本创建 text chunk assets。

第一版可以使用 mock embeddings 来验证完整应用路径。扫描和搜索链路稳定后，再用真实的 OpenCLIP、SigLIP 或文本 embedding 替换。

### Retrieval

Retrieval 组合 Qdrant 向量搜索、PostgreSQL full-text search 和 PostgreSQL metadata 过滤。Qdrant 只返回召回结果和轻量 payload，最终响应必须回 PostgreSQL 补齐事实数据。

`POST /search` 先 overfetch 各来源候选。视频视觉帧按 `(file_id, scene_id)` 做 MaxSim，scene 分数取命中帧最大 cosine，边界从 PostgreSQL `video_segment` 补齐；再与 caption、OCR、字幕候选做 hybrid 合并排序，输出 top-level `results`（`score_kind='hybrid_score'`）。原始 `groups` 仍保留逐帧/逐来源结果用于调试。长镜头先按 `SCENE_MAX_SECONDS`（默认 30 秒）拆窗，避免一个固定机位长视频只生成少量场景证据。

### Agent Runtime

Agent Runtime 位于 TypeScript 主控层，使用 Vercel AI SDK 接入 LLM function calling。Agent 是协调者，不是搜索引擎本身，也不直接操作文件系统。

为什么选择 Vercel AI SDK：

- Tool 定义使用 Zod schema，与项目 `packages/shared` 的 schema 体系一致，无双 schema 问题。
- 核心只负责"接收 prompt → 调 LLM → 执行 tool → 返回结果"，不接管存储、向量、部署等已有架构。
- `generateText` / `streamText` 是纯函数，与 NestJS service 直接集成，无框架摩擦。
- 支持 30+ 官方 LLM provider，切换 provider 只需改 model 配置。
- 不碰 PostgreSQL/Drizzle、Qdrant、Python worker 等现有模块。

不用于：

- Agent 不直接操作文件系统。
- Agent 不替代搜索引擎或检索逻辑。
- Agent 的 tool 执行结果写入 PostgreSQL 由 AgentService 负责，不由 AI SDK 负责。

MVP 使用 Anthropic Claude Sonnet 作为默认 LLM provider，但外部 LLM 调用必须由 `ALLOW_EXTERNAL_LLM` 显式启用。`ALLOW_EXTERNAL_LLM=false`（默认）时，Agent API 仍接受请求，但返回提示信息说明未启用，不返回错误。后续可通过 AI SDK 的统一 model 接口切换到其他 provider。

外部 LLM 隐私边界：

- 默认不发送源媒体文件、缩略图、关键帧、音频、视频或完整 transcript/OCR 文本。
- 默认不发送绝对本地路径；对外部 LLM 只发送脱敏后的文件显示名、media type、时间范围、score、候选摘要和必要 metadata。
- 如果用户后续开启外部 VLM 或发送候选样本，必须走 Model Gateway 的显式开关和审计记录，不由 Agent tool 直接上传。
- 所有发往外部 LLM 的 request 摘要必须记录到 `agent_run_events`，便于用户审计。

副作用工具边界：

- `search_media` 和 `get_media_detail` 是只读工具，可以由 LLM function calling 自动触发。
- `create_index_job` 和 `export_clip` 会创建后台任务或写本地文件，必须经过服务端 deterministic guard。
- `export_clip` 需要明确 `file_id`、`start_time_seconds`、`end_time_seconds`、用户显式导出意图；LLM 只能提出导出建议，不能独立授权执行。确认流程：LLM 生成建议 → AgentService 写入 `user_confirmation_required` 事件 → 前端展示确认 UI → 用户通过 `POST /agent/runs/{id}/confirm` 确认 → 服务端创建 job。确认凭证为 `tool_call_id`，不需要额外的 token 机制。
- `create_index_job` 需要明确 library/path 范围和用户显式索引意图，不能因为 LLM 猜测自动触发全库重建。确认流程与 `export_clip` 一致。

Agent loop 边界：

- MVP 使用有限步 tool loop，例如 `maxSteps = 4`。
- 单次 run 设置最大 tool call 数、超时和错误返回，避免 LLM 反复调用工具。
- 如果 tool 失败或无法解析参数，AgentService 记录事件并返回可读错误，不让 LLM 重试无限循环。

初始工具：

- `search_media`
- `get_media_detail`
- `create_index_job`
- `export_clip`

后续工具：

- `find_similar_image`
- `inspect_candidates_with_vlm`
- `extract_frames`
- `summarize_clip`
- `make_montage`
- `reindex_path`

NestJS AgentModule 组织：

```text
apps/server/src/agent/
  agent.module.ts       注册 AgentService、依赖 AI SDK provider
  agent.service.ts      封装 generateText/streamText 调用、tool 注册和事件持久化
  agent.controller.ts   HTTP API（复用 api-contract 定义的 endpoints）
  agent.events.ts       将 AI SDK steps 映射为 api-contract 定义的事件类型
  tools/
    search-media.tool.ts        调用 SearchService
    get-media-detail.tool.ts    调用 MediaService
    create-index-job.tool.ts    调用 JobsService
    export-clip.tool.ts         调用 JobsService
```

### Model Gateway

Model Gateway 位于 TypeScript 主控层，用统一接口封装本地 Python worker 能力和外部多模态模型。外部多模态模型只检查小规模候选集，例如 top search results 或选中的 keyframes。它们不应接收完整媒体库。

在线搜索需要低延迟 query embedding。真实 embedding 阶段默认增加本地 Python model service，只监听 localhost，负责加载模型并提供 `/embed/text`、`/embed/image` 等轻量 RPC。批量索引仍通过 PostgreSQL jobs 进入 Python worker。

Python worker 和 Python model service 是两个进程模式，可以共享同一套推理代码。Phase 5-9 只启动 worker，不启动 model service。Phase 10 起启动 model service：`python -m media_agent_worker.model_service` 默认监听 `127.0.0.1:4020`，TypeScript `ModelGatewayService` 通过 `MODEL_SERVICE_URL` 调用 `/embed/text` 获取 query embedding。为避免 MPS/内存压力，默认策略是：在线 query embedding 由 model service 常驻模型处理；worker 进程内的 image/video embedding handlers 共享同一个 SigLIP embedder，避免同一 worker 重复加载模型。Apple Silicon 上可用 `SIGLIP_DEVICE=mps`，资源紧张时用 `SIGLIP_DEVICE=cpu`，CUDA 机器可用 `SIGLIP_DEVICE=cuda`。

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
    ocr/
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

PostgreSQL 用于 metadata、jobs、事实数据和关系查询。Qdrant 用于向量，因为当前素材库已接近 1 TB，最终向量规模不确定。Qdrant collection 按模态和用途拆分，例如 `image_vectors`、`video_frame_vectors`、`video_segment_vectors`、`audio_segment_vectors` 和 `text_chunk_vectors`。

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
