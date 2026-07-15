# AGENTS.md

本文档用于指导 Codex（Codex.ai/code）在本仓库中进行代码开发与维护。

## 项目概览

这是一个本地优先的多模态媒体检索与编辑智能体。主 API 使用 TypeScript/NestJS（`apps/server`）；Python Worker（`apps/worker-py`）及独立的 Python 模型/VLM 服务负责媒体和模型任务；前端使用 Next.js（`apps/web`）；共享 Schema 位于 `packages/shared`。目标是支持约 1 TB、以视频为主的个人媒体库。默认关闭外部 LLM；所有检索均使用本地模型，包括 SigLIP、faster-whisper、PaddleOCR，以及在启用 Caption 索引或重排时通过本地 Ollama 使用的 Qwen2.5-VL。

## 常用命令

```bash
pnpm install

# 完整工作区检查（shared + server + web：类型检查 + 测试；shared 还会重新生成 JSON Schema）
pnpm check

# 按工作区检查
pnpm --filter @local-media-agent/shared check     # generate:schemas + typecheck + test
pnpm --filter @local-media-agent/server check      # typecheck + test
pnpm --filter @local-media-agent/web check         # typecheck + test + next build

# 开发模式（并行启动 server :4000 和 web :3000；不包含 Python 服务）
pnpm dev
pnpm --filter @local-media-agent/server dev        # server 使用 SERVER_PORT，默认 4000
pnpm --filter @local-media-agent/web dev           # web 使用 :3000

# Python Worker 测试（从仓库根目录运行）
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests

# 单项测试
pnpm --filter @local-media-agent/server exec vitest run tests/search/search.service.test.ts   # 按文件
pnpm --filter @local-media-agent/server exec vitest run -t "returns ocr_match"                 # 按测试名称
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_ocr_worker.py

# 数据库迁移（不会随 `dev` 自动执行；拉取新迁移后必须手动应用）
corepack pnpm --filter @local-media-agent/server exec drizzle-kit generate   # 根据 Schema 变更生成迁移
corepack pnpm --filter @local-media-agent/server db:migrate                   # 应用迁移

# Docker 服务（PostgreSQL、Qdrant；Redis 通过 --profile realtime 按需启用）
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres qdrant
docker compose --env-file .env -f infra/docker-compose.yml config             # 校验配置

# Python 运行环境
python3.12 -m venv .venv && .venv/bin/python -m pip install -r apps/worker-py/requirements.txt
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker                # Worker
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker.model_service  # 模型服务 :4020
pnpm dev:vlm                                                                 # VLM Caption 服务 :4030；默认调用 Ollama :11434
```

如果直接运行 `pnpm` 失败，使用 `corepack pnpm`（或执行 `corepack enable`）。只要修改了 Zod Job Schema，就必须在运行 Server/Python 测试前重新生成 JSON Schema；`shared check` 会执行该操作。

## 本地运行拓扑

端到端检索需要同时运行以下五类服务；Caption 索引或重排还需要第六个本地服务：

1. **PostgreSQL + Qdrant**：通过 `infra/docker-compose.yml` 启动。
2. **NestJS Server**（`:4000`）：提供 HTTP API、创建任务、读取 Qdrant、执行全文检索和智能体运行时，并拥有数据库 Schema。
3. **Python Worker**（`media_agent_worker`）：通过 `FOR UPDATE SKIP LOCKED` 从 PostgreSQL 领取任务，执行扫描、探测、索引、向量化、转录、OCR、Caption 和剪辑任务，并写入 Qdrant、`media_assets` 与 `vector_refs`。
4. **Python 模型服务**（`model_service`，`:4020`）：封装 SigLIP 和延迟加载的 Caption 文本嵌入模型。它与 Worker 是两个不同进程；Server 在搜索时同步调用该服务生成查询文本向量。缺少该服务时，`/search` 无法进行向量检索，但 Worker 的批量媒体向量化仍可运行。
5. **Next.js Web**（`:3000`）。
6. **Python VLM 服务**（`vlm_service`，`:4030`）：提供 `/caption`；默认使用 `OLLAMA_VLM_MODEL`（例如 `qwen2.5vl:7b`）调用 Ollama `:11434`。仅在 `CAPTION_INDEXING_ENABLED=true` 且 `LOCAL_VLM_ENABLED=true`，或后续启用 VLM 重排时需要。

