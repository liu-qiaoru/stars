# 项目工具清单

本文记录当前项目已经在依赖、配置、源码或启动流程中使用的主要工具。记录口径是“当前项目怎么落地”，不是通用技术选型介绍；未来规划但尚未进入核心路径的能力会单独标明边界。

## 工程与包管理

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| Node.js 22 | TypeScript/Next.js/NestJS 运行环境 | 根 `package.json` 通过 `engines.node >=22.0.0` 约束版本；README 初始化流程要求 `nvm use` 后安装依赖。 |
| pnpm workspace | monorepo 包管理和脚本编排 | 根 `pnpm-workspace.yaml` 管理 `apps/*` 和 `packages/*`；根脚本用 `pnpm --filter` 分别启动或验证 web/server/shared。 |
| Corepack | 固定并调用 pnpm 版本 | README 和历史验证命令使用 `corepack pnpm ...`，避免本机缺少裸 `pnpm` shim 时脚本不可用。 |
| TypeScript | 前端、后端和共享协议主语言 | `apps/web`、`apps/server`、`packages/shared` 都有 `tsconfig.json`，验证入口是 `tsc --noEmit`。 |
| tsx | 直接运行 TypeScript 脚本 | server dev 脚本使用 `tsx watch src/main.ts`；shared 使用 `node --import tsx scripts/generate-json-schemas.ts` 生成 JSON Schema。 |

## 前端工具

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| Next.js | 前端应用框架 | `apps/web` 使用 App Router，页面包括 `/search`、`/libraries`、`/jobs`、`/media/[id]`、`/agent`；构建脚本固定为 `next build --webpack`。 |
| React | 组件和交互状态 | 前端工作台组件位于 `apps/web/components`，例如 Search、Library、Jobs、Media Detail 和 Agent。 |
| Tailwind CSS | 样式系统 | `apps/web/app/globals.css` 引入 Tailwind，页面和组件使用 utility class 实现工具型 UI。 |
| PostCSS / Autoprefixer | CSS 构建链路 | `apps/web/postcss.config.mjs` 为 Tailwind 4 构建提供 PostCSS 配置。 |
| lucide-react | 图标库 | 导航、搜索、Library、Agent 等组件使用 lucide 图标。 |
| clsx | className 条件组合 | `MediaThumbnail` 等组件用它组合状态样式。 |

## 后端 API 工具

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| NestJS | TypeScript 主控 API 框架 | `apps/server/src/app.module.ts` 组合 Config、Health、Database、Qdrant、Libraries、Jobs、Media、Search、Agent 等模块。 |
| Express adapter | NestJS HTTP adapter | 项目使用 NestJS 默认 Express adapter，没有引入 Fastify adapter。 |
| Zod | 运行时校验和协议定义 | server 配置解析、请求参数、Agent tool schema、shared job schema 都使用 Zod。 |
| Vercel AI SDK `ai` | Agent tool/function calling 编排 | `apps/server/src/agent` 使用 `tool()` 定义工具，用 `generateText()` 执行有限步 tool loop。 |
| `@ai-sdk/anthropic` | 可选外部 LLM provider | 只有 `ALLOW_EXTERNAL_LLM=true` 且配置 `ANTHROPIC_API_KEY` 时才会调用；默认关闭。 |

## 数据库与向量检索

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| PostgreSQL | 事实数据库和后台任务队列 | 保存 libraries、media files、media assets、vector refs、jobs、agent runs/events/tool calls；worker 也从 `jobs` 表 claim 任务。 |
| Drizzle ORM | TypeScript 侧 schema 和查询 | `apps/server/src/database/schema.ts` 定义 schema，repositories 使用 Drizzle 查询。 |
| drizzle-kit | migration 工具 | `apps/server` 的 `db:migrate` 脚本执行 migration，migration 文件位于 `apps/server/drizzle`。 |
| pg / node-postgres | PostgreSQL 连接驱动 | server `DatabaseModule` 使用 `pg.Pool` 连接真实 PostgreSQL。 |
| PGlite | 测试数据库 | server 数据库测试用 PGlite 加载 migration，验证 repository 和 schema 行为，不依赖本机 PostgreSQL。 |
| Qdrant | 向量数据库 | 保存图片、视频帧、视频片段、音频片段和文本 chunk 的向量 collection；只存向量和轻量 payload，事实数据回 PostgreSQL 查。 |
| `@qdrant/js-client-rest` | TypeScript Qdrant client | Search service 用它读取 Qdrant；Qdrant module 初始化 collection registry。 |
| Python Qdrant HTTP client | worker 写入 Qdrant | `apps/worker-py/media_agent_worker/qdrant.py` 用 `urllib` 调 Qdrant REST API upsert points。 |

