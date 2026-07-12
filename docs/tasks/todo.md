# 项目任务清单

本文件用于跟踪实施工作。在真正开始实施前，它只作为规划文档。

## 执行规则

- 实施必须遵守 `docs/implementation-rules.md`。
- 每个 Phase 完成后必须等待用户确认，再进入下一个 Phase。
- 每个 Phase 的 `Review` 区域必须记录结果、验证和后续衔接点。

## 当前进度

- 当前阶段：Phase 14 已完成（Hybrid Retrieval、reranking、top-level `results`、`groups` 兼容路径、agent/web 消费迁移）。
- 最近更新：2026-06-27，完成“关键路径注释补强”，帮助不熟悉项目的人理解 server、worker、shared schema 和 web 工作台的职责边界与关键逻辑。
- 下一步：等待确认后进入 Phase 15 外部多模态模型验证。

## 代码可读性：关键路径注释补强

- Start：2026-06-27。目标是按“关键路径注释”策略补充文件级职责说明和关键方法/关键逻辑注释，让新维护者能沿着 server → PostgreSQL/Qdrant → Python worker → Web/Agent 的主链路读懂项目。
- 假设：不做“每个文件都必须有头注释”的机械覆盖；不解释显而易见的 CRUD、React JSX 布局或简单 getter/setter；注释优先解释职责边界、跨语言协议、幂等/失败处理、外部工具调用、数据库查询语义和非显然排序/合并规则。
- 权衡：关键路径注释比全文件头注释噪音更少，维护成本更低；代价是一些边缘页面或测试文件不会被刻意补注释。若后续 onboarding 仍觉得困难，再单独补 `docs/code-walkthrough.md` 或扩大到全文件头注释。
- 验证计划：先按模块审查并补注释；完成后运行 `rg` 抽查核心文件注释覆盖，运行 `corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`、`corepack pnpm --filter @local-media-agent/web exec tsc --noEmit`、`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`、Python worker unittest，以及 `git diff --check`。注释不应改变运行行为。

- [x] Server 入口/配置/依赖边界：补 `app.module.ts`、`settings.ts`、`database.module.ts`、`schema.ts`、`repositories.ts`、`schema-guard.service.ts` 的职责说明和关键查询/守卫注释。
- [x] Server 检索链路：补 `search.service.ts`、`search-hybrid.ts`、`search-query-vector.service.ts`、`qdrant/vector-collections.ts`、`qdrant-collections.service.ts` 的召回、过滤、回表、合并、rerank 和 Qdrant 边界注释。
- [x] Server job/media/clip 链路：补 `jobs.service.ts`、`jobs.controller.ts`、`media.service.ts`、`clips.service.ts` 中 job claim、状态回收、媒体详情和导出 job 边界注释。
- [x] Server Agent 链路：补 `agent.service.ts`、`agent.tools.ts`、`agent-model.runner.ts` 的 tool 调用、脱敏、确认型副作用和外部 LLM 边界注释。
- [x] Python worker 主链路：补 `worker.py`、`repository.py`、`scan.py`、`probe.py`、`indexing.py`、`embedding_worker.py`、`transcription.py`、`ocr.py`、`exporting.py`、`model_service.py`、`qdrant.py`、`embeddings.py` 的模块职责、跨语言字段约定、幂等和外部工具调用注释。
- [x] Shared schema：补 `packages/shared/schemas/index.ts` 和 `packages/shared/scripts/generate-json-schemas.ts` 的 schema 权威、生成物和 TS/Python 契约注释。
- [x] Web 工作台：补 `search-workspace.tsx`、`agent-workspace.tsx`、`media-detail-workspace.tsx`、`library-workspace.tsx`、`jobs-workspace.tsx`、`api-client.ts` 的数据来源、API 边界和关键 UI 状态注释。
- [x] 检查注释质量：删除逐行复述代码的注释，保留解释“为什么/边界/排查入口”的注释。
- [x] 运行 TypeScript/Python 验证和 `git diff --check`，并在本段 Review 记录结果。

Review：

- Result：已按关键路径策略补充注释，覆盖 NestJS 模块组合、配置解析、Drizzle/PostgreSQL schema、repository 查询、Qdrant collection、Search hybrid rerank、Job 队列、Agent tool 脱敏/确认、Python worker scan/probe/index/embed/transcribe/OCR/export/model service、shared job schema 生成，以及 Web Search/Agent/Media/Library/Jobs 工作台的数据边界。
- Notes：注释重点解释职责边界、跨语言字段约定、幂等、失败处理、外部工具调用、数据库事实来源、Qdrant 回表和 hybrid score 合并语义，没有做全文件头注释或逐行复述。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/web exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`；`PYTHONPATH=apps/worker-py .venv/bin/python -m unittest discover apps/worker-py/tests`（40 tests）；`git diff --check`。

## 文档任务：项目工具清单

- Start：2026-06-24，目标是新增一份项目工具清单文档，说明当前项目用到的主要工具、职责边界，以及它们在本项目中的具体使用方式。
- 假设：只记录当前仓库代码、依赖、配置和既有文档中已经落地或明确接入的工具；不把未来规划工具写成已落地能力。
- 验证计划：通过 `package.json`、`requirements.txt`、`infra/docker-compose.yml`、README、架构文档和关键源码交叉核对；文档完成后用文本检查确认覆盖前端、后端、共享协议、Python worker、基础设施、模型/媒体处理、Agent、测试和格式化工具。

- [x] 确认计划后创建 `docs/tools.md`。
- [x] 按工具分类整理“是什么作用”和“当前项目怎么用”。
- [x] 标明尚未作为核心路径使用或仅可选的工具边界，例如 Redis、外部 LLM 和文本向量 collection。
- [x] 更新本任务 Review，记录新增文档路径和验证结果。

Review：

- Result：新增 `docs/tools.md`，按工程与包管理、前端、后端 API、数据库与向量检索、Python worker、模型检索、共享协议、基础设施、测试和格式化工具分类，说明每个工具的作用和当前项目使用方式。
- Notes：已用 `rg` 检查 `docs/tools.md` 覆盖 Node.js、pnpm、Next.js、NestJS、PostgreSQL、Qdrant、FFmpeg、ffprobe、SigLIP、faster-whisper、PaddleOCR、Redis、外部 LLM 边界、文本向量 collection、Vitest、oxlint 和 oxfmt 等关键项。`git diff -- docs/tools.md docs/tasks/todo.md docs/tasks/lessons.md` 已检查；其中 `docs/tasks/todo.md` 底部 Oxlint/Oxfmt 任务记录和 `docs/tasks/lessons.md` 中部分 2026-06-16 lessons 属于本次开始前已有未提交内容，本次未回滚。

## Phase 1：Monorepo 与基础设施

- [x] 创建 `apps/web`、`apps/server`、`apps/worker-py`、`packages/shared`、`infra` 和 `docs` 的可拆分 monorepo 目录。
- [x] 添加 workspace package 配置。
- [x] 在 `packages/shared` 创建 `schemas/`、`types/`、`constants/`、`api-client/` 和 `generated/` 目录。
- [x] 添加 PostgreSQL、Qdrant 和可选 Redis 的 Docker Compose。
- [x] 添加 `.env.example`。
- [x] 添加 README 启动说明。

Review：

- Result：创建 pnpm workspace 骨架、web/server/shared package manifest、Python worker 占位目录、本地 PostgreSQL/Qdrant/可选 Redis compose 配置、环境变量样例和启动说明。
- Notes：`docker compose --env-file .env.example -f infra/docker-compose.yml config` 通过；`find apps packages infra -maxdepth 3 -type d -print` 确认目录齐全；`pnpm check` 首次因 Corepack 写 `~/.cache/node` 被沙箱拦截，外部授权后通过。未启动容器，避免把配置验证和本机 Docker/镜像下载状态混在一起。项目 Node 版本已按用户要求改为 22，并添加 `.nvmrc`。

## Phase 2：TypeScript / Fastify 基础服务（已完成，待迁移）

- [x] 创建 Fastify app。
- [x] 添加基于环境变量的 settings。
- [x] 添加 `GET /health`。
- [x] 添加 PostgreSQL 和 Qdrant 依赖检查。
- [x] 添加 Vitest 测试配置。

Review：

- Result：在 `apps/server` 创建 Fastify app、启动入口、settings 解析、PostgreSQL/Qdrant 依赖检查、`GET /health` 和 Vitest/TypeScript 验证链路；README 已改为中文；新增代码注释使用中文。
- Notes：测试遵循红绿流程，先验证缺失实现失败，再补实现。`pnpm --filter @local-media-agent/server check` 通过，包含 `tsc --noEmit` 与 5 个 Vitest 测试。`pnpm check` 通过。`docker compose --env-file .env.example -f infra/docker-compose.yml config` 通过。已通过 OrbStack 启动 PostgreSQL/Qdrant，并用 `curl http://127.0.0.1:4010/health` 验证真实返回 `{"status":"ok","dependencies":{"database":"ok","qdrant":"ok"}}`。实现中修正了两个实际问题：Qdrant 健康检查改用 `GET /collections`；`pnpm --filter` 启动时支持读取 monorepo 根目录 `.env`。

