# 本地多模态媒体 Agent 实施计划

## 目标

构建一个本地优先的多模态媒体检索 Agent，采用可拆分式 monorepo。主语言使用 TypeScript，Python 作为媒体处理和模型推理辅助层。第一版目标是可运行 MVP，而不是最终质量的视频理解系统。

第一版要先证明完整闭环：

```text
本地目录 -> 扫描 -> metadata 入库 -> job 创建 -> Python worker 处理 -> Qdrant 写入 -> 前端搜索 -> 媒体详情 -> 剪辑导出 -> Agent 调用工具
```

后续迭代再逐步提升检索质量、视频理解能力、音频/文本/OCR 覆盖、外部多模态模型验证、剪辑工作台和大规模索引稳定性。

## 资源估算与本地设备策略

当前已知运行环境是 Apple M4、32 GB 内存的 MacBook Pro。第一版应默认支持 Apple Silicon MPS 加速，同时保留 CPU fallback。

素材估算：

- 总素材约 1 TB。
- 视频约占 2/3，即约 650-700 GB。
- 如果视频平均码率为 5 Mbps，约 300 小时；10 Mbps 约 150 小时；20 Mbps 约 75 小时。
- 固定 30 秒切片时，约 9K-36K video segments。
- Scene-based segmentation 后 segment 数量取决于素材类型，通常可能接近 20K-100K。
- 每个 scene 选择 1-3 个关键帧时，frame vectors 可能在 20K-300K。
- 加上图片、音频转写和文本 chunk，第一阶段应按 100K-1M vectors 量级设计。

本地索引耗时估算：

- OpenCLIP / SigLIP 在 CPU 上处理大量图片和关键帧会明显慢于 MPS。
- 以 300K 关键帧估算，CPU 全量视觉 embedding 可能需要数小时到十几小时。
- MPS 可显著缩短索引时间，但仍应按长任务处理，必须支持进度展示、失败重试和增量索引。
- MVP 不应默认 dense index 全库。默认使用 `balanced`，先建立可用索引，再对重点目录启用更密集索引。

缓存空间估算：

- 抽帧、缩略图、transcript、OCR 和导出片段会产生额外本地文件。
- 对 1 TB 源素材，`.media-agent/cache` 应按 50-200 GB 的潜在增长量设计。
- Phase 17 必须加入缓存容量统计和清理策略。

设计结论：

- Qdrant 处理 100K-1M vectors 是合理目标。
- 第一版不对每一帧建向量。
- 索引策略必须可配置为 `light`、`balanced`、`dense`。
- 前端必须显示当前索引 profile、已生成向量数量、缓存占用和失败数量。

## TypeScript 主控层能力说明

主业务逻辑、API、数据模型、任务状态和 agent orchestration 由 TypeScript 负责。Python 只作为 worker 执行媒体与模型重任务。

### NestJS

用途：

- 提供本地 HTTP API。
- 提供模块化组织、依赖注入和 Controller/Service/Module 边界。
- 处理请求参数校验。
- 输出 OpenAPI 文档。
- 管理前端与后台任务之间的接口。

为什么使用：

- 用户希望主控 API 使用 NestJS，以严格模块化方式管理后续复杂度。
- 后续会有 Library、Jobs、Media、Search、Agent、Model Gateway、Database、Qdrant 等多个长期演进模块，NestJS 的依赖注入和模块边界比手写组织更稳。
- 当前用户量级下，极致 HTTP 性能不是最初目标；可维护性、测试替换 provider、清晰边界优先。
- MVP 使用 NestJS 默认 Express adapter，暂不使用 Fastify adapter，避免保留不必要的框架混合心智负担。

不用于：

- 不在 controller 中执行抽帧、转写、embedding、剪辑等重任务。
- 重任务只创建 PostgreSQL job，由 Python worker 异步处理。

初始模块：

- `AppModule`：组合根模块。
- `ConfigModule`：读取和校验环境变量。
- `HealthModule`：提供 `GET /health`。
- `DatabaseModule`：持有 PostgreSQL/Drizzle provider。
- `QdrantModule`：持有 Qdrant client、collection registry 和依赖检查。

后续业务模块：

- `LibrariesModule`
- `JobsModule`
- `MediaModule`
- `SearchModule`
- `AgentModule`
- `ModelGatewayModule`

### Zod

用途：