## 架构

### Monorepo 目录

- `apps/server`：NestJS API（Express 适配器、ESM），负责业务逻辑、HTTP 接口、数据库访问、Qdrant 读取、智能体运行时和搜索。
- `apps/worker-py`：Python 3.12 Worker，负责领取任务并执行媒体/模型任务，只使用原生 SQL，不使用 ORM；同时包含同步嵌入 HTTP 服务 `model_service.py` 和本地 VLM Caption 服务 `vlm_service.py`（默认 Ollama 后端）。
- `packages/shared`：Zod Schema、TypeScript 类型、常量、供 Python Worker 使用的生成版 JSON Schema，以及 API Client。**所有 Schema 均以 TypeScript 为唯一权威来源。**
- `apps/web`：Next.js 16 / React 19 / Tailwind 4 前端。
- `infra/`：PostgreSQL、Qdrant 和可选 Redis 的 Docker Compose 配置。
- `docs/`：架构、API 契约、任务协议、向量索引设计、实施计划和任务跟踪文档。

### 核心模式

**TypeScript 是 Schema 的唯一权威来源。** Drizzle Schema 位于 `apps/server/src/database/schema.ts`，Zod Job Schema 位于 `packages/shared/schemas/`。Python 通过 `jsonschema` 读取生成的 `packages/shared/generated/job-schemas.json`，不得导入 TypeScript，也不得维护独立的数据模型。

**使用 PostgreSQL 实现任务队列。** TypeScript Server 创建 `status='queued'` 的任务；Python Worker 使用 `SELECT ... FOR UPDATE SKIP LOCKED` 领取任务。不使用 Dramatiq、Celery 或 BullMQ。详见 `docs/job-protocol.md`。

**文件索引状态由第一个可检索向量决定。** Worker 成功向 Qdrant 写入任一活跃 vector ref 后，`mark_vector_ref_indexed(point_id)` 必须在同一事务内同时更新 `vector_refs.status='indexed'` 和对应活跃文件的 `media_files.index_status='indexed'`。文件无需等待所有 pending/failed ref 完成即可计入素材库 `indexed_count`；迁移 `0002_backfill_indexed_media_files.sql` 用于修复历史数据。

**存在两条不同的嵌入路径，禁止混淆。**

- *批量媒体嵌入（索引阶段）*：`index_media` 创建 `pending` 状态的 `vector_refs`，随后由 Worker 的 `embed_image`、`embed_video_frame`、`embed_text_asset` 任务写入 Qdrant，并将 `vector_refs.status` 更新为 `indexed`。大向量不得通过 TypeScript 与 Python 的任务参数传递；Worker 必须直接读写 Qdrant。
- *同步查询嵌入（搜索阶段）*：`/search` → `SearchQueryVectorService` → `ModelGatewayService.embedText` → `model_service:4020`。查询嵌入必须感知目标模型：SigLIP collection 使用 SigLIP 文本塔，`caption_text_vectors` 使用 Caption 文本嵌入模型。该路径必须同步执行；放入任务队列会导致搜索被索引任务阻塞。
- *Caption 索引*：启用 `CAPTION_INDEXING_ENABLED=true` 和 `LOCAL_VLM_ENABLED=true` 后，图片使用单图 `caption-v1`；每个视频片段使用 `scene-caption-v2`，并将同一场景中按时间排序的 1 至 `SCENE_CAPTION_MAX_FRAMES` 帧发送给 Qwen2.5-VL。Worker 记录源 asset ID、时间、模型和 Prompt 来源，写入 `caption_text_vectors`，并在成功或失败时清理所有临时图片。
- *Caption 版本隔离*：`caption-v1` 只允许用于图片；视频 Caption 必须使用包含稳定 `scene_id` 的 `scene-caption-v2`。即使 Qdrant 中仍残留 stale 点，搜索回表也必须拒绝 stale asset 以及旧版或格式错误的视频 Caption。迁移 `0004_stale_legacy_video_captions.sql` 将已被 v2 覆盖的旧视频 Caption asset 和 ref 标记为 stale，避免旧时间窗口 Caption 与场景候选重复。
- *视频场景检索*：场景检测窗口（包括使用稳定 ID 的降级窗口）最长为 `SCENE_MAX_SECONDS`，默认 30 秒。每个活跃 `video_segment` 必须至少包含一个同场景 `video_frame`；只有帧会创建新的视觉向量。搜索保留原始帧分组，在顶层按 `(file_id, scene_id)` 使用 MaxSim 折叠视频候选，并从 PostgreSQL 获取场景边界。`VIDEO_SEGMENT_SEARCH_ENABLED` 仅用于迁移；只有在人工确认 `GET /jobs/video/reindex-readiness` 已就绪后才能关闭。

