# 项目任务清单

本文件用于跟踪实施工作。在真正开始实施前，它只作为规划文档。

## 执行规则

- 实施必须遵守 `docs/implementation-rules.md`。
- 每个 Phase 完成后必须等待用户确认，再进入下一个 Phase。
- 每个 Phase 的 `Review` 区域必须记录结果、验证和后续衔接点。

## 当前进度

- 当前阶段：Phase 11 已完成实现、单元/服务验证和真实 PySceneDetect + FFmpeg smoke 验证。
- 最近更新：2026-06-09，安装 Python 3.12、PySceneDetect 和 FFmpeg，并完成真实 scene 检测/抽帧 smoke。
- 下一步：用户确认后进入 Phase 12 语音转写与文本检索。

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

- [ ] Python worker 接入 faster-whisper 或 whisper.cpp。
- [ ] 添加 transcription job。
- [ ] 将 transcript 切成 15 到 30 秒 chunks。
- [ ] 将 transcript 写入 PostgreSQL。
- [ ] 添加 PostgreSQL full-text search。
- [ ] 可选生成 text embeddings。

Review：

- Result：
- Notes：

## Phase 13：OCR 与画面文字检索

- [ ] Python worker 接入 PaddleOCR 或 EasyOCR。
- [ ] 对图片执行 OCR。
- [ ] 对视频关键帧执行 OCR。
- [ ] 将 OCR 文本写入 media assets。
- [ ] 将 OCR 文本纳入 full-text search。
- [ ] 在搜索结果中展示 OCR 命中原因。

Review：

- Result：
- Notes：

## Phase 14：Hybrid Retrieval 与 Reranking

- [ ] 合并 Qdrant vector results。
- [ ] 合并 PostgreSQL FTS results。
- [ ] 应用 metadata filters。
- [ ] 合并相邻视频命中。
- [ ] 添加基础 reranking 规则。
- [ ] 返回命中原因。

Review：

- Result：
- Notes：

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