- 定义 API 请求/响应 schema。
- 校验外部输入。
- 在前端、server 和 shared package 中复用类型。

为什么使用：

- 与 TypeScript 类型系统配合直接。
- 比手写类型和运行时校验分离更稳。

### packages/shared

用途：

- `schemas/`：Zod request/response schemas 和 job input/output schemas。
- `types/`：共享 TypeScript 类型。
- `constants/`：media types、job types、collection names、event types。
- `api-client/`：前端使用的 typed API client。
- `generated/`：给 Python worker 使用的 JSON Schema。

边界：

- TypeScript server 和 web 可以直接使用 `packages/shared`。
- Python worker 不 import TypeScript 源码，只消费生成后的 JSON Schema 或协议文件。
- Qdrant collection registry 的事实来源在 TypeScript server；共享包只暴露 collection names 和类型。

### Drizzle、node-postgres 与 Drizzle migrations

用途：

- Drizzle 定义 PostgreSQL schema 和类型安全查询。
- Drizzle migrations 管理数据库迁移。
- node-postgres 作为 PostgreSQL 驱动。

为什么使用：

- 主语言为 TypeScript，schema 和查询应由 TS 主控层拥有。
- Drizzle 比 Prisma 更轻，SQL 感更强，适合本项目这种工程型本地服务。
- 数据库迁移仍然必须存在，用于版本化 schema 演进。

边界：

- PostgreSQL 不存大文件。
- PostgreSQL 不承担向量近邻搜索，向量检索交给 Qdrant。
- Python worker 可以读写必要 job/result 字段，但 schema 归 TypeScript 侧维护。

### PostgreSQL-backed Jobs

用途：

- TypeScript API 创建 job。
- Python worker 从 PostgreSQL claim job。
- job 状态、进度、错误和结果都写入 PostgreSQL。

为什么使用：

- 跨 TypeScript 和 Python 最稳，不绑定 Dramatiq、Celery 或 BullMQ 的任务协议。
- UI 可以直接查询 PostgreSQL 中的事实状态。
- Redis 清空不会丢业务状态。

执行模型：

```text
TypeScript API:
INSERT INTO jobs(job_type, input_json, status='queued')

Python worker:
SELECT ... FOR UPDATE SKIP LOCKED
UPDATE jobs SET status='running'
执行任务
UPDATE jobs SET status='succeeded' 或 'failed'
```

边界：

- MVP 不依赖复杂任务队列框架。
- 暂停、恢复、优先级和取消任务通过 PostgreSQL job state 和 worker 检查点实现。
- Redis 只作为后续实时事件/pub-sub 的可选组件。

Worker 进程模型：

- Python worker 是长期运行进程，启动命令为 `python -m media_agent_worker`。
- MVP 默认单进程、单 job loop，先保证状态正确；后续通过多个 worker 进程横向并发。
- 每个 worker 启动时生成 `worker_id`，claim job 后写入 `locked_by`、`locked_at` 和 `heartbeat_at`。
- worker 执行长任务时定期更新 heartbeat。
- 收到 `SIGTERM` 或 `SIGINT` 时进入 graceful shutdown：不再 claim 新 job，当前 job 到达安全边界后写回 `queued` 或 `cancelled`。
- TypeScript server 定期回收 heartbeat 超时的 `running` jobs，避免崩溃后状态泄漏。
- 暂停、恢复、取消通过 PostgreSQL job state 实现，worker 在任务边界检查状态。

Job protocol：

- 每个 `job_type` 必须定义 `input_json` 和 `result_json` schema。
- 任务协议见 `docs/job-protocol.md`。
- TypeScript 是 schema 事实来源，Python worker 不维护独立 ORM 模型。

### Qdrant JS Client

用途：

- 创建和管理 Qdrant collections。
- 执行向量召回和 payload filter。
- 查询 image、video segment、audio segment、text chunk vectors。

为什么使用：

- Retrieval 服务在 TypeScript 主控层，直接使用 JS client 更自然。
- Qdrant 对百万到千万级向量更稳。
- payload filter 适合按 library、media type、file_id、time range 过滤。

边界：

- Qdrant 只存轻量 payload 和向量。
- 详细 metadata 回 PostgreSQL 查询。
- Collection、point、payload、payload index 和 `vector_refs` 的结构见 `docs/vector-index-design.md`。
- TypeScript server 负责 collection 管理和搜索读取；Python worker 负责 Qdrant point 写入和 `vector_refs` 更新。

