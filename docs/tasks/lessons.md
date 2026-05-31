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

如果 MVP 不使用 LLM function calling，规则路由必须明确关键词、fallback 和失败行为。自然语言中包含搜索类关键词时调用 `search_media`，包含导出/剪辑类关键词且有明确片段时调用 `export_clip`，无法解析且 query 为空时返回无法理解提示。

## 2026-05-28：实施必须分阶段确认和记录进度

项目进入实施阶段后，必须按 Phase 推进。每个 Phase 完成后停止并等待用户确认，不能自动进入下一阶段。实施过程中必须持续更新 `docs/tasks/todo.md` 的 checkbox 和 Review 区域，便于中断后恢复。关键跨语言、任务调度、向量写入、FFmpeg 命令和 agent routing 代码必须写简洁注释，说明设计边界和原因。