**任务流水线会自动触发，并提供协调补偿接口。** Worker 内部任务完成后会创建下一阶段任务：`scan_library → probe_media → index_media`；`index_media` 随后扇出 `transcribe_audio`、`embed_*`（通过 pending `vector_refs`）、`run_ocr`（图片/视频帧），并在 Caption 开关启用时为图片/视频片段创建 `generate_caption`。Server 提供两个补偿接口，用于重新扫描并补齐自动触发遗漏的任务：`POST /jobs/embedding/queue-pending` 处理 pending `vector_refs`，`POST /jobs/ocr/queue-pending` 处理缺少 OCR 的图片/视频帧。

**全文检索数据与 `media_assets` 共置。** `media_assets.text_content`、生成列 `text_tsv`（`to_tsvector('simple', ...)`）及 GIN 索引共同承载全文检索。转录文本（`text_chunk`）和 OCR（`image`/`video_frame`）都写入同一列，不维护独立搜索表。`SearchService` 查询 `text_chunk`、`image` 和 `video_frame`，并按 asset 类型映射 `reason`：`text_chunk → text_match`，`image`/`video_frame → ocr_match`。Phase 15A 中 Caption 不进入 FTS；Caption 通过 `caption_text_vectors` 检索并返回 `caption_match`。

**查询扩展必须有上限且可按请求做消融。** `POST /search` 的 `query_expansion_mode` 支持 `original | translate | expand`：`original` 必须完全跳过外部 Provider；`translate` 只能在保留原查询的基础上增加一个忠实翻译，并通过独立语义校验确认没有改变人物、物体、动作、关系或约束，缺失译文或校验失败必须显式报错；`expand` 才允许完整扩展。当 `QUERY_EXPANSION_PROVIDER=deepseek` 时，`QUERY_EXPANSION_MAX_VARIANTS` 默认值为 `3`，且包含原始查询。DeepSeek Prompt 和 Server 端标准化逻辑都必须强制该限制，不能只信任模型返回值。`include_diagnostics=true` 时可返回逐 Point 查询版本分数、胜出版本、Caption 原文和 Prompt 版本；默认响应和普通日志不得包含 Caption 等本地媒体内容。搜索耗时日志应暴露扩展、向量检索、FTS、混合排序和总耗时，但不得记录向量、API Key 或本地媒体内容。

**检索评测与生产排序隔离。** 内部 `/evaluation` 流程将冻结查询、盲标结果、来源证据、当前混合排序名次和实验性无权重 RRF 名次持久化到 PostgreSQL。基线评测关闭查询扩展和 `video_segment_vectors`，使用按场景折叠的视频帧召回，并以 `k=60`、单位权重将视觉、Caption 和全文信号视为独立通道。原始余弦分数只用于通道内部诊断；RRF 分数只表示顺序，不是概率。必需通道不可用或出现完整性错误时，评测运行必须失败，不得生成部分指标。

**NestJS 模块结构。** 每个领域都是独立模块，包括 config、health、database、libraries、jobs、media、search、clips、agent、qdrant 和 model-gateway。通过 Symbol Token 注入依赖：`DATABASE`（Drizzle）、`SETTINGS`（解析后的环境变量）、`QDRANT_CLIENT`、`PG_POOL`。业务代码不得直接导入基础设施实现。

**跨语言 `point_id` 必须一致。** Qdrant Point ID 使用确定性 UUIDv5（命名空间 `f3f4e35a-...`，输入使用 `|` 拼接）。TypeScript 的 `deterministicPointId` 与 Python 的 `uuid.uuid5` 必须生成完全相同的 ID；两端共同构成幂等 upsert 的事实标准。

**API 响应统一使用 snake_case。** Controller 的 `toResponse()` 方法负责将 Drizzle 的 camelCase 行转换为与 `docs/api-contract.md` 一致的 snake_case JSON。

