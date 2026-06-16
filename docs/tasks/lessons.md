# Lessons

## 2026-05-27：计划文档需要解释不熟悉的技术栈

当实施计划面向不熟悉 Python 生态的读者时，不能只列工具名。需要说明每个 Python 工具负责什么、为什么选择它、它不应该承担什么职责，以及它在整体架构中的边界。后续计划文档应避免假设读者理解 FastAPI、Dramatiq、Celery、SQLAlchemy、Qdrant client、FFmpeg/PySceneDetect、Whisper、OCR、LangGraph 等工具链。

## 2026-05-27：MVP 任务队列默认使用 Dramatiq

该记录已被 2026-05-28 的 TypeScript 主控方案取代。此前在 Python 主后端设想下，初期优先选择 `Dramatiq + Redis`，因为它比 Celery 更轻，适合本地 MVP 的扫描、索引、转写和剪辑导出任务。现在主控层改为 TypeScript 后，默认改为 PostgreSQL-backed jobs，Python worker 只负责 claim 和执行任务。

## 2026-05-27：向量数据库必须先定义结构

Qdrant 不能只被描述为“存向量”。计划文档需要定义 collection、point id、payload、payload index、PostgreSQL `vector_refs` 关系、模型版本和重建策略。Qdrant 只做向量召回和轻量过滤，完整 metadata 必须回 PostgreSQL 查询。

## 2026-05-27：评审建议需要校正后吸收

收到外部 review 时，不应直接照单全收。需要校验数字和前提，再把合理建议落进文档。例如 1 TB 视频按 5 Mbps 约 440 小时；本项目视频约 2/3 TB，因此资源估算应按约 150-300 小时视频和 100K-1M vectors 的区间设计，而不是直接沿用 review 中的粗估。

## 2026-05-27：工具型产品 UI 参考设计稿时必须工具化适配

本项目是媒体管理和检索工具，不是营销展示页。前端规划可以参考用户提供的 `DESIGN.md` 的色彩、圆角、影像优先和组件质感，但布局和信息密度必须工具化适配，优先满足 Library、Search、Jobs、Media Detail 和 Agent 等高频工作流。

## 2026-05-28：主语言改为 TypeScript，Python 只做重任务 worker

当用户希望主语言使用 TypeScript 时，架构应调整为 `Next.js + NestJS + Drizzle + Qdrant JS client` 的 TS 主控层，Python 只负责 FFmpeg、PySceneDetect、embedding、Whisper、OCR 等媒体/模型任务。跨语言任务调度优先使用 PostgreSQL-backed jobs，避免让 TS 直接绑定 Dramatiq/Celery 的 Python 队列协议。

## 2026-05-29：后端框架优先可维护性，使用 NestJS 默认 Express adapter

用户明确希望从 Fastify 切换到 NestJS，以获得严格模块化管理。当前用户量级下，极致 HTTP 性能不是最初目标；后续实现应优先使用 NestJS 的 `Module`、`Controller`、`Service` 和 provider 注入边界。默认使用 Express adapter，不引入 Fastify adapter，除非后续压测证明 HTTP 层成为瓶颈。

## 2026-05-28：跨语言边界必须定义协议

TS 主控 + Python worker 的最大风险是 schema drift 和任务协议不清。TypeScript 应维护 Drizzle schema 和 Zod job schemas，Python worker 不维护独立 ORM 模型，只用 raw SQL 或极薄 query helper，并用生成的 JSON Schema 校验 `input_json`。所有 job 类型必须在 `docs/job-protocol.md` 中定义 input/output。

## 2026-05-28：在线 query embedding 不走异步 job

搜索链路需要低延迟 query embedding。真实 embedding 阶段应提供本地 Python model service，常驻加载模型并监听 localhost RPC；TypeScript Retrieval Service 同步调用它获取 query vector。批量索引仍走 PostgreSQL-backed jobs。

## 2026-05-28：Qdrant 写入归属统一给 Python worker

为避免 TS 与 Python 之间传递大向量数组，并避免 mock vectors 和真实 embeddings 写入路径不一致，Qdrant point 写入统一由 Python worker 负责。TypeScript server 只负责 collection 管理、搜索读取和结果回 PostgreSQL 补齐。

## 2026-05-28：Agent MVP 规则路由必须可实现

该记录已被 2026-05-31 的 Vercel AI SDK 方案取代。原方案使用关键词规则路由，现改为使用 Vercel AI SDK 的 LLM function calling，直接由 LLM 决定调用哪个 tool，不再需要手写关键词匹配逻辑。

## 2026-05-31：Agent Runtime 使用 Vercel AI SDK，不使用 pi-agent / Mastra / LangGraph