### TypeScript Agent Runtime

用途：

- 编排 agent workflow。
- 管理搜索、候选整理、可选 VLM 验证、剪辑计划和导出动作。

实现选项：

- MVP 可以先用轻量 tool router。
- 后续如需要更复杂状态机，再评估 LangGraphJS。

MVP 规则路由：

- 包含“找、搜索、检索、search、find”等词时调用 `search_media`。
- 包含“导出、剪辑、clip、export”等词且已有明确 `file_id` 或候选片段时调用 `export_clip`。
- 包含“重新索引、reindex、扫描”等词时创建对应 job。
- 匹配失败时 fallback 到 `search_media`。
- 如果 query 为空或无法形成搜索请求，返回“无法理解，请换一种说法或指定要搜索的内容”。

边界：

- Agent 不直接操作文件系统。
- Agent 只能调用明确暴露的 tools。
- Python 不做 agent 决策，只执行具体媒体/模型任务。

### TypeScript Model Gateway

用途：

- 统一封装本地 Python worker 能力和外部多模态模型。
- 提供 `create_embedding_job`、`create_transcription_job`、`verify_candidates_with_vlm` 等接口。

为什么使用：

- 避免业务代码绑定某个模型提供商。
- 避免前端/API 直接理解 Python 内部实现。
- 后续可以在 OpenAI、Claude、Gemini、本地 VLM 之间切换。

边界：

- 外部多模态模型只处理候选样本。
- 默认不上传完整源文件或全量素材。

Query embedding 路径：

- MVP mock vector 阶段不需要真实 query embedding。
- 真实 embedding 阶段使用本地 Python model service 生成 query embedding。
- TypeScript Retrieval Service 在搜索时同步调用 localhost RPC，例如 `/embed/text`。
- Python model service 常驻内存并加载模型，避免每次搜索都通过 job round-trip 加载模型。
- 批量索引仍走 PostgreSQL jobs，由 Python worker 执行。

### Vitest

用途：

- 测试 TypeScript API、repository、retrieval 和 agent tools。
- 验证 API contract 与实际响应一致。

## Python 辅助层能力说明

Python worker 只处理 TypeScript 不擅长或 Python 生态明显更成熟的任务。

### FFmpeg 与 ffprobe

用途：

- ffprobe 读取视频/音频时长、codec、分辨率、stream 信息。
- FFmpeg 生成缩略图、抽帧、剪辑、转码和导出。

为什么使用：

- 支持格式广、性能稳定，是媒体处理事实标准。
- 对 1 TB 素材，稳定性比高层剪辑库更重要。

边界：

- FFmpeg 负责媒体读写，不负责语义理解。
- Python worker 通过受控命令封装调用 FFmpeg，不把命令拼接散落在业务代码里。

### PySceneDetect

用途：

- 检测视频镜头切换。
- 为视频 segment 和关键帧抽取提供 scene boundary。

为什么使用：

- 固定 30 秒切片足够跑通 MVP，但语义完整性差。
- Scene-based segment 更接近用户理解的视频片段。

边界：

- PySceneDetect 不替代 FFmpeg。
- 它只做切分决策，抽帧和导出仍由 FFmpeg 完成。

### OpenCLIP / SigLIP / PyTorch

用途：

- 将图片、视频关键帧转成 embedding。
- 支持文搜图、图搜图、文搜视频帧、图搜视频帧。

为什么使用：

- CLIP 类模型能把文本和图像映射到相近向量空间。
- 适合先做本地语义检索，不依赖外部 API。

边界：

- 不对视频每一帧都建向量。
- 默认先按 scene 或时间间隔抽关键帧，控制向量量级。

### sentence-transformers

用途：

- 为文本、转写片段、OCR 文本生成 embedding。
- 支持语义文本检索。

边界：

- 第一版可先用 PostgreSQL `ILIKE` 或 FTS 跑通文本搜索，再接入 embedding。

### faster-whisper / whisper.cpp

用途：

- 将视频或音频中的语音转写为文字。
- 为 transcript search 和 agent summary 提供输入。

边界：

- 转写任务是后台任务。
- 不在 MVP 第一阶段强制转写全库，避免首次索引过慢。

### PaddleOCR / EasyOCR

用途：

- 识别图片和视频关键帧中的文字。
- 支持搜索海报、截图、字幕烧录、PPT 页面、屏幕录制中的文本。