## Phase 2A：NestJS 迁移

- [x] 将 `apps/server` 从 Fastify 迁移到 NestJS 默认 Express adapter。
- [x] 创建 `AppModule`、`ConfigModule` 和 `HealthModule`。
- [x] 将 settings 解析迁移为可注入配置 provider。
- [x] 将 PostgreSQL 和 Qdrant 依赖检查迁移为可注入 service。
- [x] 保持 `GET /health` 响应契约不变。
- [x] 将测试迁移到 Nest testing module，并继续验证成功与依赖失败场景。
- [x] 移除 Fastify 依赖和旧实现文件。
- [x] 更新 README 中的启动说明和 Phase 2A Review。

Review：

- Result：`apps/server` 已迁移为 NestJS 默认 Express adapter，新增 `AppModule`、`ConfigModule`、`HealthModule`、可注入 settings provider 和依赖检查 provider；删除 Fastify app、旧 settings/dependencies 文件和 Fastify 依赖；README 已改为 NestJS 启动说明。
- Notes：测试遵循红绿流程，先将测试改为 Nest testing module 并观察缺依赖/缺模块失败，再完成实现。`pnpm --filter @local-media-agent/server check` 通过，包含 `tsc --noEmit` 与 5 个 Vitest 测试。已启动 NestJS dev server，并用 `curl http://127.0.0.1:4010/health` 验证真实返回 `{"status":"ok","dependencies":{"database":"ok","qdrant":"ok"}}`。单元测试不直接用 supertest 打开端口，因为沙箱会阻止测试进程监听 `0.0.0.0`；改为通过 Nest testing module 调用 controller，真实 HTTP 路由由 dev server + curl 验证覆盖。

## Phase 3：PostgreSQL Schema 与 Drizzle Migrations

- Start：2026-05-31，目标是交付可迁移的 PostgreSQL schema、可测试 repository helpers、共享 job schemas、Python worker JSON Schema 和一致性检查。
- 验证计划：先为 shared job schemas、Drizzle schema/repository 和 schema consistency 写失败测试；实现后运行 `pnpm --filter @local-media-agent/shared check`、`pnpm --filter @local-media-agent/server check` 和 `pnpm check`。

- [x] 添加 libraries、media files、media assets、vector refs、jobs 和 agent runs 的 Drizzle schema。
- [x] 添加 Drizzle migration。
- [x] 添加 repository helpers。
- [x] 添加 model relationship tests。
- [x] 在 `packages/shared` 添加 job input/output Zod schemas。
- [x] 生成 Python worker 可读取的 JSON Schema。
- [x] 添加 schema consistency check。

Review：

- Result：新增 Drizzle schema、DatabaseModule、drizzle-kit 配置和标准 migration；覆盖 libraries、media_files、media_assets、vector_refs、jobs、agent_runs、agent_run_events 和 agent_tool_calls。新增 repository helpers，用 PGlite 在测试中迁移空库并创建 library、media file、media asset、vector ref 和 job，同时查询 file/assets/vector refs 关系。`packages/shared` 新增 job type/media/vector 常量、job input/output Zod schemas、JSON Schema 生成脚本和生成物 `packages/shared/generated/job-schemas.json`。
- Notes：遵循红绿流程，先写 shared job schema 测试、database repository 测试和 schema consistency 测试，观察缺实现失败，再补实现。`pnpm --filter @local-media-agent/shared check` 通过，包含 JSON Schema 生成、TypeScript typecheck 和 3 个 Vitest 测试。`pnpm --filter @local-media-agent/server check` 通过，包含 TypeScript typecheck 和 7 个 Vitest 测试。`pnpm check` 通过。当前命令输出仍提示本机 Node 为 v20.19.6，项目 engines 要求 >=22.0.0；本次验证仍成功，但后续运行建议切到 Node 22 以匹配项目约定。Phase 3 已完成，下一步需等待用户确认后进入 Phase 4。

## Phase 4：Library 扫描与 Job 创建

- Start：2026-06-01，目标是交付 library 管理 API、scan job 创建、PostgreSQL-backed job claim/reclaim、Python worker scan handler、按扩展名识别 media type 和幂等扫描。
- 验证计划：先为 NestJS library/jobs service/controller 和 Python scan handler 写失败测试；实现后运行 `pnpm --filter @local-media-agent/server check`、Python worker 测试和 `pnpm check`。

- [x] 添加 library create、list、detail 和 disable/delete APIs。
- [x] 添加 scan job API。
- [x] 添加 PostgreSQL-backed job claim 机制。
- [x] 定义 Python worker 启动命令、heartbeat、超时回收和 graceful shutdown。
- [x] 添加 Python worker scan handler。
- [x] 添加按扩展名识别 media type。
- [x] 添加幂等扫描行为。

Review：

- Result：新增 NestJS `LibrariesModule` 和 `JobsModule`，支持创建、列表、详情、禁用和软删除 library，支持 `POST /libraries/{id}/scan` 创建 `scan_library` job，支持 jobs list/detail、按优先级 claim queued job、heartbeat、成功写回和 stale running job 回收。Python worker 新增 `python -m media_agent_worker` 启动入口、scan handler、worker runner、PostgreSQL raw SQL repository helper、按扩展名识别 media type，以及 `path + size + mtime` 幂等扫描写入策略。
- Notes：遵循红绿流程，先写 TS library/job 测试和 Python worker scan 测试，观察缺模块和占位计数失败，再补实现。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，7 个 test files / 12 个 tests 通过；`PYTHONPATH=apps/worker-py python3 -m unittest discover apps/worker-py/tests`，3 个 Python tests 通过；`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`、`tsc --noEmit` 和 `vitest run` 通过；`git diff --check` 通过。当前 Node 22 环境没有裸 `pnpm` shim，`corepack pnpm --filter ... check` 会在 package script 内部调用裸 `pnpm` 而失败，因此本次使用等价的 `corepack pnpm exec ...` 命令分别验证。未启动真实 PostgreSQL/HTTP server；数据库行为由 PGlite migration 测试覆盖，真实运行前需安装 `apps/worker-py/requirements.txt` 中的 `psycopg[binary]`。

## Phase 5：媒体探测与索引骨架

- Start：2026-06-01，目标是交付 Python worker 探测、媒体 asset 生成、固定 30 秒视频 segments、mock vector 写入、`vector_refs` 幂等关联，以及 TS Qdrant collection registry/init。
- 验证计划：先写 TS Qdrant registry/init 测试和 Python probe/index/mock vector 测试；实现后运行 server/shared/Python worker 验证与 `git diff --check`。

- [x] 添加 Python worker ffprobe 视频和音频探测。
- [x] 添加 Python worker 图片尺寸探测。
- [x] 添加 media asset 生成。
- [x] 添加固定 30 秒视频 segments。
- [x] 按 `docs/vector-index-design.md` 在 TypeScript server 中添加 collection registry。
- [x] 添加 Qdrant collection 初始化。
- [x] 添加 deterministic mock vectors。
- [x] 添加 `vector_refs` 与 Qdrant point id 的幂等关联。
- [x] 统一由 Python worker 写入 Qdrant points，TypeScript server 只管理 collection 和搜索读取。

Review：

- Result：TypeScript server 新增 `QdrantModule`、`VECTOR_COLLECTIONS` registry 和 `QdrantCollectionsService`，按 collection 配置初始化缺失的 Qdrant collections。Python worker 新增 `ProbeHandler`，通过 ffprobe 探测视频/音频 metadata，并用无外部依赖的 PNG/JPEG header parser 获取图片尺寸；新增 `IndexMediaHandler`，为图片生成 image asset，为视频生成固定 30 秒 `video_segment` assets，生成 deterministic point id 和 deterministic mock vectors，写入 Qdrant points，并通过 repository helper 幂等创建 `vector_refs`。新增 scan → probe → index 管线触发链：`ScanHandler` 为 created/updated 文件创建 `probe_media` job，`ProbeHandler` 探测完成后创建 `index_media` job。重命名 `PostgresScanRepository` 为 `PostgresMediaRepository`。修复 `QdrantHttpClient` 死代码、`indexing.py` 测试遗留分支。更新 `vector-index-design.md` 唯一约束和 `job-protocol.md` 管线触发链及 `index_status` 状态流转文档。
- Notes：遵循红绿流程，先写 TS Qdrant registry/init 测试和 Python probe/index/mock vector 测试，观察缺模块失败，再补实现。验证通过：`corepack pnpm --filter @local-media-agent/server exec vitest run`，8 个 test files / 14 个 tests 通过；`PYTHONPATH=apps/worker-py python3 -m unittest discover apps/worker-py/tests`，11 个 Python tests 通过（含 3 个触发链测试）；shared 的 JSON Schema 生成、typecheck 和 Vitest 通过。未启动真实 Qdrant、真实 PostgreSQL 或实际 ffprobe 命令；Qdrant 初始化和 point 写入用 fake fetch/client 测试覆盖，ffprobe 解析通过注入 runner 测试覆盖。Phase 6 可在此基础上添加 Search API，从 Qdrant 召回后回 PostgreSQL 补齐 metadata。

## Phase 6：Qdrant Retrieval

