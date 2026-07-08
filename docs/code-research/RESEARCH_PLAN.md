# 研究计划与总览

## 研究摘要

**它是什么**：这是一个本地优先的多模态媒体检索与剪辑系统，用 NestJS 后端、Python 媒体 worker、本地模型服务、Qdrant、PostgreSQL 和 Next.js 前端共同管理个人图片、视频、音频与文本素材库。

**解决什么问题**：它让约 1 TB、以视频为主的个人媒体库可以在本机完成扫描、探测、视觉向量索引、语音转写、画面文字识别、混合搜索、媒体详情查看和剪辑导出；没有它，用户需要在文件系统、播放器、转写工具、OCR 工具和剪辑工具之间手工切换，且难以跨语义、画面、字幕和讲话内容统一检索。

**谁在使用**：目标用户是拥有大量本地素材的个人创作者、研究者或内容整理者。使用方式是先注册本地目录，后台索引派生资产，再在 Web 工作台里搜索、查看片段、触发导出，必要时通过 Agent 发起高层任务。

## 核心价值

项目的核心价值不是“调用大模型搜索媒体”，而是把本地媒体库变成一个可恢复、可审计、可增量处理的检索系统：PostgreSQL 保存事实和任务状态，Qdrant 只做向量召回，Python 只执行媒体和模型重任务，TypeScript 维护产品协议和编排边界。这个分工让系统默认离线、隐私边界清楚，同时保留后续接入外部模型验证候选的空间。

## 专题索引

| 文件 | 主题 | 阅读用途 |
| --- | --- | --- |
| `01_architecture.md` | 架构全景 | 先建立进程、模块、存储和边界的整体图 |
| `02_mechanism_retrieval_and_jobs.md` | 核心机制 | 理解任务管线、索引、搜索、Agent 和剪辑机制 |
| `03_data_flow.md` | 数据流与状态 | 追踪 library、file、asset、vector ref、job、agent event 的状态变化 |
| `04_dependencies.md` | 依赖与生态 | 理解为什么使用 NestJS、Drizzle、Qdrant、SigLIP、Whisper、PaddleOCR 等 |
| `05_workflow.md` | 核心工作流 | 端到端走读扫描、索引、检索、转写、OCR、导出、Agent |
| `06_learning_path.md` | 源码阅读路径 | 给新贡献者的前置知识与推荐读码顺序 |
| `07_evolution_history.md` | 演进历史 | 基于 Git 提交梳理真实阶段路线 |
| `08_implementation_map.md` | 实现地图 | 把历史阶段映射到当前模块、接口和存储 |
| `09_design_evolution.md` | 从 0 设计推演 | 从第一性原理解释为什么系统长成现在这样 |
| `10_day0_product_technical_design.md` | Day 0 复原 | 反推作者开工第一天的产品边界和技术方案 |
| `11_quality_map.md` | 质量地图 | 基于源码证据识别维护风险和测试缺口 |

## 设计亮点

1. **事实源和召回源分离**：`apps/server/src/database/schema.ts` 中的 `media_files`、`media_assets`、`vector_refs` 是事实结构，`docs/vector-index-design.md` 明确 Qdrant 只存向量和轻量 payload，`SearchService` 命中后必须回 PostgreSQL 补齐事实字段。
2. **跨语言协议由 TypeScript 维护**：`packages/shared/schemas/index.ts` 定义 job 输入输出，`packages/shared/generated/job-schemas.json` 给 Python 使用；Python 的 `repository.py` 使用 raw SQL，而不维护另一套 ORM。
3. **在线 embedding 与批量 embedding 分离**：搜索 query 通过 `SearchQueryVectorService` 同步调用 `model_service`；媒体批量 embedding 则由 `embed_image`、`embed_video_frame` jobs 写 Qdrant。
4. **文本检索复用同一列**：转写文本和 OCR 文本都写入 `media_assets.text_content`，通过 `text_tsv` 和 GIN 索引被 FTS 查询；`SearchService` 按 asset type 映射为 `transcript_match` 或 `ocr_match`。
5. **混合搜索语义先行**：Phase 14 在 `search-hybrid.ts` 中把同 asset 和相邻视频窗口合并、保留 `merged_asset_ids`，并用稳定归一化和权重生成 `hybrid_score`。
6. **Agent 默认隐私保护**：`AgentService` 在 `ALLOW_EXTERNAL_LLM=false` 时不调用外部模型；启用后 `agent.tools.ts` 去掉本地路径和全文；副作用工具只写确认事件，用户确认后才创建 job。

## 源码阅读路线摘要

推荐按“协议和数据模型 → 后端编排 → Worker 执行 → 搜索合并 → 前端工作台”的顺序读：

1. `packages/shared/constants/index.ts`、`packages/shared/schemas/index.ts`
2. `apps/server/src/database/schema.ts`、`apps/server/src/database/repositories.ts`
3. `apps/server/src/app.module.ts`、各模块 controller/service
4. `apps/worker-py/media_agent_worker/worker.py`、`repository.py`
5. `scan.py`、`probe.py`、`indexing.py`、`embedding_worker.py`
6. `transcription.py`、`ocr.py`、`exporting.py`
7. `apps/server/src/search/search.service.ts`、`search-hybrid.ts`
8. `apps/server/src/agent/agent.service.ts`、`agent.tools.ts`
9. `apps/web/lib/api-client.ts`、各 `*-workspace.tsx`