**素材库文件浏览采用延迟加载和分页。** `GET /libraries/:id/media` 返回按 `(relative_path, id)` 排序的活跃文件，默认每页 25 条，最大 100 条。Web 素材库卡片折叠时不得请求文件；“加载更多”追加分页结果；折叠或请求失败时保留已加载内容；扫描任务创建成功后跳转 `/jobs`，由自动刷新展示进度。AppShell 根据 pathname 设置 `aria-current='page'`，标识当前导航和 Ask 页面。

**测试约束。** Server 的 repository/search/jobs 测试通过 `tests/database/test-db.ts` 使用进程内 PostgreSQL（PGlite），单元测试不依赖真实 PostgreSQL。健康检查测试使用 mock。Python 测试使用内存 repository double；OCR 和转录测试注入 fake，CI 不得下载 PaddleOCR 或 Whisper 权重。

### 各阶段 Python 模型依赖

- Phase 10：SigLIP（`torch`、`transformers`、`pillow`），用于图片和视频帧嵌入。
- Phase 11：`scenedetect`，用于视频场景检测。
- Phase 12：faster-whisper（CTranslate2），用于语音转录。
- Phase 13：PaddleOCR，用于图片和关键帧 OCR。
- Phase 15A：Qwen2.5-VL Caption 默认通过 Ollama 生成（`LOCAL_VLM_BACKEND=ollama`、`OLLAMA_VLM_MODEL=qwen2.5vl:7b`）。仍可使用旧的 Transformers 后端；此时设置 `LOCAL_VLM_BACKEND=transformers`，并依赖 `torch`、`torchvision`、`accelerate`、`pillow`。Caption 文本嵌入使用 `transformers` 对 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 做 mean pooling。

## Node/pnpm 注意事项

- Node >=22（`.nvmrc` 为 `22`）；pnpm >=10（`packageManager: pnpm@10.12.1`）。
- 全仓库使用 ESM（`"type": "module"`）。
- 本地 TypeScript import 必须包含 `.js` 扩展名，例如 `import { foo } from './bar.js'`。
- pnpm 会从各工作区自己的目录执行命令；Server 会在存在时从 Monorepo 根目录加载 `.env`。

## 文档索引

- `docs/architecture.md`：完整架构、模块边界和技术选型。
- `docs/api-contract.md`：前后端 HTTP API 契约。
- `docs/job-protocol.md`：任务类型、输入/输出 Schema、领取规则和 Worker 写入边界。
- `docs/vector-index-design.md`：Qdrant Collection、Point 结构、Payload 字段和 FTS。
- `docs/implementation-plan.md`：分阶段实施计划，目前记录至 Phase 13，包含交付物和验收标准。
- `docs/superpowers/plans/2026-07-08-vlm-caption-rerank.md`：Phase 15A/15B Caption 检索与 VLM 重排计划。
- `docs/tasks/todo.md`：阶段任务与评审记录。
- `docs/tasks/lessons.md`：架构决策及其原因。

## Agent 技能

### Issue 跟踪

需求、规格和实施 Issue 使用仓库内 `.scratch/` 的本地 Markdown 管理，不使用外部 PR 作为需求入口。详见 `docs/agents/issue-tracker.md`。

### 分诊标签

使用默认状态词汇：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库采用 single-context 领域文档布局，共享根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

## 面向初学者的沟通规范

用户是软件开发、RAG 和 Agent 领域的初学者。无论是在提出技术方案、解释问题、编写代码还是交付修改结果时，都必须以“用户只读一遍就能理解”为目标。不得假设用户已经掌握服务端、Python、数据库、向量检索、RAG、Agent 或评测体系的背景知识。

### 基本表达要求

1. **先给结论，再讲原因。** 开头先说明问题是什么、是否需要修改、最终会得到什么结果，再展开技术细节。
2. **任何可能陌生的技术概念首次出现时都必须解释。** 不能只解释文档已经列出的 RAG、RRF 或评测指标。框架、编程语言机制、Python 库、模型、算法、数据结构、数据库概念、网络协议、部署工具、并发方式、设计模式、配置项和缩写都属于需要解释的范围。使用“中文含义 + 英文全称或缩写 + 通俗原理 + 在本项目中的具体作用”的形式。例如：“RRF（Reciprocal Rank Fusion，倒数排名融合）是一种只利用各通道名次合并结果的方法”。不得连续使用未解释的缩写。
3. **不要用另一个陌生名词解释陌生名词。** 如果解释中引入新的专业词，也必须立即用通俗语言说明。
4. **区分事实、推断和建议。** 明确指出哪些结论来自代码、数据库或测试，哪些是根据证据作出的推断，哪些是下一步建议。
5. **说明为什么，而不只说明做什么。** 每个关键设计、工具和命令都要解释选择原因，以及不这样做可能产生的问题。
6. **避免跳步。** 跨服务或多阶段流程必须按时间顺序描述，不能只给出组件名称和箭头后让用户自行补全逻辑。
7. **使用具体例子。** 抽象概念应尽量配合本项目中的图片、视频场景、Caption 或查询示例说明。