- Start：2026-06-02，目标是交付 `POST /search`，从 Qdrant image/video segment collections 召回后回 PostgreSQL 补齐 metadata，并按 collection 分组返回稳定 JSON。
- 验证计划：先写 Search service/controller 测试覆盖 image/video 分组、media type/library filters、limit/offset 和空结果；实现后运行 server 验证、shared 验证和 `git diff --check`。

- [x] 添加 `POST /search`。
- [x] 使用 Qdrant JS client 搜索 image 和 video segment collections。
- [x] 应用 media type 和 library filters。
- [x] 查询 Qdrant 后回 PostgreSQL 补齐完整 metadata。
- [x] 按 collection 分组返回搜索结果。
- [x] 添加 `limit` 和 `offset` 分页参数。
- [x] 返回 file path、score、media type 和 time range。
- [x] 添加空结果处理。

Review：

- Result：新增 `SearchModule`、`SearchController`、`SearchService` 和 `SearchQueryVectorService`，接入 `POST /search`。`QdrantModule` 新增官方 `@qdrant/js-client-rest` provider；Search service 根据 media type 选择 `image_vectors` 和 `video_segment_vectors`，构造 media type / library Qdrant filter，使用 `limit` / `offset` 分页查询，再通过 `vector_refs -> media_assets -> media_files -> libraries` 回 PostgreSQL 补齐 path、media type 和 time range，按 collection 分组返回结果。空结果返回稳定 `{ limit, offset, groups }` 结构。
- Notes：Phase 6 仍使用稳定 mock query vector，只验证 Qdrant retrieval/read path；真实 query embedding 按计划留给 Phase 10 的本地模型服务。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，10 个 test files / 17 个 tests 通过；`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`；`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/shared exec vitest run`，3 个 tests 通过；`git diff --check` 通过。`corepack pnpm --filter @local-media-agent/server check` 仍因 package script 内部调用裸 `pnpm` 且当前 shell 没有 pnpm shim 而失败，本次继续使用等价 `corepack pnpm exec ...` 验证。未启动真实 Qdrant/PostgreSQL HTTP 链路；Qdrant 搜索通过 fake client 覆盖，PostgreSQL 回表由 PGlite migration 测试覆盖。

## Phase 7：Next.js 前端

- Start：2026-06-02，目标是交付可运行的 Next.js 前端壳、核心工作流页面和 typed API client；视觉上参考 `DESIGN.md` 的红色 CTA、暖白 chrome、pill 控件和 masonry 影像语言，但保持工具型产品的信息密度。
- 验证计划：先配置前端测试和 TypeScript 验证；为 API client、导航和 Search 页面写失败测试；实现后运行 web typecheck/test/build，并启动 dev server 用浏览器检查桌面与移动视口。

- [x] 创建 Next.js app。
- [x] 添加 Tailwind。
- [x] 添加 app shell navigation。
- [x] 添加 Library page。
- [x] 添加 Search page。
- [x] 添加 Jobs page。
- [x] 添加 Media Detail page。
- [x] 添加 Agent page。
- [x] 添加 typed API client。
- [x] 参考 `DESIGN.md` 的视觉语言，并将其工具化适配到媒体管理和检索界面。

Review：

- Result：`apps/web` 从占位 package 变为 Next.js 16 / React 19 / Tailwind 4 前端应用。新增 App Router 页面：`/search`、`/libraries`、`/jobs`、`/media/[id]`、`/agent`，根路径重定向到搜索页。新增 `AppShell` 主导航、Search masonry grouped results、Library 管理面板、Jobs 进度列表、Media detail segments 和 Agent run 表单。新增 typed API client，覆盖 libraries、scan job、jobs、search、media detail 和 agent run 请求。视觉上使用 `DESIGN.md` 的 Pinterest red、暖白 surface、pill 控件、16px/32px 圆角和影像优先 masonry，但布局保持工具型产品的信息密度；本地 demo 缩略图资产保存为 `apps/web/public/demo-media-contact-sheet.png`。
- Notes：遵循红绿流程，先写 API client、AppShell 和 SearchWorkspace 测试并观察缺模块失败，再实现页面。验证通过：`corepack pnpm --filter @local-media-agent/web check`，包含 `tsc --noEmit`、Vitest 3 个 test files / 4 个 tests、`next build --webpack`，生成 7 个 App Router 页面。浏览器验证通过：启动 `corepack pnpm --filter @local-media-agent/web dev`，检查桌面 `/search`、移动 390px `/search` 和移动导航到 `/libraries`；修正移动导航文字挤压为图标优先。后续按用户要求将前端可见展示文案统一改为中文，并再次通过 web check 与浏览器 `/libraries`、`/search` 验证。Next 16 默认 Turbopack build 在 sandbox 内处理 CSS 时会触发端口绑定 EPERM，本阶段将 build 脚本固定为 `next build --webpack`，并在 `next.config.mjs` 设置 `turbopack.root` 避免 workspace root 误判。

## Phase 8：Clip Export

- Start：2026-06-07，目标是交付 `POST /clips/export`、`export_clip` job 创建、Python worker FFmpeg 导出、`.media-agent/exports/clips` 输出目录、job result，以及 Media Detail 页面导出动作。
- 验证计划：先写 server clips/media API、Python export handler 和前端导出按钮的失败测试；实现后运行 server/shared/Python worker/web 验证，并启动前端 dev server 用浏览器检查 Media Detail。

- [x] 添加 `POST /clips/export`。
- [x] TypeScript API 创建 `export_clip` job。
- [x] Python worker 使用 FFmpeg 导出 clip。
- [x] 将 clips 保存到 `.media-agent/exports/clips`。
- [x] 添加 export job result。
- [x] 添加 Media Detail export action。

Review：

- Result：新增 `ClipsModule`，提供 `POST /clips/export` 并创建 `export_clip` job；新增 `MediaModule`，提供 `GET /media/{id}` 供 Media Detail 页面读取真实 metadata 和 assets；`packages/shared` 的 `export_clip` schema 增加 `end_time_seconds > start_time_seconds` 校验并重新生成 Python worker 可读 JSON Schema。Python worker 新增 `ExportClipHandler`，根据 `file_id` 回表获取源视频路径，用 FFmpeg stream copy 导出到 `.media-agent/exports/clips`，并写回 `export_path` 与 `duration_seconds`。前端 typed API client 新增 `exportClip`，Media Detail 片段卡片新增导出动作和任务状态反馈，真实 `/media/[id]` 页面改为优先读取后端媒体详情，demo/后端不可用时回退 demo。
- Notes：遵循红绿流程，先写 server clips/media controller 测试、Python export worker 测试、web API client 和 Media Detail 导出按钮测试，并观察缺模块/缺方法失败，再补实现。验证通过：shared JSON Schema 生成；server `tsc --noEmit`；server Vitest 12 个 test files / 23 tests；Python worker unittest 13 tests；shared `tsc --noEmit` 和 Vitest 3 tests；web `check`，包含 typecheck、Vitest 4 个 test files / 6 tests、Next webpack build；`git diff --check`。`corepack pnpm --filter @local-media-agent/server check` 和 shared check 仍因 package script 内部调用裸 `pnpm` 且当前 shell 没有 pnpm shim 失败，本次继续使用等价 `corepack pnpm exec ...` 命令分别验证。浏览器验证复用已有 `localhost:3000` dev server：`/media/demo` 桌面和移动宽度下可见片段与导出按钮；后端 API 未启动时点击导出显示失败状态。未执行真实 FFmpeg 导出命令，FFmpeg 参数通过注入 runner 的 Python 测试覆盖，真实运行前需确保系统可执行 `ffmpeg` 在 PATH 中。

## Phase 9：Agent MVP

- Start：2026-06-07，目标是交付可持久化的 Agent run、事件、tool call summary 和副作用确认流；Agent 只编排现有 `search_media`、`get_media_detail`、`create_index_job`、`export_clip` 能力，不承担检索质量提升，检索质量仍留给 Phase 10-14。
- 假设：外部 LLM 默认关闭；实现保留 Vercel AI SDK/provider 边界，但不把 Phase 9 绑定死到单一供应商。测试使用 fake runner，不要求真实 API key；后续可接 DeepSeek/Qwen/OpenAI/Anthropic provider。
- 验证计划：先写 settings、AgentService、controller、typed API client 和前端状态展示的失败测试；实现后运行 server/shared/web 验证与浏览器检查。