## Python Worker 与媒体处理

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| Python 3.12 | worker 和本地模型服务运行环境 | README 要求创建 `.venv` 并安装 `apps/worker-py/requirements.txt`。 |
| psycopg | Python 访问 PostgreSQL | worker repository 使用 psycopg 连接数据库，claim job、读写 media metadata 和 job result。 |
| FFmpeg | 媒体处理命令行工具 | 用于导出视频 clip、抽取音频 WAV、抽取视频帧。 |
| ffprobe | 媒体 metadata 探测 | `ProbeHandler` 调用 ffprobe 获取 duration、codec、streams、width、height。 |
| Pillow | 图片读取 | SigLIP embedder 用 Pillow 打开图片并转为 RGB。 |
| PySceneDetect / scenedetect | 视频 scene detection | `IndexMediaHandler` 在 `scene_detection` 策略下检测 scene；异常、空结果或 scene 过多时回退固定 30 秒切片。 |
| torch | 本地模型运行底层 | SigLIP embedding 通过 torch 执行，并支持 `SIGLIP_DEVICE=cpu/mps/cuda/auto`。 |
| transformers | SigLIP 模型加载 | `SiglipEmbedder` 使用 `AutoProcessor` 和 `AutoModel` 加载 `google/siglip-base-patch16-224`。 |
| faster-whisper | 音频/视频转写 | `TranscribeHandler` 先用 FFmpeg 抽音频，再用 faster-whisper 生成 transcript chunk。 |
| PaddleOCR | 画面文字识别 | `OcrHandler` 对 image 或 video_frame asset 做 OCR，并把文本写回 asset 的 `text_content`。 |
| paddlepaddle | PaddleOCR 运行时 | 作为 PaddleOCR 的底层依赖安装。 |

## 本地模型与检索

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| SigLIP `google/siglip-base-patch16-224` | 图片、视频帧和文本 query embedding | Python worker 生成图片/视频向量并写入 Qdrant；本地 model service 为搜索 query 生成 text vector。 |
| 本地 Python model service | localhost embedding RPC | `python -m media_agent_worker.model_service` 默认监听 `127.0.0.1:4020`，提供 `/embed/text` 和 `/embed/image`。 |
| Model Gateway | TypeScript 到本地模型服务的边界 | server `ModelGatewayService` 调用 `/embed/text`，校验 vector 维度后供 Search service 使用。 |
| sentence-transformers `all-MiniLM-L6-v2` | 文本/audio 向量模型预留 | 当前在 vector registry 中为 `audio_segment_vectors` 和 `text_chunk_vectors` 定义维度和模型名；当前核心检索路径主要使用 PostgreSQL FTS 处理 transcript/OCR 文本。 |

## 共享协议与代码生成

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| `packages/shared` | 前端、后端和 worker 的协议事实来源 | 保存 constants、types、Zod schemas、typed API client 和生成物。 |
| zod-to-json-schema | Zod 到 JSON Schema 生成 | `packages/shared/scripts/generate-json-schemas.ts` 把 job input/output schema 生成到 `packages/shared/generated/job-schemas.json`，供 Python worker 校验协议。 |

## 基础设施与配置

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| Docker Compose | 本地基础设施编排 | `infra/docker-compose.yml` 定义 PostgreSQL、Qdrant 和可选 Redis。 |
| Redis | 可选实时事件通道 | 放在 Compose `realtime` profile 中；当前不承担核心 job queue，也不是长期业务状态存储。 |
| `.env` | 本地配置入口 | server、drizzle-kit、worker、model service 都通过环境变量读取数据库、Qdrant、模型服务和 Agent 配置。 |

## 测试与质量工具

| 工具 | 作用 | 当前项目怎么使用 |
| --- | --- | --- |
| Vitest | TypeScript 测试 | server、web、shared 都使用 Vitest；server 覆盖 service/controller/repository，web 覆盖组件和 API client。 |
| Testing Library | React 组件测试 | `apps/web/tests` 用它渲染和断言前端组件行为。 |
| jsdom | 前端测试 DOM 环境 | web Vitest 配置使用 jsdom 模拟浏览器 DOM。 |
| Python unittest | worker 单元测试 | `apps/worker-py/tests` 覆盖 scan、probe、index、embedding、OCR、transcribe、export 和 repository。 |
| oxlint | JavaScript/TypeScript lint | 根脚本 `pnpm lint` 和 `pnpm lint:fix` 使用 oxlint。 |
| oxfmt | 格式化工具 | 根脚本 `pnpm format` 和 `pnpm format:check` 格式化 JS/TS/JSON/CSS/YAML。 |
| `tsc --noEmit` | 类型检查 | web、server、shared 的 `typecheck` 脚本都使用它。 |
| `next build --webpack` | 前端构建验证 | web `check` 中执行，当前固定 webpack 构建路径。 |

## 当前边界

- PostgreSQL 是事实来源；Qdrant 只做向量召回，不保存完整 metadata、transcript、OCR 全文或源文件内容。
- Python worker 负责媒体和模型重任务；NestJS controller 不直接执行 FFmpeg、embedding、OCR 或转写。
- Redis 当前只是可选实时通道，不是核心任务队列。
- 外部 LLM 默认关闭；Agent 的副作用工具必须走服务端确认流程。
- `audio_segment_vectors` 和 `text_chunk_vectors` 已在 collection registry 中定义，但当前 transcript/OCR 的核心文本检索主要走 PostgreSQL FTS。