### 项目基础术语

以下词语在项目中频繁出现，首次用于对话或方案时必须结合当前上下文解释：

- **Server（服务端）**：接收 Web 或其他客户端的 HTTP 请求，校验输入、读写数据库并组织返回结果的 NestJS 程序。
- **Worker（后台任务进程）**：从 PostgreSQL 领取耗时任务并在后台执行的 Python 程序。视频分析和模型推理耗时较长，因此不应阻塞普通 HTTP 请求。
- **API（应用程序接口）**：不同程序之间约定好的调用方式；本项目通常表现为 HTTP 地址、请求字段和返回 JSON。
- **Schema（数据结构约束）**：规定对象有哪些字段、字段类型以及是否必填。本项目由 TypeScript/Zod 统一定义任务 Schema，再生成 JSON Schema 给 Python 校验。
- **Asset（媒体资产）**：从一个文件派生出的可处理单元，例如整张图片、视频场景、视频帧、转录文本或 Caption。一个媒体文件可以拥有多个 asset。
- **Vector Ref（向量引用）**：PostgreSQL 中连接 asset 与 Qdrant 向量 Point 的记录，保存 collection、模型、Point ID 和索引状态，但不保存大向量本身。
- **Point（向量点）**：Qdrant 中的一条向量记录，由 ID、向量和 Payload 组成；搜索先返回 Point，再通过 Vector Ref 回 PostgreSQL 获取真实业务数据。
- **同步调用**：调用方必须等待结果返回后才能继续，例如搜索时生成查询向量。
- **异步任务**：请求先创建任务并立即返回，Worker 稍后处理，例如为长视频抽帧和生成 Caption。
- **Payload（附加字段）**：与 Qdrant Point 一起保存的少量筛选或调试信息；最终业务事实仍以 PostgreSQL 为准。

### 服务端与 Python 方案的说明要求

只要方案或代码涉及 NestJS Server、Python Worker、模型服务、VLM 服务、PostgreSQL 或 Qdrant，就必须清楚描述以下内容：

1. **每个组件负责什么。** 例如 Server 负责接收请求和读取检索结果，Worker 负责耗时的离线媒体处理，模型服务负责同步生成查询向量。
2. **谁调用谁。** 明确调用发起方、接收方和调用顺序。
3. **同步还是异步。** 解释同步调用是否会等待结果；异步任务由谁创建、保存在哪里、由谁领取。
4. **输入与输出。** 说明传入哪些关键字段、返回什么数据、数据最终写到哪里。
5. **状态如何变化。** 例如 `queued → running → succeeded`，或 `vector_refs.status: pending → indexed`。
6. **失败如何暴露和恢复。** 说明错误会记录在哪里、是否重试、是否可能产生部分数据，以及如何验证一致性。
7. **跨语言边界。** TypeScript 和 Python 共同参与时，说明 Schema 由谁定义、双方如何保证字段和 `point_id` 一致，以及为什么不直接传输大向量。

推荐采用下面的顺序说明一条技术链路：

```text
用户操作
→ Web 发起什么请求
→ Server 做什么校验和数据库操作
→ 是否创建异步任务
→ Python Worker 如何处理
→ 模型或 VLM 如何参与
→ PostgreSQL/Qdrant 分别保存什么
→ Server 如何读取并返回
→ 如何测试与排错
```

### 工具与命令的说明要求

调用终端、数据库、Qdrant、测试工具或迁移工具时，应向用户说明：

- 使用该工具要确认什么问题。
- 为什么选择它，例如 PostgreSQL 用于核对事实状态，Qdrant 用于核对真实向量点，单元测试用于防止同类问题回归。
- 操作是只读检查还是会修改数据。
- 修改数据前如何确认范围，修改后如何验证结果。
- 命令输出中的关键数字代表什么，不要只粘贴原始日志。