## 主要历史演进路线

```mermaid
flowchart LR
  A["初始化：文档、monorepo、健康检查"] --> B["Phase 3-5：数据库、job 队列、worker、索引骨架"]
  B --> C["Phase 6：Qdrant 检索与 PostgreSQL 回表"]
  C --> D["Phase 7-8：前端工作台、媒体详情、剪辑导出"]
  D --> E["Phase 9-10：Agent、真实 SigLIP、本地 model service"]
  E --> F["Phase 11：视频场景切分与关键帧"]
  F --> G["Phase 12-13：语音转写、OCR、FTS"]
  G --> H["Phase 14：混合召回、合并排序、注释补强"]
```

## 当前实现地图摘要

- 用户操作入口：`apps/web` 页面和 `apps/server` controller。
- 事实状态：PostgreSQL 表 `libraries`、`media_files`、`media_assets`、`vector_refs`、`jobs`、`agent_*`。
- 异步执行：Python `WorkerRunner` claim job，再分发给 scan、probe、index、embedding、transcribe、OCR、export handlers。
- 召回索引：Qdrant collections 由 TypeScript 注册表初始化，points 由 Python embedding jobs 写入。
- 搜索合并：`SearchService` 聚合向量结果和 FTS 结果，`buildHybridResults` 做纯函数 rerank。
- 外部模型边界：默认关闭，只在 Agent 模块中通过配置启用，并经过脱敏和确认守卫。

## 第一性原理设计路线摘要

最小设计可以只是“递归扫描目录并按文件名搜索”。暴露的问题是文件名无法表达画面、讲话内容、字幕、时间片段和相似语义。于是系统新增派生资产、向量索引、转写、OCR 和片段级时间范围。再暴露的问题是媒体处理耗时、跨语言模型生态复杂、搜索低延迟要求和隐私要求冲突。当前代码用 PostgreSQL job 队列、本地 model service、Python worker、Qdrant 回表和 Agent 守卫解决这些问题，代价是运行拓扑变成五个进程，协议一致性和运维说明成为重要维护面。

## Day 0 产品与技术方案复原摘要

作者 Day 0 很可能先定义了三个边界：源文件不复制不上传、默认外部 LLM 关闭、面向视频重素材库。MVP 技术方案不是云端媒体平台，而是本地 Web 工具：NestJS 提供 API 和任务创建，Python worker 执行媒体处理，PostgreSQL 存事实与任务，Qdrant 存向量，Next.js 提供工具型界面。证据来自 `README.md` 的目标陈述、`docs/architecture.md` 的“TypeScript 主控，Python 辅助”、`docs/tasks/lessons.md` 的架构决策记录，以及当前源码的模块边界。

## 质量与维护风险摘要

- **中高风险：跨语言常量重复**。`VECTOR_COLLECTIONS` 与 Python `VECTOR_CONFIGS` 手工保持一致，已有注释提醒必须对齐；如果未来模型版本变化，仍可能 drift。
- **中风险：worker 长任务 heartbeat 粒度粗**。`WorkerRunner.run_once()` 只在任务开始前 heartbeat，长转写、OCR、embedding 期间没有统一续约机制，依赖较大的 timeout。
- **中风险：FTS 中文召回有限**。`listTextSearchResultMetadata()` 使用 PostgreSQL `simple` 配置，中文无分词优化，文档也承认后续要优化。
- **中风险：运行拓扑复杂**。端到端需要 PostgreSQL、Qdrant、server、model service、worker、web；README 已解释，但开发和故障排查门槛仍高。
- **低到中风险：仓库层文件变大**。`apps/server/src/database/repositories.ts` 和 Python `repository.py` 集中了大量查询，优点是边界清楚，缺点是后续继续增长会影响可定位性。

## 待解决疑问

1. `job-protocol.md` 描述了 `cancel_requested`、`cancelled`、`stale` 等 job 状态，但当前 Python `WorkerRunner` 对取消检查还很薄，是否计划在长任务边界增加取消语义？
2. Qdrant collection 重建会重置 PostgreSQL `vector_refs`，但旧 Qdrant point 删除和 PostgreSQL stale asset 的长期清理策略是否需要一个专门维护任务？
3. 文本向量 collections 已预留，Phase 14 仍主要依赖 FTS；后续接入文本 embedding 时，是扩展 model service，还是新增单独文本 embedding service？
4. 当前搜索 query embedding 只调用 SigLIP text encoder，文本 transcript/OCR FTS 走 PostgreSQL；用户可能以为所有文本搜索都做语义检索，需要 UI 或文档更明确地区分。
5. 当前工作区存在未提交改动，本研究基于当前文件系统状态和 Git 历史共同判断；如果这些改动尚未定稿，部分前端和 worker 细节可能随下一次提交变化。

## 执行记录

- 研究日期：2026-07-07。
- 执行方式：当前会话未获得明确子代理授权，因此由主流程完成全量研究；没有修改业务代码。
- 主要证据：`README.md`、`docs/architecture.md`、`docs/job-protocol.md`、`docs/vector-index-design.md`、`docs/tasks/todo.md`、`docs/tasks/lessons.md`、核心源码、测试文件、`git log` 和 commit stat。