- [x] 添加 `ai` 和 `@ai-sdk/anthropic` 依赖。
- [x] 创建 `AgentModule`（controller、service、tools 目录）。
- [x] 使用 Vercel AI SDK `tool()` + Zod schema 定义 `search_media` tool。
- [x] 使用 Vercel AI SDK `tool()` + Zod schema 定义 `get_media_detail` tool。
- [x] 使用 Vercel AI SDK `tool()` + Zod schema 定义 `create_index_job` tool。
- [x] 使用 Vercel AI SDK `tool()` + Zod schema 定义 `export_clip` tool。
- [x] AgentService 封装 `generateText` 调用，传入 tools 和 system prompt。
- [x] ConfigModule 添加 `ALLOW_EXTERNAL_LLM`、`ANTHROPIC_API_KEY`、`AGENT_MODEL`、`AGENT_MAX_STEPS` 和 tool 超时配置。
- [x] AgentService 实现有限步 tool loop，例如 `maxSteps = 4`，并限制单次 run 最大 tool call 数。
- [x] AgentService 在外部 LLM 调用前执行候选脱敏，默认不发送绝对路径、源媒体、完整 transcript 或 OCR 全文。
- [x] 为 `export_clip` tool 添加服务端 guard：LLM 提出建议后写入 `user_confirmation_required` 事件，不直接创建 job。
- [x] 为 `create_index_job` tool 添加服务端 guard：确认流程与 `export_clip` 一致。
- [x] 添加 `POST /agent/runs`。
- [x] 添加 `GET /agent/runs/{id}`。
- [x] 添加 `POST /agent/runs/{id}/confirm`，用于用户确认副作用操作。确认凭证为 `tool_call_id`。
- [x] 定义 agent run events 结构。
- [x] AgentService 将 `generateText` 返回的 steps 映射为 api-contract 事件类型，写入 `agent_run_events` 表。
- [x] 将 agent run state、events 和 tool calls 持久化到 PostgreSQL。
- [x] 在前端展示 agent status 和 tool-call summary。

Review：

- Result：新增 `AgentModule`、`AgentController`、`AgentService`、provider runner 和 Agent tools，提供 `POST /agent/runs`、`GET /agent/runs/{id}`、`POST /agent/runs/{id}/confirm`。新增 `ALLOW_EXTERNAL_LLM`、`ANTHROPIC_API_KEY`、`AGENT_MODEL`、`AGENT_MAX_STEPS`、`AGENT_TOOL_TIMEOUT_MS` 配置，默认不调用外部大模型。`search_media`、`get_media_detail`、`create_index_job`、`export_clip` 均以 Vercel AI SDK `tool()` 定义；副作用工具只写入等待确认的 tool call 和 `user_confirmation_required` 事件，确认后才创建 `index_media` 或 `export_clip` job。Agent run、events 和 tool calls 持久化到 PostgreSQL，前端 Agent 页面展示 run 状态、summary、tool-call summary 和确认按钮。`.env.example` 和 `docs/api-contract.md` 已同步 Agent 配置与响应契约。
- Notes：遵循红绿流程，先写 settings、Agent controller/service、web API client 和 AgentWorkspace 失败测试，再补实现。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，13 个 test files / 27 tests 通过；`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`、`tsc --noEmit` 和 Vitest 3 tests 通过；`corepack pnpm --dir apps/web exec tsc --noEmit`、Vitest 5 个 test files / 8 tests、`next build --webpack` 通过；`git diff --check` 通过。浏览器烟测通过：授权启动 `corepack pnpm --filter @local-media-agent/web dev`，`GET /agent` 返回 200，HTML 含 Agent 页面、输入框 placeholder 和“启动任务”。本阶段没有真实调用外部 LLM；Anthropic runner 只在 `ALLOW_EXTERNAL_LLM=true` 且配置 API key 后启用，测试使用 fake runner。tool output 在进入 provider 前移除本地绝对路径、cache path 和文本全文字段，真实检索质量仍留给 Phase 10-14。

## Phase 10：真实视觉 Embedding

- Start：2026-06-07，目标是用 SigLIP 替换 Phase 5/6 的 mock vision vectors，交付本地 Python model service、真实 query/image/video-frame/video-segment embedding、Qdrant 写入和搜索链路。
- 假设：默认模型为 `google/siglip-base-patch16-224`。公开配置主线显示 hidden size 768，历史配置曾出现 `projection_dim: 512`，因此实现必须在模型加载或首次推理时读取并校验实际输出维度；Qdrant collection vector size 以运行时确认的 SigLIP 输出维度为准。
- 实施补充：当前分支直接实施，不创建新分支；沿用 Phase 9 未提交改动作为基线，不回滚既有工作区内容。索引协调先做显式 API/Service 入口扫描 pending `vector_refs` 并创建 embedding jobs，不提前加入后台定时器。
- 验证计划：先写 Python SigLIP embedder/model service 测试、TypeScript Model Gateway/SearchQueryVectorService 失败测试、worker embedding job 测试和 registry/schema 测试；实现后运行 server/shared/Python worker 验证与 `git diff --check`。真实模型下载/推理如果因网络或本机资源受限无法在 CI 测试中跑，单元测试使用 fake model，真实模型用手动 smoke test 覆盖。

- [x] TypeScript Model Gateway 添加 embedding job 接口。
- [x] 添加本地 Python model service（常驻 localhost RPC），提供 `/embed/text` 和 `/embed/image` 端点。
- [x] 更新 `SearchQueryVectorService`，从 mock SHA-256 向量改为调用 model service `/embed/text`。
- [x] 明确 Python worker 与 model service 的进程模式、启动时机和 MPS 内存策略。
- [x] Python worker 接入 SigLIP（`google/siglip-base-patch16-224`），运行时校验实际输出维度。
- [x] 修改 `index_media`：只创建 assets 和 pending `vector_refs`，不再直接写 mock vectors 到 Qdrant。
- [x] TypeScript server 索引协调任务扫描 pending `vector_refs`，创建下游 `embed_image` / `embed_video_frame` jobs。
- [x] 为图片生成 image vectors（`image_vectors`）。
- [x] 保留视频关键帧 embedding handler 和 `video_frame_vectors` registry，实际 frame ref 生成延后到 Phase 11 scene/keyframe 阶段，避免 Phase 10 对同一 midpoint 帧重复嵌入。
- [x] 为视频 segment 生成 representative frame vectors（`video_segment_vectors`），与 Phase 6 搜索链路一致。
- [x] 更新 `VECTOR_COLLECTIONS` registry：model name、version 和 vectorDim 改为 SigLIP 配置。
- [x] 重建 Qdrant collections（Phase 5 创建的 dim=512/384 collections 需要删除并重建）。
- [x] 记录 model name、version 和 vector dim 到 `vector_refs`。
- [x] 支持 CPU、MPS 和 CUDA 设备选择。

Review：

- Result：新增 TypeScript `ModelGatewayModule` / `ModelGatewayService`，搜索 query embedding 改为同步调用本地 Python model service `/embed/text`，并校验返回 `vector_dim` 与 registry 一致。新增 `POST /jobs/embedding/queue-pending` 和 `JobsService.queuePendingEmbeddingJobs()`，扫描 pending `vector_refs` 并创建 `embed_image` / `embed_video_frame` jobs。Qdrant registry 切到 `google/siglip-base-patch16-224` / `siglip-base-patch16-224` / 768 维；collection 初始化在启动生命周期执行，发现旧维度时会删除并重建，并将对应 collection 的 `vector_refs` 升级为当前模型元数据后重置为 pending。Python worker 新增 SigLIP embedder、CPU/MPS/CUDA device 选择、本地 stdlib HTTP model service、image/video frame embedding handlers、FFmpeg representative frame extraction，并将 embedding job 成功后的 Qdrant point 写入和 `vector_refs.status='indexed'` 更新放在同一 worker 边界。`index_media` 现在只创建 assets 和 pending `vector_refs`，视频固定 30 秒 segment 只创建 `video_segment_vectors` refs；`video_frame_vectors` 留给 Phase 11 真实关键帧。
- Notes：遵循红绿流程，先写 settings、Qdrant registry 重建、Search model gateway、pending vector_refs 协调、Python model service / embedding worker、index_media pending refs 测试并观察缺实现失败，再补实现。Review 修复后补充验证：Qdrant collection 初始化已接入 Nest 启动生命周期，启动初始化失败只记录 warning 不阻断；collection 重建会把旧 `vector_refs` 升级到当前 collection registry 的 model/version/vectorDim/point_id 并重置为 pending；audio/text collection registry 恢复为 MiniLM 384 维；移除未实现的 `embed_text` worker job schema；worker 内 image/video handlers 共享同一个 SigLIP embedder；FFmpeg 抽帧失败会清理临时文件；Phase 10 不再为每个 30 秒 segment 额外生成未搜索的 `video_frame_vectors` ref。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，13 个 test files / 31 tests 通过；`PYTHONPATH=apps/worker-py python3 -m unittest discover apps/worker-py/tests`，22 tests 通过；shared JSON Schema 生成、`tsc --noEmit` 和 Vitest 4 tests 通过；`git diff --check` 通过。未下载或运行真实 SigLIP 权重，真实模型下载/推理需要本机先安装 `apps/worker-py/requirements.txt` 依赖并具备 Hugging Face 模型访问；单元测试通过 fake embedder 覆盖协议、维度校验和 Qdrant 写入边界。

## Phase 11：视频 Scene Segmentation