常见工具需要这样理解：

- **PostgreSQL**：关系型数据库，保存文件、asset、任务、向量引用和评测标注等结构化事实。
- **Qdrant**：向量数据库，保存向量并根据相似度返回候选 Point；它不替代 PostgreSQL 中的业务事实。
- **Drizzle Migration**：数据库迁移，用可追踪的 SQL 让不同环境按相同顺序修改数据库结构或修复数据。
- **Vitest / unittest**：自动化测试工具，用固定输入验证代码输出，防止修改后重新出现同类错误。
- **curl**：直接调用 HTTP 接口的命令行工具，适合绕过前端检查 Server 或 Qdrant 的真实响应。

### 所有技术术语的通用说明要求

下面列出的概念只是常见示例，**不是需要解释术语的完整清单**。实际沟通中只要出现用户可能不熟悉的技术名称，就必须当场解释，不能因为它没有出现在本文件中而省略说明。

必须覆盖但不限于以下类别：

- **编程语言和运行机制**：例如 Python、TypeScript、ESM、事件循环、异常、进程、线程、同步、异步和虚拟环境。
- **框架和第三方库**：例如 NestJS、Next.js、React、PyTorch、Transformers、PySceneDetect、faster-whisper 和 PaddleOCR。必须说明它是什么、解决什么问题、为什么本项目选择它，以及它运行在 Server、Worker 还是模型服务中。
- **模型和机器学习概念**：例如 Qwen2.5-VL、SigLIP、Tokenizer、推理、训练、Embedding、向量维度、归一化和余弦相似度。
- **检索和排序概念**：例如 RAG、召回、精排、Top-K、RRF、MaxSim、全文检索、倒排索引、混合检索和查询扩展。
- **服务端和数据概念**：例如 API、HTTP、JSON、Schema、ORM、SQL、事务、索引、唯一键、外键、幂等、分页、缓存和任务队列。
- **基础设施和开发工具**：例如 PostgreSQL、Qdrant、Docker、Ollama、Drizzle、Migration、Vitest、unittest、curl、环境变量和端口。
- **架构和工程方法**：例如 Monorepo、依赖注入、模块边界、状态机、可观测性、回归测试、单一事实来源和 fail fast。
- **任何指标或数学表达**：不仅包括 Precision、Recall、Hit、MRR、DCG 和 nDCG；只要出现公式、分数、百分比、阈值、均值或统计口径，都必须解释计算方式和业务含义。

解释一个技术概念时，至少回答以下问题：

1. 它是什么，用日常语言如何理解。
2. 它解决什么问题。
3. 它在本项目的哪一层运行，由谁调用。
4. 为什么这里使用它，而不是省略它或使用更简单的方式。
5. 它的输入、输出或关键状态是什么。
6. 它有哪些容易误解的限制、代价或失败方式。
7. 当前讨论中的数据或结论与它有什么关系。

例如，不应只写“使用 PySceneDetect 切分视频”，而应写清楚：

> PySceneDetect 是一个 Python 视频镜头检测库。它通过比较相邻画面的变化判断镜头是否切换。本项目在 Python Worker 中用它把长视频拆成较短的 `video_segment`，之后再为每个片段抽帧、生成 SigLIP 向量和 Caption。使用它是为了让检索结果定位到具体场景，而不是返回整段长视频；它也可能因为闪光、快速运动或渐变转场而切得过碎或漏切，因此项目还设置了最短合并和最长 30 秒切窗规则。

下面是本项目中部分高频术语的解释示例：