边界：

- OCR 成本较高，应作为后续迭代或可选索引任务。
- 不对所有视频帧做 OCR，只对关键帧或用户选择的素材做。

### pytest

用途：

- 测试 Python worker 的媒体探测、抽帧、embedding、转写、OCR 和剪辑命令封装。

### Python model service

用途：

- 为在线搜索提供低延迟 query embedding。
- 常驻加载 OpenCLIP / SigLIP / sentence-transformers 等模型。
- 只监听 localhost，不作为公开产品 API。

为什么使用：

- 如果搜索时通过 `embed_text` job 获取 query embedding，会产生明显 round-trip 延迟。
- 模型常驻后，TypeScript Retrieval Service 可以快速获得 query vector 再查询 Qdrant。

边界：

- 批量索引仍由 Python worker 通过 jobs 执行。
- model service 只负责推理，不写业务数据库。
- Phase 5-9 不启动 model service，只使用 mock vectors。
- Phase 10 起启动 model service，默认监听 localhost。
- 为避免 MPS/内存压力，在线 query embedding 由 model service 常驻模型处理；批量 embedding job 默认由 worker 分批加载模型并释放，或配置为调用 model service 批处理端点。

## Phase 1：Monorepo 与基础设施

交付物：

- 创建 `apps/web`、`apps/server`、`apps/worker-py`、`packages/shared`、`infra` 和 `docs` 的仓库结构。
- 添加根目录 workspace 配置。
- 添加 PostgreSQL、Qdrant 和可选 Redis 的 Docker Compose。
- 添加包含所有本地配置项的 `.env.example`。
- 添加 README 启动说明。

验收标准：

- 开发者可以通过 Docker Compose 在本地启动 PostgreSQL 和 Qdrant。
- 预期的前端、TypeScript server 和 Python worker 目录存在。
- 源媒体文件不会被复制进仓库。

## Phase 2：TypeScript / NestJS 基础服务

交付物：

- 在 `apps/server` 创建 NestJS 应用，使用默认 Express adapter。
- 创建 `AppModule`、`ConfigModule` 和 `HealthModule`。
- 添加基于环境变量的配置加载。
- 添加 health endpoint。
- 添加 PostgreSQL 和 Qdrant 连接检查。
- 添加 Vitest 测试配置。

验收标准：

- `GET /health` 返回成功响应。
- TypeScript server 测试通过。
- 依赖检查失败时返回清晰错误。

## Phase 2A：Fastify 到 NestJS 迁移

背景：

- Phase 2 已经用 Fastify 交付基础健康检查能力。
- 用户在 Phase 3 前明确要求切换为 NestJS，并采用方案 A：NestJS 默认 Express adapter。
- 迁移必须先完成并验证，再继续数据库 schema、jobs、search 和 agent 等后续模块。

交付物：

- 移除 Fastify app 结构和 Fastify 依赖。
- 添加 NestJS 入口：
  - `main.ts`
  - `app.module.ts`
  - `config/config.module.ts`
  - `health/health.module.ts`
  - `health/health.controller.ts`
  - `health/health.service.ts`
- 将环境变量读取封装为 Nest provider，避免业务模块直接读 `process.env`。
- 将 PostgreSQL 和 Qdrant 依赖检查封装为 service/provider，便于后续 `DatabaseModule` 和 `QdrantModule` 复用。
- 保持 `GET /health` HTTP 契约不变。
- 测试改为 Nest testing module，并继续覆盖：
  - 依赖均正常时返回 HTTP 200。
  - 任一依赖失败时返回 HTTP 503。
  - 环境变量端口非法时返回明确配置错误。

验收标准：

- `pnpm --filter @local-media-agent/server check` 通过。
- `pnpm check` 通过。
- 启动服务后 `curl http://127.0.0.1:4000/health` 在 PostgreSQL/Qdrant 可用时返回 `status: ok`。
- 文档和任务清单不再把 Fastify 描述为目标后端框架。

## Phase 3：PostgreSQL Schema 与 Drizzle Migrations

交付物：

- 添加 Drizzle schema 和 migrations。
- 创建 libraries、media files、media assets、vector refs、jobs 和 agent run tables。
- 添加常用 create、read、update repository 函数。
- 在 `packages/shared` 定义 job input/output Zod schemas。
- 生成 Python worker 可读取的 JSON Schema。
- 明确 Python worker 不维护独立 ORM 模型，只使用 raw SQL 或极薄 query helper。