- Start：2026-06-08，目标是用 PySceneDetect scene boundaries 替换默认固定 30 秒视频切片，同时保留固定切片 fallback，让搜索和媒体详情返回更语义完整的 scene 范围。
- 假设：本阶段继续沿用 Phase 10 的直接实施方式，不新建分支；PySceneDetect 作为可选运行依赖接入，单元测试使用 fake detector/runner，不要求 CI 下载额外模型或读取真实视频；数据库不新增表，scene、keyframe 和 fallback metadata 写入现有 `media_assets.metadata_json`。
- 权衡：scene detection 失败时不阻断索引，回退 `fixed_30s` 可以保持现有搜索链路可用；短 scene 合并先使用简单阈值，避免引入复杂 shot clustering；每个 scene 关键帧限制为 1 到 3 个，控制 `video_frame_vectors` 数量。
- 验证计划：先写 `index_media` `segment_strategy` 扩展与 scene/keyframe `metadata_json` 约定测试、Python scene detection handler / index fallback / 重索引清理测试、worker dispatch 测试和必要的 server/web 回归测试；确认失败后实现。完成后运行 shared schema/type/test、server type/test、Python worker unittest、web check（如前端展示变更）和 `git diff --check`。

- [x] `index_media` 实现 `segment_strategy='scene_detection'` 分支（不新增独立 job 类型）。
- [x] Python worker 接入 PySceneDetect（`ContentDetector`，阈值 27），检测 scene 边界。
- [x] 合并短于 `SCENE_MIN_SECONDS`（默认 3s）的 scene。
- [x] 为每个 scene 生成代表帧（中点）`video_segment` asset → `video_segment_vectors`。
- [x] 为每个 scene 按 scene 时长生成 0-2 个关键帧 `video_frame` asset → `video_frame_vectors`（与代表帧不重复）。
- [x] scene 分组与策略标识写入 `media_assets.metadata_json`（scene_id / keyframe_index / segment_strategy），不新增 DB 列。
- [x] 重索引/策略切换时先失效该 file 下旧 video_segment/video_frame assets 与 vector_refs。
- [x] Fallback：PySceneDetect 抛错 / 0 scene / scene 数超 2000 时回退 `fixed_30s`，job 不失败。
- [x] scene 切片 `scene_id` 写入 Qdrant payload。
- [x] 视频默认 `segment_strategy='scene_detection'`（probe→index_media 链路）。
- [x] 单元测试注入 fake detector。
- [x] 集成测试用极小 fixture 视频覆盖真实检测+抽帧。

Review：

- Result：`index_media` 的视频路径新增 `scene_detection` 分支，不新增独立 job type；PySceneDetect 通过可注入 detector 接入，默认使用 `ContentDetector(threshold=27)`，并在 worker 内合并短 scene、生成 scene `video_segment` assets、额外生成 0-2 个 `video_frame` keyframes，统一创建 pending `vector_refs`。scene/fallback/keyframe 信息写入 `media_assets.metadata_json`，embedding worker 将 `scene_id`、`segment_strategy` 和 `keyframe_index` 写入 Qdrant payload。`probe_media` 创建视频 index job 时默认使用 `segment_strategy='scene_detection'`。策略切换时旧 video segment/frame assets 标记 stale，对应 vector refs 标记 stale；搜索 hydration 只接受 indexed refs，避免旧 Qdrant point 残留被返回。Media Detail 返回 asset `metadata_json`，Search 结果返回 `scene_id`。
- Notes：遵循红绿流程，先补 shared schema、Python index/probe/embedding 和 server media/search metadata 测试并观察缺实现失败，再实现。验证通过：shared JSON Schema 生成、`tsc --noEmit` 和 Vitest 1 test；server `tsc --noEmit` 和 Vitest 14 files / 33 tests；Python worker unittest 26 tests；web `check`（typecheck、Vitest 5 files / 8 tests、Next webpack build）；`git diff --check`。2026-06-09 已安装 Homebrew Python 3.12.13，并用 `PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests` 验证 26 tests 通过。随后创建项目 `.venv`，按官方命令 `.venv/bin/python -m pip install --upgrade scenedetect` 安装 PySceneDetect 0.7 / OpenCV 4.13.0 / NumPy 2.4.6，并通过 Homebrew 安装 FFmpeg 8.1。真实 smoke：用 FFmpeg 生成 3 段纯色视频，`detect_scenes_pyscenedetect()` 检测出 3 个 scene，`extract_video_frame()` 成功抽帧；临时 fixture 和 frame 已清理。

## Phase 12：语音转写与文本检索

- Start：2026-06-15，目标是接入 faster-whisper 转写、按 15-30s 切 text_chunk、PostgreSQL FTS 让视频/音频讲话内容可搜索；text embeddings 延后。
- 假设：本阶段沿用 Phase 10/11 直接实施方式，不新建分支；faster-whisper 作为可选运行依赖接入，单元测试注入 fake transcriber/ffprobe runner，不要求 CI 下载 Whisper 权重；数据库新增 `media_assets.text_content text` 列 + `text_tsv` 生成列 + GIN 索引 + `text_chunk` 唯一索引（迁移），不新增表；`audio_segment_vectors` / `text_chunk_vectors` 暂不写入（空 collection）。
- 权衡：FTS-only 满足「搜索说过的话」，避免引入第二个 embedding 模型 + service（YAGNI）；`'simple'` tsvector 对中文按空白分词，召回弱于中文分词扩展，先保证链路通；faster-whisper CPU/INT8 默认，与 SigLIP（可 MPS）解耦，避免内存争抢；transcribe 与 index 并行（产出 asset 类型不同，无写入冲突）。
- 验证计划：先写 shared `transcribe_audio` schema 测试、Python transcribe handler/chunk 切分/幂等测试、worker dispatch 测试、TS search FTS 集成测试（PGlite 含生成列 + GIN）；确认失败后实现。完成后运行 shared schema/type/test、server type/test、Python worker unittest、`git diff --check`，并用手动 fixture 音频 smoke 真实转写。

- [x] `transcribe_audio` 注册进 `jobTypes` + shared Zod schema + 生成 JSON Schema。
- [x] Python worker 接入 faster-whisper（默认 `base`，`WHISPER_MODEL` 可配）。
- [x] `TranscribeHandler`：FFmpeg 抽音轨 → faster-whisper 转写 → 拿 segment timestamps。
- [x] 按 15-30s 窗口把 segments 累积切成 `text_chunk` asset（`text_content` + `start/end_time_seconds`）。
- [x] `ProbeHandler` 扩展：video/audio 创建 `transcribe_audio` job，video 同时创建 `index_media`，纯音频不创建 index_media。
- [x] `WorkerRunner` 新增 `transcribe_audio` handler dispatch。
- [x] Drizzle 迁移：新增 `media_assets.text_content text` 列（当前 schema 缺该列，但 API 契约已暴露）。
- [x] Drizzle 迁移：新增 `media_assets.text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text_content,''))) STORED` + GIN 索引（用 `coalesce`，避免 NULL text_content 使生成列为 NULL）。
- [x] Drizzle 迁移：新增 `text_chunk` 专用 partial 唯一索引 `UNIQUE (file_id, start_time_seconds, end_time_seconds) WHERE asset_type='text_chunk'`，保证并发 transcribe job 不插重复 chunk。
- [x] `create_job` 扩展支持 `timeout_seconds` 参数（当前只插 id/job_type/input_json/status）；ProbeHandler 为 `transcribe_audio` 显式写 `14400`，避免长视频走默认 3600s。
- [x] `POST /search` 增加 `text_search` group（tsvector 查询，`ts_rank_cd` 排序，`reason='text_match'`），受 `media_types` / `library_ids` 过滤。
- [x] `text_search` 触发条件明确：无 `media_types`（默认）或 `media_types` 含 `audio`/`video` 时都要返回；不依赖 Qdrant collection，独立按 `text_content` FTS 查询，`media_types:['audio']` 不能因无 audio vector collection 而空返回。
- [x] 同文件重跑 transcribe 幂等：顺序重跑靠应用层 upsert；并发靠 `text_chunk` 唯一索引兜底。
- [x] 单元测试注入 fake transcriber；FTS 用 PGlite（生成列 + GIN）验证命中与排序。
- [x] 小 fixture 音频手动 smoke 真实转写（非 CI）。

Review：

- Result：Phase 12 已接入 `transcribe_audio` job、Python worker faster-whisper 转写、15-30s text chunk 切分、PostgreSQL FTS 文本检索和 `text_search` 搜索 group。`probe_media` 现在对视频创建 `index_media` + `transcribe_audio`，对音频只创建 `transcribe_audio`；`transcribe_audio` job 显式使用 14400s timeout。数据库新增 `media_assets.text_content`、`text_tsv` 生成列、GIN 索引和 text_chunk partial unique index；文本 embedding collection 仍保持空 collection，不写 vector_refs。
- Notes：遵循红绿流程，先补 shared schema、Python worker/probe/dispatch、server FTS search 失败测试并确认红灯，再实现。自动验证通过：shared JSON Schema 生成、`tsc --noEmit`、Vitest 2 tests；server `tsc --noEmit`、Vitest 15 files / 36 tests；Python worker unittest 30 tests；web `check`（typecheck、Vitest 5 files / 8 tests、Next webpack build）；`git diff --check`。真实 smoke：安装 `faster-whisper` 1.2.1 到项目 `.venv`，用 `say` 生成 `/private/tmp/phase12-transcribe.aiff`，授权联网下载 faster-whisper tiny 权重后运行真实 `TranscribeHandler`，产出 1 个 `text_chunk`，`text_content` 为 `Red bicycle near the station.`。