- **RAG（Retrieval-Augmented Generation，检索增强生成）**：先从素材或知识库找到相关内容，再把结果交给模型生成回答；本项目当前重点是前半部分的多模态检索。
- **Agent（智能体）**：能够根据目标选择并调用搜索、剪辑等工具，再依据工具结果决定下一步的软件流程，不等同于单次聊天模型调用。
- **Embedding（嵌入/向量化）**：把文本、图片或视频帧转换成一组数字，使语义或视觉相近的内容在向量空间中更接近。
- **Top-K**：按照分数排序后取前 K 条，例如 Top-10 就是排名最靠前的 10 条。
- **召回通道**：一种独立的检索来源，例如 SigLIP 视觉向量、Caption 文本向量、OCR 或转录全文检索。
- **余弦相似度**：比较两个向量方向接近程度的分数，只能在相同模型和相同通道内合理比较，不能直接当成相关概率。
- **RRF（Reciprocal Rank Fusion，倒数排名融合）**：根据候选在各通道中的名次进行融合，而不是直接混合不同模型的原始分数；RRF 分数只用于排序，不是概率。
- **MaxSim（最大相似度）**：同一视频场景有多帧命中时，使用其中最高的帧相似度代表该场景，避免同一场景重复占据多个结果位置。
- **PyTorch**：一个 Python 机器学习计算框架，负责张量运算、加载模型并在 CPU、Apple MPS 或 GPU 上执行推理。本项目的本地视觉/模型代码会通过它运行部分深度学习模型。它不是具体模型，而是承载模型计算的运行工具。
- **PySceneDetect**：一个 Python 视频镜头检测库，通过画面变化寻找镜头边界。本项目用它生成带 `scene_id` 的视频场景；检测结果不是绝对真值，快速运动、闪光和渐变可能造成误切或漏切。

### 指标和数字的通用说明要求

评测指标只是技术概念解释的一个例子，并不是唯一需要说明的内容。只要报告任何指标、分数、耗时、数量、比例、阈值或容量，都不能只给名称和数字；必须同时说明“它衡量什么、如何计算或统计、单位是什么、数值越大还是越小越好、合理范围是什么，以及本次结果代表什么”。

- **Precision@K（前 K 条准确率）**：前 K 条结果中有多少比例被标为相关。例如 Precision@5 = 0.8，表示前 5 条中有 4 条相关。数值越高越好，适合衡量用户打开结果页时首先看到的内容是否准确。
- **Recall@K（前 K 条召回率）**：全部相关目标中，有多少比例出现在前 K 条结果里。例如一共有 10 个相关片段，Top-20 找到 8 个，则 Recall@20 = 0.8。数值越高越好；前提是评测集尽可能完整标出了所有相关目标。
- **Hit@K（前 K 条是否命中）**：主要用于指定目标查询，只判断那个预先指定的正确目标是否出现在前 K 条中。命中为 1，未命中为 0；多条查询取平均后可显示为百分比。例如 Hit@5 = 50%，表示一半查询能在前 5 条找到指定目标。
- **MRR（Mean Reciprocal Rank，平均倒数排名）**：对每条查询取第一个正确目标排名的倒数再求平均。目标排第 1 得 1，排第 2 得 0.5，排第 10 得 0.1；未召回得 0。数值越高越好，对排名靠前的命中更敏感。
- **DCG@K（Discounted Cumulative Gain，折损累计增益）**：把高度相关、部分相关等分级标签转成收益，并对越靠后的结果给予越小权重。
- **nDCG@K（Normalized DCG，归一化折损累计增益）**：用实际 DCG 除以理想排序的 DCG，通常位于 0 到 1。它同时衡量相关程度和排序位置；高度相关结果越靠前，分数越高。`nDCG@10` 只观察前 10 条，`nDCG@20` 观察前 20 条，因此二者回答的是不同深度下的排序质量。

比较两个方案时，还必须说明：

- 使用的是自然发现查询还是指定目标查询，二者不能混用同一套指标。
- 指标是宏平均（先按查询计算再平均）还是把所有候选混在一起计算。
- 样本量是否足够，是否可能过拟合当前评测集。
- 数值变化是否具有产品意义，例如 Precision@5 从 0.70 到 0.72 只代表平均每 100 个首屏结果多 2 个相关结果，不应脱离样本量夸大结论。

### 代码修改后的交付说明

完成代码修改后，至少要向用户说明：

1. 修改了什么行为，以及用户界面或接口会发生什么变化。
2. 根因在哪里，为什么该修改能修复根因而不是掩盖症状。
3. 涉及哪些关键文件；不要只列文件名，要说明各文件的职责。
4. 数据库或已有数据是否需要迁移、回填、重新索引或重新评测。
5. 运行了哪些测试，每类测试证明了什么。
6. 仍然存在什么限制或下一步风险。

即使用户只问一个简短问题，也应保持基本解释完整；可以控制篇幅，但不能省略理解该结论所必需的背景。

### 代码注释的强制要求

用户是初学者，生成或修改的代码必须包含足够、准确且便于理解的注释。原则是：**必要注释宁可多一些，也绝不能缺失。** 注释属于代码的一部分，必须随实现一起维护；禁止让过期注释继续描述已经不存在的行为。