验收标准：

- Drizzle migration 可以迁移一个空 PostgreSQL 数据库。
- 测试可以创建 library、media file、media asset、vector ref 和 job。
- files、assets 和 vector refs 的关系可以查询。
- Python worker 可以用生成的 JSON Schema 校验 job input。
- CI 或测试包含 schema consistency check，确认 Python worker 访问的关键字段存在。

## Phase 4：Library 扫描与 Job 创建

交付物：

- 添加 library 的 create、list、detail 和 disable/delete APIs。
- 添加 scan job API。
- TypeScript API 创建 `scan_library` job。
- Python worker claim job 并递归扫描本地路径。
- 定义 Python worker 进程启动、heartbeat、超时回收和 graceful shutdown。
- 按扩展名检测 media type。
- 存储 path、size、mtime、media type 和 scan status。

验收标准：

- 可以注册一个本地文件夹为 library。
- Scan 会创建 job，并将发现的文件写入 PostgreSQL。
- 重复运行 scan 不会重复插入未变化文件。
- MVP 使用 `path + size + mtime` 判断文件变化，并明确记录该策略可能漏掉保留 mtime 和 size 的原地改写。
- 后续添加可选 content hash rescan，只在用户手动触发或重点目录上执行。
- Jobs 页面可以展示扫描进度和错误。
- worker 崩溃后，超时的 running job 可以被回收。

## Phase 5：媒体探测与索引骨架

交付物：

- Python worker 添加基于 ffprobe 的视频和音频探测。
- Python worker 添加图片尺寸探测。
- 添加初始 media asset 生成。
- 视频第一版先创建固定 30 秒 segment assets。
- TypeScript server 按 `docs/vector-index-design.md` 添加 collection registry。
- 初始化 Qdrant collections。
- 写入 deterministic mock vectors，让真实 embeddings 接入前搜索链路可运行。
- Qdrant point 写入统一由 Python worker 执行，包括 mock vectors。

验收标准：

- 图片和视频文件可以被索引为 media assets。
- Qdrant 包含能关联回 media assets 的 points。
- PostgreSQL vector refs 与 Qdrant point IDs 匹配。
- Qdrant payload 包含回表所需的 `asset_id`、`file_id`、`library_id`、`media_type` 和 `asset_type`。
- 索引失败会记录到 jobs 和 media files。
- 集成测试覆盖 mock vector 写入、Qdrant search、PostgreSQL 回表和 Search API 返回的完整链路。
- TypeScript server 不传递大向量数据给 Python，也不在 Phase 5 写入 Qdrant points。

## Phase 6：Qdrant Retrieval

交付物：

- 添加 search API。
- 搜索 image 和 video segment collections。
- 按 media type 和 library 应用 metadata filters。
- 返回 asset ID、file ID、path、media type、collection name、score、score kind 和 time range。
- 查询结果必须回 PostgreSQL 补齐完整 metadata，不能直接把 Qdrant payload 当最终响应。
- Phase 6 不做跨 collection 全局排序；结果按 collection 分组返回，避免不同模型和 collection 的 score 被直接比较。
- 请求支持 `limit` 和 `offset`，MVP 使用 offset 分页。

验收标准：

- Search 返回稳定 JSON 结果。
- 空结果状态被清晰处理。
- 结果可以在 media detail API 中打开。
- 同一次查询中 image、video、text 等不同 collection 的结果不会被直接按原始 score 混排。

## Phase 7：Next.js 前端

交付物：

- 在 `apps/web` 创建 Next.js 应用。
- 添加 Tailwind 样式。
- 添加 app shell navigation。
- 添加 Library、Search、Jobs、Media Detail 和 Agent 页面。
- 添加用于后端调用的 typed API client。
- 当前 `DESIGN.md` 不作为本产品页面布局和信息密度的主要依据；前端视觉规范以后续确定的工具型 UI 参考为准。

验收标准：

- 前端可以展示后端 health 状态。
- 用户可以在 UI 中添加 library 并触发 scan。
- Search results 可以渲染图片和视频 assets。
- Jobs 可以显示 queued、running、succeeded 和 failed 状态。
- MVP 前端优先保证 Library、Search、Media Detail 可用；Jobs 页面可以先保持轻量，展示基础列表和手动刷新。