## Phase 13：OCR 与画面文字检索

- Start：2026-06-15，目标是接入 PaddleOCR 识别图片/视频关键帧画面文字，写回原 asset 的 text_content 复用 Phase 12 FTS，区分 ocr_match 命中原因；text embeddings 延后。
- 假设：本阶段沿用 Phase 10-12 直接实施方式，不新建分支；PaddleOCR 作为可选运行依赖接入，单元测试注入 fake ocrer，不要求 CI 下载 OCR 权重；数据库零新迁移（复用 Phase 12 的 text_content/text_tsv/GIN）；`ocr_chunk` asset_type 预留给未来细粒度 bbox/block，Phase 13 不使用。
- 权衡：OCR 文本写回原 asset 而非新建 ocr_chunk，零迁移、复用 FTS、asset 行数不膨胀（代价：单 asset text_content 单份，细粒度 bbox 留给 ocr_chunk）；reason 区分 ocr_match/text_match 满足"展示命中原因"；OCR text embedding 延后同 Phase 12。
- 验证计划：先写 shared `run_ocr` schema 测试、Python ocr handler/写回/幂等/抽帧测试、worker dispatch 测试、TS search FTS（ocr_match/text_match 区分）+ 协调入口测试（PGlite）；确认失败后实现。完成后运行 shared schema/type/test、server type/test、Python worker unittest、`git diff --check`，并用小 fixture 图片手动 smoke 真实 PaddleOCR。

- [x] `run_ocr` 注册进 `jobTypes` + shared Zod schema + 生成 JSON Schema。
- [x] Python worker 接入 PaddleOCR（默认 `OCR_ENGINE=paddleocr`，`OCR_LANGUAGE=ch`，`OCR_MIN_CONFIDENCE=0.5`）。
- [x] `OcrHandler`：image asset 直接读图；video_frame asset 用 FFmpeg 按 `frame_time_seconds` 抽帧后 OCR。
- [x] OCR 文本写回**被 OCR 的原 asset** 的 `text_content`；`metadata_json.ocr` 记录 engine/language/confidence/block_count。
- [x] `IndexMediaHandler` 完成后为 image/video_frame asset 创建 `run_ocr` job（asset 粒度 `asset_ids`）。
- [x] `WorkerRunner` 新增 `run_ocr` handler dispatch。
- [x] `POST /jobs/ocr/queue-pending`：按 `library_id`/`file_id` 扫描未 OCR 的 image/video_frame asset，批量建 job（`OCR_BATCH_SIZE`，跳过已 OCR）。
- [x] 放宽 `listTextSearchResultMetadata`：查 `text_chunk`/`image`/`video_frame` 的 `text_content`，返回 `asset_type`。
- [x] `SearchService` 按 asset_type 映射 `reason`（text_chunk→`text_match`，image/video_frame→`ocr_match`）；`text_search` 触发 media type 扩到 image/audio/video。
- [x] run_ocr job timeout `7200s`（复用 `create_job(timeout_seconds)`）。
- [x] 同 asset 重跑 OCR 幂等（覆盖 text_content，不产生重复行）。
- [x] 单元测试注入 fake ocrer；FTS 用 PGlite 验证 ocr_match/text_match 区分与命中。
- [x] 小 fixture 图片手动 smoke 真实 PaddleOCR（非 CI）。

Review：

- Result：Phase 13 已接入 `run_ocr` job、PaddleOCR worker handler、image/video_frame OCR 写回、索引完成后的自动 OCR job 创建、待 OCR asset 批量补队列 API，以及 `text_search` 对 image/audio/video 的 FTS 覆盖。OCR 不新增迁移，复用 Phase 12 的 `text_content`/`text_tsv`；image/video_frame 命中返回 `reason='ocr_match'`，text_chunk 命中继续返回 `reason='text_match'`。
- Notes：遵循红绿流程，先补 shared schema、Python OCR handler/dispatch/index job、server FTS/queue-pending 失败测试并确认红灯，再实现。实现中修正真实 PaddleOCR 3.x 兼容性：`ocr(..., cls=False)` 已不被支持，适配为 `predict(..., use_textline_orientation=False)` 并规范化 `rec_texts`/`rec_scores`/`rec_polys` 输出。后续 review 修复问题：`upsert_media_asset` 重索引 UPDATE 改为保留未显式传入的 `text_content` 并 merge `metadata_json`，避免清空已写入 OCR；`run_ocr.engine` schema 收窄为 `paddleocr`，不再声明未实现的 EasyOCR；`POST /jobs/ocr/queue-pending` 接通 `limit` 与 `OCR_BATCH_SIZE`；PaddleOCR 默认缓存目录改为系统临时目录；`OcrHandler` 不再对 reader 已规范化 blocks 二次 normalize。自动验证通过：shared `tsc --noEmit`、Vitest 4 tests；server `tsc --noEmit`、Vitest 15 files / 40 tests；Python worker unittest 40 tests；web `check`（typecheck、Vitest 5 files / 8 tests、Next webpack build）；`git diff --check`。真实 smoke：安装 `paddleocr` 3.7.0 与 `paddlepaddle` 3.3.1 到项目 `.venv`，授权联网下载 PaddleOCR 官方模型后，用本地 PNG fixture 运行真实 `OcrHandler`，产出 `assets_processed=1`、`text_written=1`，并写入 `metadata_json.ocr`。

## Phase 14：Hybrid Retrieval 与 Reranking

- Start：2026-06-27。目标是把当前按 `groups` 分开的 Qdrant 向量召回和 PostgreSQL FTS 召回，升级为统一候选池、去重/合并后返回 top-level `results`，并保留 `groups` 作为调试和兼容字段。
- 假设：本阶段不新增外部 VLM、不新增文本 embedding collection 写入、不新增复杂 metadata query DSL；metadata filters 先指现有 `library_ids`、`media_types`、软删除过滤和 PostgreSQL 事实补齐过滤。`metadata_filter` 不作为普通语义命中原因，只有未来 metadata-only 搜索才可作为 primary reason。
- API 决策：`POST /search` 响应新增 top-level `results`，每条结果使用 `score_kind='hybrid_score'`、`primary_reason`、`reasons`、`source_scores` 和 `merged_asset_ids`；`groups` 暂时保留原始来源分组，兼容旧响应形状并便于调试，但 reason 命名同步迁移。转写命中原因从 `text_match` 迁移为 `transcript_match`；OCR 继续用 `ocr_match`；向量继续用 `vector_match`；`document_match` 只预留给后续 document pipeline。
- 权衡：新增 `results` 比直接替换 `groups` 更稳，避免一次性破坏 web、agent 和调试路径；迁移到 `transcript_match` 会产生 API 行为变化，但命中解释更清晰，避免 `text_match` 同时指 transcript、OCR 和文档正文。
- 验证计划：先补 server 搜索单测，覆盖向量+FTS 合并、同 asset 多原因、跨 asset 相邻视频片段合并、media/library 过滤一致性、audio FTS、`text_match` 不再出现在 `results` 或 `groups`、低分单来源不被抬成满分、overfetch 后再分页；再补 agent sanitize 和 web Search 页面测试。实现后运行 server typecheck/test、web check、必要的 shared typecheck/test 和 `git diff --check`。

- [x] 更新 `docs/api-contract.md`，标明当前 `POST /search` 返回 top-level `results` 并保留 `groups` 字段。
- [x] 在 server 搜索测试中新增红灯用例：同一 asset 同时被 vector 和 FTS 命中时，只返回一条 top-level result，`reasons` 同时包含两个来源。
- [x] 在 server 搜索测试中新增红灯用例：相邻视频命中按同一 `file_id` 和相近时间窗口合并，跨 asset 合并时使用代表 `asset_id` 并返回 `merged_asset_ids`。
- [x] 在 server 搜索测试中新增红灯用例：`media_types` 和 `library_ids` 过滤在 vector、FTS、合并后结果中语义一致；软删除过滤沿用 PostgreSQL metadata 补齐路径。
- [x] 在 server 搜索测试中新增红灯用例：audio/video 转写命中返回 `transcript_match`，OCR 命中返回 `ocr_match`，`document_match` 不在 Phase 14 主动产生。
- [x] 在 server 搜索测试中新增红灯用例：`groups` 结构保持兼容，且 reason 命名与 top-level `results` 一致。
- [x] 在 server 搜索测试中新增红灯用例：各来源从 offset 0 overfetch，合并/rerank 后再应用 request `offset` / `limit`。
- [x] 在 server 搜索测试中新增红灯用例：单来源低原始分数不会因归一化被抬到满分，也不会排到合理的多信号候选前面。
- [x] 在 server 搜索测试中新增红灯用例：同 source 多次命中合并时 `source_scores[sourceKey]` 取最大原始分数。
- [x] 在 server 搜索测试中新增红灯用例：`primary_reason` 使用加权归一化贡献，而不是 raw source score。
- [x] 抽出 SearchService 内部候选结构：统一表示 `asset_id`、`file_id`、时间范围、来源分数、来源原因和原始 collection。
- [x] 将 Qdrant `image_vectors` / `video_segment_vectors` 结果转成统一候选，并保留原始 `source_scores`。
- [x] 将 PostgreSQL FTS `text_search` 结果转成统一候选，并按 asset 来源映射 `transcript_match` / `ocr_match`。
- [x] 在统一候选池中按 asset/time identity 合并重复命中，累积 `reasons` 和 `source_scores`。
- [x] 对同一视频内相邻或重叠时间窗口做合并，合并后保留最强 primary reason、最高/合成分数和覆盖后的 start/end。
- [x] 添加基础 reranking：cosine 使用 raw clamp，FTS 使用 `rank / (rank + 1)` 饱和映射，再按 multi-signal bonus、FTS/向量权重和去重后时间窗口排序，输出 `hybrid_score`。
- [x] 固定 source key 命名：向量来源用 collection 名（如 `image_vectors`、`video_segment_vectors`），FTS 来源用 `text_search`；`source_scores` 保留原始来源分数，不做跨来源展示比较。
- [x] `POST /search` 返回 `{ limit, offset, results, groups }`；前端和 agent 默认消费 `results`，`groups` 仅作兼容/调试。
- [x] 更新 Agent `search_media` 工具的输出清洗和 summary 抽取逻辑，避免继续只读 `groups`。
- [x] 更新 Search 页面类型、筛选项和结果展示，支持 image/video/audio，并展示 primary reason / reasons；document filter 等 document pipeline 落地后再补。
- [x] 更新 README 或相关文档中 “Phase 14 之前按 group 展示” 的说明，改为 Phase 14 后以 top-level `results` 为主。
- [x] 运行 `corepack pnpm --filter @local-media-agent/server check`。
- [x] 运行 `corepack pnpm --filter @local-media-agent/web check`。
- [x] 运行必要的 shared 验证：`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit` 和 `corepack pnpm --filter @local-media-agent/shared exec vitest run`。
- [x] 运行 `git diff --check`，并在本段 Review 记录结果。