对比 pi-agent、Mastra、Vercel AI SDK 和 LangGraph 后选择 Vercel AI SDK，原因：
- Tool 定义使用 Zod schema，与项目 `packages/shared` 的 schema 体系一致，无双 schema 问题。
- 核心只负责 LLM 调用和 tool 执行循环，不接管存储、向量或部署，不与现有 PostgreSQL/Drizzle、Qdrant、Python worker 架构冲突。
- `generateText`/`streamText` 是纯函数，与 NestJS service 直接集成，无框架适配器摩擦。
- Mastra 虽然有 NestJS adapter 和 Zod 支持，但它是一个全栈 AI 框架，会与现有存储和向量层大面积重叠，对 4-tool coordinator 来说过重。
- pi-agent 使用 TypeBox schema（与 Zod 冲突）且为 coding agent 设计，不适合本项目。
- LangGraph JS 可用于 TypeScript，但它偏底层状态图编排；对当前 4-tool coordinator 来说过重，先不引入。

## 2026-05-31：LLM 只建议，有副作用的工具必须由服务端守卫

Agent 可以用 LLM function calling 选择工具，但不能把本地写入、剪辑导出、全库索引等副作用动作的最终授权交给 LLM。`export_clip` 必须有明确 `file_id`、时间范围、用户显式导出意图和前端确认 token；`create_index_job` 必须有明确 library/path 范围和用户显式索引意图。外部 LLM 调用默认关闭，开启后也只发送脱敏候选摘要，不发送源媒体、绝对路径、完整 transcript 或 OCR 全文。

## 2026-05-28：实施必须分阶段确认和记录进度

项目进入实施阶段后，必须按 Phase 推进。每个 Phase 完成后停止并等待用户确认，不能自动进入下一阶段。实施过程中必须持续更新 `docs/tasks/todo.md` 的 checkbox 和 Review 区域，便于中断后恢复。关键跨语言、任务调度、向量写入、FFmpeg 命令和 agent routing 代码必须写简洁注释，说明设计边界和原因。

## 2026-06-02：Python、server、数据库和 SDK 代码需要解释性注释

用户不熟悉部分 Python、server、数据库和 SDK 细节时，注释不能只追求短。后续实现 Python worker、NestJS server、Drizzle/PostgreSQL、Qdrant、FFmpeg/ffprobe、Vercel AI SDK 或模型 SDK 相关代码时，必须在关键边界写清楚该代码在整体链路中的位置、为什么使用当前 API/SQL/SDK 调用、跨语言字段约定、幂等和失败处理边界，以及哪些职责不应该提前放到这里。避免逐行复述代码，但要让读者无需熟悉这些工具也能理解维护风险和排查入口。

## 2026-06-09：依赖名称必须按官方安装方式核对

新增第三方依赖前必须核对官方安装说明和当前 Python 版本要求，不能把 backend 需求误写成不存在或不推荐的 pip extra。例如 PySceneDetect 官方标准安装包是 `scenedetect`，server/no-GUI 替代包是 `scenedetect-headless`；项目升级到 Python 3.12 后可使用 `scenedetect>=0.7,<1`。后续 dependency 文档、requirements 和错误提示必须使用同一套官方包名。

## 2026-06-12：CLI 配置需要独立验证 `.env` 加载

新增 `drizzle-kit`、worker、脚本或其他 CLI 入口时，不能假设它们会复用应用启动入口的 `.env` 加载逻辑。后续给 package scripts 增加命令后，必须用只读方式验证该命令解析到的关键环境变量，例如 `DATABASE_URL`，避免 CLI silently 使用 fallback 配置连接错误数据库。

## 2026-06-16：重索引 upsert 不能清空后续 job 写入结果

同一 asset 可能由多个 job 分阶段补充字段，例如 `index_media` 创建视觉 asset，`run_ocr` 后续写入 `text_content` 和 `metadata_json.ocr`。后续重索引的 upsert 只能覆盖它负责的输入字段；未显式提供的文本、OCR metadata、转写结果等派生字段必须保留或按 jsonb patch 合并，不能用空值或 `{}` 整体替换。

## 2026-06-16：Job schema 只能声明已实现能力

`packages/shared` 的 job Zod schema 和生成 JSON Schema 是跨语言事实来源，不能把“未来可能支持”的 engine/provider 写进 enum。未实现能力只可在规划文档中标为 future work；一旦进入 schema，worker 必须真实支持，否则会造成契约说谎和队列失败。

## 2026-06-16：文档化参数必须在 controller/service 测试中接线

API contract 或 implementation plan 一旦声明 request 字段、环境变量或默认值，就必须有对应 controller 透传测试和 service 行为测试。不能只在文档中写 `limit`、`OCR_BATCH_SIZE` 之类参数，却在实现里硬编码或静默丢弃。

## 2026-06-16：Worker 默认路径必须跨平台

Python worker 的默认缓存、临时文件和模型目录不能写死 macOS 专属路径，例如 `/private/tmp`。默认值应使用 `tempfile.gettempdir()` 或项目 `.media-agent/` 约定目录，并始终允许环境变量覆盖，确保 Linux/container worker 可运行。