以下位置必须添加注释或 Docstring：

1. **文件或模块的核心职责**：当文件用途无法从名称直接看懂时，在文件顶部说明它负责什么、由谁调用、依赖哪些外部组件。
2. **类和重要函数**：说明职责、关键输入、返回值、副作用和可能抛出的错误。Python 使用 Docstring；TypeScript 可使用 JSDoc 或紧邻定义的说明注释。
3. **服务端与 Python 的边界**：说明请求或任务从哪里来、字段含义、处理完成后写入 PostgreSQL 还是 Qdrant，以及另一端如何读取。
4. **同步与异步流程**：说明为什么某段逻辑同步执行或进入任务队列，任务状态如何变化，以及失败后如何处理。
5. **数据库事务和状态更新**：说明哪些写操作必须原子完成、为什么要放在同一事务中，以及中途失败会造成什么问题。
6. **幂等与去重逻辑**：说明重复执行为什么不会产生重复数据，使用了哪个稳定 ID、唯一键或状态条件。
7. **复杂查询和 SQL 迁移**：解释迁移目标、执行前提、筛选范围、为何不会误伤新数据，以及是否保留历史数据用于审计。
8. **向量检索和排序算法**：解释分数来源、适用范围、融合公式、Top-K 截断、去重键和排序稳定性。涉及 RRF、MaxSim、nDCG 等算法时，要在代码附近说明公式或直觉。
9. **不直观的分支和边界条件**：解释为什么需要这个分支，以及缺少它会出现什么错误。尤其关注 `null`、空数组、零时长片段、过期数据和跨模型维度不一致。
10. **错误处理**：说明为什么这里选择抛错、重试或标记失败；不得只写“处理错误”这类没有信息量的注释。
11. **单位和取值范围**：时间、大小、分数、批量大小等数值必须标明单位或合法范围，例如秒、字节、0 到 1。
12. **测试中的关键场景**：测试名称应描述行为；复杂 Fixture 或回归测试还要注释它在复现哪个历史问题，以及断言为何能防止回归。

注释必须优先解释“为什么”和“数据如何流动”，而不是简单重复代码表面含义。例如：

```ts
// 错误示例：把状态设置成 indexed。
file.indexStatus = 'indexed'

// 正确示例：文件只要拥有一个可检索向量就应该出现在素材库检索中，
// 因此无需等待该文件的所有 OCR、Caption 和帧向量任务完成。
file.indexStatus = 'indexed'
```

写注释时还必须遵守以下规则：

- 不要假设读者已经知道缩写；首次出现时解释含义。
- 注释必须与当前实现一致，修改行为时同步修改相关注释和文档。
- 不要用注释掩盖过度复杂的代码；如果逻辑仍难以理解，应先拆分函数，再分别说明职责。
- 不要写无法验证的猜测。推断必须注明依据，临时限制应关联具体配置、迁移或待办事项。
- 对显而易见的赋值、循环和语法不要求逐行注释，但任何业务规则、架构边界和非直观实现都不能缺少注释。
- 代码评审和交付前必须检查新增代码的注释是否足以让不了解该模块的初学者顺着调用链读懂。

## 工作原则

1. **快速失败 / 错误绝不静默通过（Fail Fast / Errors Never Pass Silently）**：不要在代码中加入吞掉错误、隐藏问题的兜底逻辑。问题发生时应明确暴露，否则无法定位真实原因。
2. **修复根因，而非症状（Fix the Cause, Not the Symptom / Don't Paper Over Bugs）**：不要用零散补丁掩盖问题；必须定位并彻底修复根因，避免系统积累未知隐患。
3. **保证可观测性（Make It Observable）**：即使问题难以定位，也不得用表面修复应付。应补充足够日志与可观测信息，确保问题复现时有证据可查。信息不足时应如实说明并增加日志，不得假装问题已解决。
4. **为调试和追踪而设计（Design for Debugging / Traceability）**：关键路径必须保留足够的排查日志，使每个关键节点都可以追溯。
5. **活文档 / 单一事实来源（Living Documentation / Single Source of Truth）**：项目关键技术栈或产品方向变化时，必须同步更新 `AGENTS.md`。文档必须随代码共同演进，不能成为过时的信息。

必须使用中文回复。