Review：

- Result：Phase 14 已实现 hybrid retrieval 与 reranking。`POST /search` 现在返回 top-level `results`，同时保留原始来源 `groups`；SearchService 会从 Qdrant 和 PostgreSQL FTS overfetch，转成统一候选，合并同 asset 和相邻视频窗口，输出 `hybrid_score`、`primary_reason`、`reasons`、`source_scores` 和 `merged_asset_ids`。Agent `search_media` 改为优先消费 `results` 并清洗 path；Web Search 页面改为展示混合结果，支持 image/video/audio 筛选和命中原因展示。
- Notes：验证通过：`corepack pnpm --filter @local-media-agent/server check`（16 个 test files / 46 tests）；`corepack pnpm --filter @local-media-agent/web check`（5 个 test files / 8 tests + Next build）；`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/shared exec vitest run`（1 个 test file / 4 tests）；`git diff --check`。当前 `.gitignore` 的 `*.test.ts` 会让多数 server 测试在普通 `git status` 中不可见；本阶段保留既有 ignore 策略，提交时需要显式处理这些测试文件。额外尝试 `corepack pnpm format:check` 时仅剩 `apps/web/next-env.d.ts` 这个 Next 生成文件不符合 Oxfmt，但该文件已恢复为无 diff 状态，未纳入 Phase 14 改动。

## Phase 15：外部多模态模型验证

- [ ] 在 TypeScript Model Gateway 中添加 external VLM provider 接口。
- [ ] 添加 `inspect_candidates_with_vlm` tool。
- [ ] 只发送 top candidates 的关键帧或缩略图。
- [ ] 添加 `allow_external_vlm` 开关。
- [ ] 展示 VLM 解释和置信判断。
- [ ] 记录哪些候选被发送给外部模型。

Review：

- Result：
- Notes：

## Phase 16：Clip Workspace 与 Montage

- [ ] 添加 clip workspace 数据模型。
- [ ] 支持收藏多个 segments。
- [ ] 支持调整 start/end。
- [ ] 支持批量导出 clips。
- [ ] 支持 FFmpeg montage 拼接。
- [ ] Agent 生成剪辑计划后等待用户确认。

Review：

- Result：
- Notes：

## Phase 17：索引运维与性能控制

- [ ] 添加 `light`、`balanced`、`dense` indexing profiles。
- [ ] 支持按 library、目录和文件类型触发索引。
- [ ] 通过 PostgreSQL job state 和 worker 检查点支持暂停、恢复和重试失败 jobs。
- [ ] 添加 worker 并发控制。
- [ ] 添加文件数量、向量数量、缓存大小和失败数量统计。

Review：

- Result：
- Notes：

## Phase 18：本地部署与可维护性

- [ ] 完善 README 一键启动步骤。
- [ ] 添加 `.env.example` 注释。
- [ ] 添加常见问题排查文档。
- [ ] 添加日志目录和日志格式说明。
- [ ] 添加数据库备份和恢复说明。
- [ ] 添加模型缓存目录说明。

Review：

- Result：
- Notes：

## 完成 Review

- Result：
- Notes：

## Bugfix：添加素材库时 `/libraries` 返回 500

- Start：2026-06-10，目标是定位项目启动后前端添加素材库时 `POST /libraries` 返回 500 的根因，并判断是否与中文路径有关。
- 假设：先不假定是中文路径问题；需要从服务端异常、请求体、路径处理、数据库约束和运行环境逐层确认。
- 验证计划：复现 `POST /libraries`，读取服务端错误栈；用包含中文与不包含中文的路径分别测试；必要时补一个最小回归测试后再改代码。

- [x] 复现 `POST /libraries` 500 并记录真实错误信息。
- [x] 检查 `LibrariesController` / `LibrariesService` / repository 的路径处理与校验。
- [x] 对比中文路径和 ASCII 路径的行为，确认路径是否为根因。
- [x] 若需要修改，先补最小失败测试，再做单点修复。
- [x] 运行相关验证并在本段 Review 记录结果。

Review：

- Result：定位到 500 根因不是中文路径，而是当前真实 PostgreSQL 数据库尚未执行 migration，`libraries` 表不存在。
- Notes：`GET /health` 在 4001 调试副本返回 200，说明 PostgreSQL/Qdrant 可连接；`POST /libraries` 使用中文路径和 ASCII 路径均返回 500。服务端异常栈显示 Drizzle insert 失败，PostgreSQL 错误为 `42P01 relation "libraries" does not exist`。`README.md` 当前启动步骤只包含启动基础设施和后端，没有包含真实数据库 migration 步骤；健康检查也只验证连接，不验证 schema。

## Bugfix：启动流程增加 migration 与 schema 检查

- Start：2026-06-12，目标是在启动文档中明确手动执行 Drizzle migration，并让后端启动时检查关键业务表是否存在，避免缺表时等到 `/libraries` 才返回 500。
- 假设：`db:migrate` 作为显式脚本提供，不塞进 `dev`，因此不会每次启动自动执行；schema 检查只验证关键表存在，不负责自动修复数据库。
- 验证计划：先写 `DatabaseSchemaGuardService` 缺表失败测试；实现后运行 server typecheck、相关 Vitest 和 `git diff --check`。

- [x] 添加缺少关键表时抛出清晰 migration 指引的测试。
- [x] 实现后端启动 lifecycle schema guard。
- [x] 添加 `db:migrate` 脚本。
- [x] 更新 README 启动步骤，说明 migration 是手动步骤。
- [x] 运行验证并记录 Review。

Review：

- Result：新增 `DatabaseSchemaGuardService`，后端启动时检查 `libraries`、`media_files`、`media_assets`、`vector_refs`、`jobs` 和 `agent_runs` 是否存在；缺表时抛出包含 `corepack pnpm --dir apps/server db:migrate` 的明确错误。新增 `apps/server` 的 `db:migrate` 脚本，并在 README 启动流程中把数据库迁移放在基础设施之后、后端 API 之前。随后修复 `drizzle.config.ts`，让 Drizzle CLI 也加载 `apps/server/.env` 或仓库根目录 `.env`，避免 migrate 使用 fallback 数据库地址。
- Notes：遵循红绿流程，先新增 `tests/database/schema-guard.test.ts` 并观察缺实现失败，再补 service 和 module wiring。实现中发现并修复 `schema-guard.service` 与 `database.module` 之间的 token 循环依赖，将 `PG_POOL` / `DATABASE` 拆到 `database.tokens.ts`。用户执行 `db:migrate` 后发现 Drizzle CLI 未读取 `.env`，经验证 fallback 连接 `postgres://postgres:postgres@127.0.0.1:5432/local_media_agent` 会认证失败，而 `.env` 中 `media_agent` 连接可用。验证通过：`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，15 个 test files / 35 tests 通过；`git diff --check` 通过；修复 `.env` 加载后用只读命令确认 Drizzle config 解析到 `postgres://media_agent:media_agent_dev@127.0.0.1:5432/media_agent`。未自动执行真实数据库 migration，避免在未确认的情况下修改本机 PostgreSQL 状态。

## 工具链补充：Prettier 与 ESLint

- Start：2026-06-03，目标是在 monorepo 根目录添加通用格式化和 lint 配置，不改变业务 Phase 进度。
- 假设：当前先使用轻量 recommended 规则，避免一次性引入大量风格规则导致噪音；Next 专属规则后续可在前端规则稳定后再加。
- 验证计划：运行 Prettier check、ESLint 和 `git diff --check`，只根据验证结果调整配置。