## Phase 8：Clip Export

交付物：

- TypeScript server 添加 clip export API。
- API 创建 `export_clip` job。
- Python worker 调用 FFmpeg 导出 clip。
- 将 clips 保存到 `.media-agent/exports/clips`。
- 暴露 clip job status 和 exported path。
- 在 Media Detail 中添加 segment 导出操作。

验收标准：

- 视频 segment 可以导出为 MP4 clip。
- FFmpeg 错误可以通过 job error 字段查看。
- 导出的 clips 不会被提交到仓库。

## Phase 9：Agent MVP

交付物：

- TypeScript server 添加 lightweight tool router。
- MVP 使用规则路由，不依赖 LLM function calling。
- 添加 search、media detail lookup、job creation 和 clip export 工具。
- 添加 agent run API。
- 添加 Agent 页面，用于提交单次自然语言任务。
- 展示 agent status、tool-call summary 和 candidate results。
- Agent run state、events 和 tool calls 持久化到 PostgreSQL。
- 规则路由按关键词选择 tool，失败时 fallback 到 search，空 query 返回无法理解提示。

验收标准：

- 给定至少 10 个已索引测试媒体文件，用户输入自然语言查询后，Agent 会调用 search 并返回至少 3 个候选片段或明确说明候选不足。
- Agent 默认不会把源媒体上传给外部提供商。
- 只有当用户明确要求 export 或 clipping 时，才执行 clip export。
- Agent run 必须记录 tool calls，前端可以通过轮询读取状态；事件结构先定义为后续 SSE/WebSocket 复用。
- 后续如要使用 LLM function calling，应通过 TypeScript Model Gateway 接入 OpenAI/Claude 等 provider，并复用同一套 tool schema。

## Phase 10：真实视觉 Embedding

目标：

用真实模型替换 mock vectors，让图片和视频关键帧具备语义检索能力。

交付物：

- TypeScript Model Gateway 添加 embedding job 接口。
- 添加本地 Python model service，用于搜索时同步生成 query embedding。
- Python worker 接入 OpenCLIP 或 SigLIP。
- `index_media` 完成 assets 创建后，由 TypeScript server 或索引协调任务扫描 pending vector_refs，并创建下游 `embed_image` / `embed_video_frame` jobs。
- 对图片生成 image vectors。
- 对视频关键帧生成 frame vectors。
- 为模型名称、维度、版本写入 `vector_refs`。
- 支持 CPU、Apple Silicon MPS、NVIDIA CUDA 的设备选择。

验收标准：

- 文本查询可以召回语义相关图片。
- 文本查询可以召回语义相关视频片段。
- 同一张图片重新索引不会重复写入向量。
- 模型版本变化时可以重建对应 collection。
- 搜索路径不通过异步 job 等待 query embedding；TypeScript Retrieval Service 通过 localhost RPC 获取 query vector。
- `index_media` 与真实 embedding 解耦，mock 阶段和真实 embedding 阶段可以平滑切换。

## Phase 11：视频 Scene Segmentation

目标：

用 PySceneDetect 替换固定 30 秒切片，提高视频片段语义完整性。

交付物：

- 为视频创建 scene detection job。
- 保存 scene start/end 到 `media_assets`。
- 每个 scene 选择 1 到 3 个关键帧。
- `video_segment_vectors` 默认使用代表帧 embedding，不对视觉差异大的 scene 做简单平均。
- 如果后续引入聚合，必须在 `vector_kind` 或 payload 中记录聚合策略。
- 支持短 scene 合并，避免返回大量碎片。
- 保留固定时间切片作为 fallback。

验收标准：

- 视频详情页可以展示 scene 列表。
- 搜索结果返回 scene 范围，而不是机械 30 秒片段。
- Scene detection 失败时仍可退回固定切片。

## Phase 12：语音转写与文本检索

目标：

让视频和音频中的讲话内容可搜索。

交付物：

- Python worker 接入 faster-whisper 或 whisper.cpp。
- 为视频/音频创建 transcription job。
- 将 transcript 按 15 到 30 秒切成 text chunks。
- 将 transcript 写入 PostgreSQL。
- 添加 PostgreSQL full-text search。
- 可选为 transcript chunks 生成 text embeddings。

验收标准：

- 用户可以搜索视频或音频中说过的话。
- 搜索结果返回对应文件和时间范围。
- Transcript 搜索可以和向量搜索结果合并展示。