- [x] 添加根目录 Prettier 配置。
- [x] 添加根目录 ESLint flat config。
- [x] 添加根目录 lint / format scripts。
- [x] 安装并锁定必要 devDependencies。
- [x] 运行格式和 lint 验证。

Review：

- Result：添加根目录 `prettier.config.mjs`、`.prettierignore` 和 `eslint.config.mjs`；根 `package.json` 新增 `lint`、`format` 和 `format:check` scripts，并安装 `eslint`、`@eslint/js`、`typescript-eslint`、`globals`、`eslint-config-prettier` 和 `prettier` devDependencies。按新 Prettier 配置格式化现有代码/配置文件，并删除 `apps/server/src/database/repositories.ts` 中被 lint 发现的无用 `lt` import。
- Notes：验证通过：`corepack pnpm format:check`；`corepack pnpm lint`；`git diff --check`；`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，10 个 test files / 21 个 tests 通过；`corepack pnpm --filter @local-media-agent/web check`，包含 typecheck、3 个 test files / 4 个 tests 和 Next build；`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`、`tsc --noEmit` 和 Vitest 3 个 tests 通过。`corepack pnpm check` 仍因当前 shell 没有裸 `pnpm` shim 且根脚本内部调用 `pnpm --recursive check` 而失败；该限制与此前 Phase 记录一致，本次未扩大范围重写既有 package check scripts。

## 工具链迁移：Oxlint 与 Oxfmt

- Start：2026-06-16，目标是在 monorepo 根目录直接用 `oxlint` 和 `oxfmt` 替换 ESLint 与 Prettier，让默认 `lint` / `format` / `format:check` 使用 Oxc 工具链。
- 假设：本阶段只处理 JavaScript/TypeScript/JSON/YAML/CSS 等现有 Prettier/ESLint 覆盖的前端与 Node 代码，不处理 Python worker；不引入 Vite+，因为当前项目已经有 Next.js、NestJS 和 pnpm workspace，单独替换 lint/format 工具影响面更小。
- 权衡：项目当前没有上线负担，也没有外部团队或 CI 依赖旧格式输出，因此不保留 ESLint/Prettier 过渡脚本，避免迁移后继续维护两套工具链。`tsc --noEmit` 仍保留为类型检查事实来源，`oxlint` 不替代 TypeScript 编译检查。
- 验证计划：安装官方包并生成配置后，运行 `oxlint` 与 `oxfmt --check`；若 `oxfmt --check` 失败，先运行 `oxfmt` 并审查 diff，只接受纯格式化变更；最后运行 TypeScript、Vitest、Next build 和 `git diff --check`。

- [x] 安装 `oxlint` 和 `oxfmt` 到根目录 devDependencies，并更新 lockfile。
- [x] 使用迁移工具或手工创建 `.oxlintrc.json`，迁移现有 `eslint.config.mjs` 的 ignore、browser/node/vitest 环境和 `_` 前缀 unused-vars 约定。
- [x] 创建 `.oxfmtrc.jsonc`，迁移 `prettier.config.mjs` 中的 `printWidth: 100`、`tabWidth: 2`、`useTabs: false`、`semi: false`、`singleQuote: true`、`bracketSpacing: true`、`trailingComma: "all"` 和 `arrowParens: "always"`。
- [x] 将根目录 `lint` 改为 `oxlint`，新增 `lint:fix`；将 `format` 改为 `oxfmt`，将 `format:check` 改为 `oxfmt --check`。
- [x] 删除 `eslint.config.mjs`、`prettier.config.mjs` 和 ESLint/Prettier 相关 devDependencies。
- [x] 运行 `corepack pnpm lint` 和 `corepack pnpm format:check` 验证 Oxc 工具链。
- [x] 若 `oxfmt` 产生格式化 diff，审查 diff 后只接受纯格式化变更；若出现语义风险，停下重新评估是否继续保留 Prettier。
- [x] 运行 `corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`、`corepack pnpm --filter @local-media-agent/server exec vitest run`、`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`、`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`、`corepack pnpm --filter @local-media-agent/shared exec vitest run` 和 `corepack pnpm --filter @local-media-agent/web check`。
- [x] 运行 `git diff --check`，并在本段 Review 记录结果和格式化差异。

Review：

- Result：根目录工具链已直接替换为 Oxc：新增 `.oxlintrc.json` 和 `.oxfmtrc.jsonc`，`package.json` 的 `lint` / `format` / `format:check` 切换为 `oxlint` / `oxfmt`，新增 `lint:fix`；移除 `eslint.config.mjs`、`prettier.config.mjs`、`.prettierignore` 以及 ESLint/Prettier 相关 devDependencies，保留 `tsc --noEmit` 作为类型检查入口。
- Notes：安装时沿用当前 `node_modules` 已使用的 pnpm store（`/Users/zhihu/Library/pnpm/store/v10`），避免重装整个依赖树。`corepack pnpm lint` 通过；首次 `corepack pnpm format:check` 报 17 个 JS/TS/JSON 文件格式差异，运行 `corepack pnpm format` 后复查通过，差异为 `oxfmt` 的换行/链式调用格式化；已关闭 `sortPackageJson`，避免 package 字段排序噪音。验证通过：`corepack pnpm --filter @local-media-agent/shared exec node --import tsx scripts/generate-json-schemas.ts`；`corepack pnpm --filter @local-media-agent/server exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/server exec vitest run`，15 个 test files / 40 tests 通过；`corepack pnpm --filter @local-media-agent/shared exec tsc --noEmit`；`corepack pnpm --filter @local-media-agent/shared exec vitest run`，1 个 test file / 4 tests 通过；`corepack pnpm --filter @local-media-agent/web check`，包含 5 个 test files / 8 tests 和 Next webpack build；`git diff --check` 通过。

## Scene MaxSim、多关键帧 Caption 与前端任务体验

- [x] 长镜头按最多 30 秒拆窗，每个窗口至少创建一个 `video_frame`，停止创建新的 `video_segment_vectors` refs。
- [x] 视频帧按 `(file_id, scene_id)` 做 MaxSim，PostgreSQL 提供真实场景边界。
- [x] Qwen2.5-VL 使用同场景 1～6 张有序关键帧生成 `scene-caption-v2`，保留完整 provenance。
- [x] 增加视频批量重建与 readiness API，兼容开关验证通过后才关闭旧 segment 在线召回。
- [x] 搜索页增加 loading/错误反馈；任务页每页 25 条、每 5 秒可见时自动刷新，并修复卡片粘连。
- [x] 新增 Obsidian 笔记 `docs/知识库/RAG在当前项目中的应用.md` 和现有数据升级步骤。

## Phase 19：检索评测与无权重 RRF 基线

- Start：2026-07-12，目标是建立可复现的检索评测闭环，在不改变生产排序的前提下，对同一召回快照比较 current hybrid 与 visual/caption/lexical 无权重 RRF。
- 假设：首轮固定关闭查询扩展与 `video_segment_vectors`，RRF `k=60` 且各信号权重为 1；RRF score 只用于排序，不表示相关概率。
- 验证计划：以 PGlite + mock 召回完成冻结查询、运行、盲标和报告高层测试；补 RRF/指标纯函数测试与 Web 盲标测试；运行仓库级 check、lint、format check 和独立双轴代码审查。

- [x] 建立评测集、不可变版本、查询、运行、候选快照与可复用判断的 PostgreSQL Schema 和正式 Drizzle migration。
- [x] 实现来源内连续 rank、场景折叠、lexical 时间窗对齐、动态诊断深度和无权重 RRF。
- [x] 实现 current/RRF 同快照排序、盲标证据隐藏、幂等判断和 Precision/nDCG/Hit/MRR 报告。
- [x] 实现评测 API、版本续建、运行历史、JSON 导出和 fail-fast 来源检查。
- [x] 实现 Web 查询编写、指定目标、冻结、运行、盲标、恢复、报告与证据诊断入口。
- [x] 更新 API、架构、向量设计和 Living Documentation。
- [x] 将指定目标从手工 UUID 输入改为素材库文件筛选、图片/视频预览和可播放的 scene 时间段点选。
- [x] 完成审查修复后的最终全量验证与提交。

Review：

- Result：评测 MVP 已形成数据库、server、web 与文档闭环；生产 `/search` 排序保持不变。独立代码审查发现的深层候选、scene 对齐、current rank、盲标绕过、版本与恢复入口问题已在提交前修正。
- Notes：独立 Standards/Spec 双轴审查先发现来源状态、深层候选、scene 对齐、current 对照、盲标绕过和版本/恢复入口问题，修复后 Spec 复核无阻塞项。最终 `corepack pnpm check` 通过：shared 5、web 36、server 88 个测试及 Next 生产构建成功；`corepack pnpm lint` 通过。Oxfmt 已格式化本次涉及文件；全仓 `format:check` 仍报告 18 个未改动既有文件的历史格式差异，未扩大范围重写。真实 PostgreSQL migration 由维护者按既有手动流程执行，本次未直接修改本机数据库。