## Phase 13：OCR 与画面文字检索

目标：

让图片、视频关键帧、PPT 录屏、海报和字幕烧录内容可搜索。

交付物：

- Python worker 接入 PaddleOCR 或 EasyOCR。
- 对图片和视频关键帧执行 OCR。
- 将 OCR 文本写入 media assets。
- 将 OCR 文本纳入 PostgreSQL full-text search。
- 支持按 OCR 命中原因展示搜索结果。

验收标准：

- 可以通过画面文字找到图片。
- 可以通过画面文字找到视频时间段。
- OCR 任务可以按 library 或单文件触发，不强制全库执行。

## Phase 14：Hybrid Retrieval 与 Reranking

目标：

组合向量召回、全文检索和 metadata filters，提高搜索准确率。

交付物：

- 实现统一 retrieval pipeline。
- 合并 Qdrant vector results、PostgreSQL FTS results 和 metadata filters。
- 对相邻视频命中做去重和合并。
- 添加基础 reranking 规则。
- 在结果中展示命中原因：`vector_match`、`transcript_match`、`ocr_match`、`metadata_filter`。

验收标准：

- 同一视频相邻命中不会刷屏。
- 搜索结果能说明主要命中原因。
- 图片、视频、音频、文本可以在同一个 Search 页面查询。

## Phase 15：外部多模态模型验证

目标：

用外部多模态模型检查少量候选结果，提升复杂视觉查询准确率。

交付物：

- 在 TypeScript Model Gateway 中添加 external VLM provider 接口。
- 添加 `inspect_candidates_with_vlm` agent tool。
- 只向外部模型发送 top candidates 的关键帧或缩略图。
- 添加前端开关 `allow_external_vlm`。
- 在结果中展示 VLM 解释和置信判断。

验收标准：

- 默认不调用外部多模态模型。
- 用户开启后，复杂视觉查询可以得到更准确的候选排序。
- 日志记录哪些候选被发送给外部模型。

## Phase 16：Clip Workspace 与 Montage

目标：

把搜索结果转成可编辑、可导出的片段集合。

交付物：

- 添加 clip workspace 数据模型。
- 支持收藏多个 segments。
- 支持调整 start/end。
- 支持批量导出 clips。
- 支持用 FFmpeg 拼接 montage。
- Agent 可以生成剪辑计划，但导出前需要用户确认。

验收标准：

- 用户可以从搜索结果收集多个片段。
- 用户可以调整片段边界。
- 可以导出单个 clip 或 montage。
- Agent 不会在未经确认时批量导出。

## Phase 17：索引运维与性能控制

目标：

让 1 TB 级素材库的索引过程可控、可暂停、可恢复。

交付物：

- 添加 indexing profiles：`light`、`balanced`、`dense`。
- 支持按 library、目录、文件类型触发索引。
- 支持暂停、恢复、重试失败 jobs；这些能力由 PostgreSQL job state 和 worker 检查点实现。
- 添加并发控制和 worker 队列分组。
- 添加索引统计：文件数量、向量数量、缓存大小、失败数量。
- 添加缓存容量统计和清理入口，优先清理可重建的 thumbnails、frames 和 OCR/transcript cache。

验收标准：

- 用户可以先 light index 全库，再对重点目录 dense index。
- 索引失败不会阻塞整个 library。
- UI 能展示当前索引成本和进度。

## Phase 18：本地部署与可维护性

目标：

让不熟悉 Python 的用户也能稳定启动、升级和排查本地系统。

交付物：

- 完善 README 的一键启动步骤。
- 添加 `.env.example` 注释。
- 添加常见问题排查文档。
- 添加日志目录和日志格式。
- 添加数据库备份和恢复说明。
- 添加模型缓存目录说明。

验收标准：

- 新开发者可以按文档启动系统。
- 常见失败能从日志和文档定位。
- 升级不会破坏已有 metadata 和索引引用。

## 实施约束

- 默认不复制、不上传原始媒体。
- 前端、TypeScript server 和 Python worker 保持独立进程。
- Qdrant payload 保持轻量，PostgreSQL 是事实来源。
- 重型任务必须在 Python worker 中运行，不能放在 NestJS controllers 中。
- 外部多模态模型默认关闭，只处理候选样本。
- 第一版保持足够小，以验证完整产品闭环。
