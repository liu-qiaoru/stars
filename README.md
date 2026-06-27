# 本地多模态媒体 Agent

这是一个**本地优先**的多模态媒体检索与剪辑 Agent，用于管理个人图片、视频、音频和文本素材库。目标规模约 1 TB（以视频为主）。系统默认保留原始文件在用户自己的磁盘上，不上传、不复制源素材；应用只在本地工作目录保存 metadata、索引、缩略图、抽帧、转写、OCR 结果和导出剪辑。

项目实现遵循 `docs/architecture.md` 的架构设计，并按 `docs/tasks/todo.md` 中的 Phase 分阶段推进。当前阶段：**Phase 1–13 已完成**（后端 API、Next.js 前端、真实 SigLIP 视觉 embedding、视频 scene 切分、faster-whisper 转写、PaddleOCR 画面文字识别、FTS 文本检索、Agent MVP、Clip 导出）。

默认配置下，**外部 LLM 是关闭的**；所有检索依赖本地模型（SigLIP、faster-whisper、PaddleOCR），不调用 OpenAI、Anthropic 等外部服务。

## 目录

- [项目架构](#项目架构)
- [仓库结构](#仓库结构)
- [环境要求](#环境要求)
- [初始化](#初始化)
- [启动步骤](#启动步骤)
- [数据库可视化查看（DBeaver）](#数据库可视化查看dbeaver)
- [本地检索链路](#本地检索链路)
- [验证](#验证)
- [常见问题](#常见问题)

## 项目架构

### 进程拓扑

端到端检索链路需要 **5 个进程** 协同工作。TypeScript 是主控层，Python 只承担媒体处理和模型推理重任务。

```text
┌──────────────────────────────────────────────────────────────────┐
│                         浏览器 :3000                             │
│                    Next.js 前端 (apps/web)                       │
│   /search  /libraries  /jobs  /media/[id]  /agent                │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP（typed API client）
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              NestJS 后端 API :4000 (apps/server)                 │
│   Libraries / Jobs / Media / Search / Clips / Agent 模块         │
│   - 创建 jobs、读取 Qdrant、PostgreSQL FTS、Agent 编排            │
│   - 拥有 Drizzle schema 与 Zod 协议（schema 权威）              │
└─────┬──────────────┬─────────────────┬──────────────────┬────────┘
      │              │                 │                  │
      │ 读写事实数据  │ 向量召回读取     │ 同步 query embed │ 默认关闭
      ▼              ▼                 ▼                  ▼
┌──────────┐   ┌──────────┐    ┌──────────────┐   外部 LLM (AI SDK)
│PostgreSQL│   │ Qdrant   │    │ Model Gateway │   ALLOW_EXTERNAL_LLM
│  :5432   │   │ :6333    │    │  → :4020      │   =false 时不调用
│ 事实数据  │   │ 向量+payload│  │ SigLIP text  │
│ + job 队列│   │           │   │  embedding    │
└────┬─────┘   └─────▲────┘    └──────────────┘
     │               │ upsert points        ▲
     │ claim jobs    │ + 写 vector_refs      │ 共享推理代码
     │ (SKIP LOCKED) │                       │
     ▼               │                       │
┌────────────────────────────────────────────┴────────────────────┐
│              Python Worker (apps/worker-py)                      │
│   scan → probe → index → embed → transcribe → ocr → export      │
│   从 PostgreSQL jobs 表领取任务，执行媒体/模型重任务             │
│   写 Qdrant points + media_assets + vector_refs                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ FFmpeg/ffprobe 直接读源文件
                                 ▼
                  本地媒体磁盘（源素材不复制、不上传）
                  .media-agent/（缓存 / 导出 / 日志）
```

> **两个独立的 Python 进程**：① `media_agent_worker`（worker，批量索引）；② `media_agent_worker.model_service`（常驻 localhost RPC，供后端搜索时同步生成 query embedding）。worker 和 model service 可以共享同一套 SigLIP 推理代码。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 16 / React 19 / Tailwind 4 / TypeScript |
| 后端 API | NestJS（Express adapter）/ Zod / Vercel AI SDK（可选 Anthropic） |
| 数据库 | PostgreSQL 16（Drizzle ORM + node-postgres） |
| 向量库 | Qdrant（JS client + Python HTTP client） |
| Python worker | FFmpeg、ffprobe、PySceneDetect、SigLIP（torch/transformers）、faster-whisper、PaddleOCR |
| 任务队列 | PostgreSQL-backed jobs（`SELECT ... FOR UPDATE SKIP LOCKED`，无 Celery/BullMQ） |
| 测试 | Vitest（TS）/ unittest（Python）/ PGlite（无依赖 PostgreSQL 的单测） |

### 核心设计原则

- **TypeScript 是 schema 权威**。Drizzle schema 在 `apps/server/src/database/schema.ts`，Zod job schema 在 `packages/shared/schemas/`。Python worker 读取生成的 `packages/shared/generated/job-schemas.json` 校验协议，无独立 ORM 模型。
- **PostgreSQL 是事实来源**。保存 metadata、jobs、agent 记录；Qdrant 只存向量和轻量 payload，命中后回 PostgreSQL 补齐事实数据。
- **两条 embedding 路径不可混淆**：① 批量索引 embedding 走 worker job；② 搜索 query embedding 同步调用 model service（不能进队列，否则搜索会被索引阻塞）。
- **FTS 与 OCR 复用同一列**。transcript（`text_chunk`）和 OCR（`image`/`video_frame`）都写回 `media_assets.text_content`，共用 `text_tsv` 生成列 + GIN 索引。搜索按 asset type 映射命中原因：`text_chunk → transcript_match`，`image`/`video_frame → ocr_match`。
- **Qdrant point_id 跨语言一致**。使用 UUIDv5（namespace `f3f4e35a-...`，输入用 `|` 拼接），TS 和 Python 必须产生相同 ID 以保证幂等 upsert。

详细架构见 `docs/architecture.md`，工具清单见 `docs/tools.md`。

## 仓库结构

```text
apps/web          Next.js 前端（Phase 7 起实现）
apps/server       TypeScript / NestJS 主控 API（从 Phase 2 起）
apps/worker-py    Python 媒体与模型 worker（从 Phase 4 起）
  ├── media_agent_worker/        worker 主体（scan/probe/index/embed/transcribe/ocr/export）
  └── media_agent_worker/model_service.py  本地常驻 SigLIP embedding RPC 服务
packages/shared   共享 Zod schemas、types、constants、API client 和生成给 Python 的 JSON Schema
infra             本地基础设施定义（docker-compose.yml：PostgreSQL / Qdrant / 可选 Redis）
docs              架构、API 契约、job 协议、向量索引设计和实施记录
```

## 环境要求

- **Node.js 22**（`.nvmrc` 指定 `22.22.2`）
- **pnpm 10**（`packageManager: pnpm@10.12.1`，通过 Corepack 调用）
- **Python 3.12**（worker 和本地模型服务运行环境）
- **Docker** 兼容的本地容器运行时：OrbStack、Docker Desktop 或其他兼容 Docker Compose 的运行时
- **FFmpeg / ffprobe**：probe、抽帧、剪辑导出和音频抽取依赖；首次使用前确保 `ffmpeg` 在 `PATH` 中（macOS 推荐 `brew install ffmpeg`）

> Python 依赖按阶段引入：Phase 10 起 `torch`/`transformers`/`pillow`（SigLIP）；Phase 11 起 `scenedetect`（视频 scene detection）；Phase 12 起 `faster-whisper`（转写）；Phase 13 起 `paddleocr`/`paddlepaddle`（OCR）。首次运行时模型权重会从网络下载并缓存到本机，后续运行复用本地缓存。

## 初始化

```bash
nvm use
cp .env.example .env
pnpm install
```

初始化 Python worker 运行环境（在仓库根目录执行）：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r apps/worker-py/requirements.txt
```

如果本机没有 `python3.12`，可以先用 Homebrew 或 pyenv 安装 Python 3.12。

> 如果裸 `pnpm` 命令不可用，使用 `corepack pnpm`（或先 `corepack enable`）。

## 启动步骤

按以下顺序启动。建议除第 1、2 步外，**每步在新终端中运行**，便于观察日志。

### 1. 基础设施（PostgreSQL + Qdrant）

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres qdrant
```

可选：启动 Redis（仅用于后续实时事件通道，不承担核心任务状态）：

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile realtime up -d redis
```

默认端口：PostgreSQL `5432`、Qdrant HTTP `6333` / gRPC `6334`、Redis `6379`。

### 2. 数据库迁移

首次启动或拉取到新的 migration 后，**手动执行** Drizzle migration（这条命令不会随 `dev` 自动执行）：

```bash
corepack pnpm --dir apps/server db:migrate
```

> 后端启动时会通过 `DatabaseSchemaGuardService` 检查关键表是否存在；若缺失会报错并提示执行此命令。

### 3. 后端 API

```bash
pnpm --filter @local-media-agent/server dev
```

后端默认地址：`http://127.0.0.1:4000`。验证后端是否就绪：

```bash
curl http://127.0.0.1:4000/health
```

当 PostgreSQL 和 Qdrant 都可连接时返回：

```json
{
  "status": "ok",
  "dependencies": {
    "database": "ok",
    "qdrant": "ok"
  }
}
```

如果任一依赖不可用，接口返回 HTTP 503 并在 `dependencies` 中标出失败项。

### 4. 本地模型服务（搜索 query embedding）

```bash
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker.model_service
```

本地模型服务默认监听 `http://127.0.0.1:4020`，供后端在搜索时把 query 文本转成 SigLIP text vector。**它是本机 localhost 服务，不是外部模型 API。**

如果没有启动它：

- 仍可以创建 library、扫描文件和查看 jobs。
- `POST /search` 的**向量检索**会因无法生成 query embedding 而不可用（FTS 文本检索仍可用）。
- 批量媒体 embedding 仍可由 worker job 完成（与 model service 独立）。

### 5. Python Worker（后台媒体/模型任务）

```bash
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker
```

Python worker 从 PostgreSQL 的 `jobs` 表领取后台任务并执行，包括：

- `scan_library`：扫描素材库文件。
- `probe_media`：读取图片/音视频 metadata。
- `index_media`：生成 image、video segment、video frame assets，并创建待索引 vector refs。
- `embed_image` / `embed_video_frame`：调用本地 SigLIP，把图片或视频帧写入 Qdrant。
- `transcribe_audio`：用本地 faster-whisper 转写音频/视频讲话内容。
- `run_ocr`：用本地 PaddleOCR 识别图片或视频关键帧画面文字。
- `export_clip`：用 FFmpeg 导出视频片段。

如果没有启动 worker，前端和后端仍可打开，但创建 library 后不会真正完成扫描、索引、转写或 OCR。

### 6. 前端

```bash
pnpm --filter @local-media-agent/web dev
```

前端默认地址：`http://127.0.0.1:3000`。

> 前端导航栏右侧会显示后端连接状态（绿色 = 已连接，红色 = 未连接）。如果显示"未连接"，请确认后端 API 已启动。

### 快速启动清单

| 进程 | 命令 | 地址 |
| --- | --- | --- |
| PostgreSQL + Qdrant | `docker compose ... up -d postgres qdrant` | `:5432` / `:6333` |
| 数据库迁移 | `corepack pnpm --dir apps/server db:migrate` | — |
| 后端 API | `pnpm --filter @local-media-agent/server dev` | `http://127.0.0.1:4000` |
| 本地模型服务 | `.venv/bin/python -m media_agent_worker.model_service` | `http://127.0.0.1:4020` |
| Python worker | `.venv/bin/python -m media_agent_worker` | — |
| 前端 | `pnpm --filter @local-media-agent/web dev` | `http://127.0.0.1:3000` |

> Python 命令需带 `PYTHONPATH=apps/worker-py` 前缀，并在仓库根目录执行。

## 数据库可视化查看（DBeaver）

PostgreSQL 是项目的事实数据库，保存素材库、媒体文件、媒体资产、向量引用、任务队列和 Agent 运行记录。可以用 [DBeaver](https://dbeaver.io/)（免费开源的数据库 GUI）可视化查看和调试。

### 安装 DBeaver

从官网下载并安装 DBeaver Community Edition。macOS 也可用 Homebrew：

```bash
brew install --cask dbeaver-community
```

### 新建 PostgreSQL 连接

1. 打开 DBeaver，点击左上角 **新建连接**（或 `Cmd/Ctrl + Shift + N`）。
2. 选择数据库类型 **PostgreSQL**。
3. 在 **Main** 选项卡填入连接参数（与 `.env` 中保持一致）：

   | 参数 | 值 | 说明 |
   | --- | --- | --- |
   | Host | `127.0.0.1` | 本地容器 |
   | Port | `5432` | 对应 `.env` 的 `POSTGRES_PORT` |
   | Database | `media_agent` | 对应 `POSTGRES_DB` |
   | Username | `media_agent` | 对应 `POSTGRES_USER` |
   | Password | `media_agent_dev` | 对应 `POSTGRES_PASSWORD` |

4. 在 **SSL** 选项卡把 SSL Mode 设为 `Disable`（本地连接无需 SSL）。
5. 点击 **Test Connection**。首次连接 DBeaver 会提示下载 PostgreSQL JDBC 驱动，按提示下载即可。
6. 测试通过后点 **Finish** 完成创建。

> 连接参数以仓库根目录 `.env` 为准。如果修改过 `POSTGRES_*`，请在 DBeaver 中同步修改。

### 主要表说明

连接后展开 `media_agent` → `Schemas` → `public` → `Tables` 即可看到所有表。核心表如下：

| 表名 | 作用 | 关键字段 |
| --- | --- | --- |
| `libraries` | 素材库（一个本地根目录） | `name`、`root_path`、`status` |
| `media_files` | 扫描到的媒体文件 | `path`、`media_type`、`index_status`、`duration_seconds` |
| `media_assets` | 媒体资产（image / video_segment / video_frame / text_chunk） | `asset_type`、`text_content`、`start/end_time_seconds`、`metadata_json` |
| `vector_refs` | 向量引用，指向 Qdrant 中的 point | `collection_name`、`point_id`、`status`（pending/indexed）、`vector_dim` |
| `jobs` | 后台任务队列 | `job_type`、`status`、`progress`、`input_json`、`result_json`、`error_message` |
| `agent_runs` | Agent 运行记录 | `prompt`、`status`、`summary` |
| `agent_run_events` | Agent 事件流 | `event_type`、`tool_call_id`、`payload_json` |
| `agent_tool_calls` | Agent 工具调用记录 | `tool_name`、`status`、`requires_confirmation` |

### 常用查看 SQL

在 DBeaver 中打开 SQL 编辑器（`F3`），可执行以下查询快速查看运行状态：

```sql
-- 查看任务队列总体状态
SELECT job_type, status, count(*) AS cnt
FROM jobs
GROUP BY job_type, status
ORDER BY job_type, status;

-- 查看最近失败的任务
SELECT id, job_type, error_message, created_at
FROM jobs
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- 查看每个素材库的文件与资产数量
SELECT l.name,
       count(DISTINCT mf.id) AS files,
       count(DISTINCT ma.id) AS assets
FROM libraries l
LEFT JOIN media_files mf ON mf.library_id = l.id
LEFT JOIN media_assets ma ON ma.file_id = mf.id
GROUP BY l.name;

-- 查看向量索引进度
SELECT collection_name, status, count(*) AS cnt
FROM vector_refs
GROUP BY collection_name, status;

-- 全文检索调试：查看某 asset 的分词结果
SELECT id, asset_type,
       left(text_content, 80) AS preview,
       text_tsv
FROM media_assets
WHERE text_content IS NOT NULL
LIMIT 10;
```

> `media_assets.text_tsv` 是生成列（`to_tsvector('simple', ...)`），用 `'simple'` 配置按空白分词，中文召回弱于中文分词扩展；后续 Phase 可替换。

### Qdrant 可视化（可选）

Qdrant 自带 Web Dashboard，可直接在浏览器打开：

```
http://127.0.0.1:6333/dashboard
```

可在 Dashboard 查看 collection（`image_vectors`、`video_segment_vectors`、`video_frame_vectors` 等）、points 数量和 payload。事实数据仍需回 PostgreSQL 查看。

## 本地检索链路

默认配置下不对接外部 LLM 或外部多模态模型。本地检索依赖：

- **SigLIP**：本地视觉/text embedding，用于向量检索。
- **faster-whisper**：本地语音转写，用于 transcript FTS。
- **PaddleOCR**：本地 OCR，用于画面文字 FTS。

创建 library 并触发扫描后，可以通过 jobs 页面（或 DBeaver 查询 `jobs` 表）观察后台任务。必要时可手动补队列：

```bash
curl -X POST http://127.0.0.1:4000/jobs/embedding/queue-pending \
  -H 'Content-Type: application/json' \
  -d '{"limit": 100}'

curl -X POST http://127.0.0.1:4000/jobs/ocr/queue-pending \
  -H 'Content-Type: application/json' \
  -d '{"batch_size": 20, "limit": 100}'
```

等相关 jobs 成功后，`POST /search` 可以检索到：

- 图片/视频视觉相似结果：来自 Qdrant vector collections。
- 视频/音频中说过的话：来自 `text_search`，`reason` 为 `transcript_match`。
- 图片或视频关键帧中的画面文字：来自 `text_search`，`reason` 为 `ocr_match`。

Phase 14 后，`POST /search` 返回 top-level `results` 作为 hybrid retrieval + reranking 后的主结果，同时保留 `groups` 作为原始来源分组用于调试。

## 验证

验证整个 workspace：

```bash
pnpm check
```

只验证 server：

```bash
pnpm --filter @local-media-agent/server check
```

只验证前端：

```bash
pnpm --filter @local-media-agent/web check
```

验证 Docker Compose 配置：

```bash
docker compose --env-file .env -f infra/docker-compose.yml config
```

Python worker 单测（从仓库根目录）：

```bash
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

后续 Phase 会继续加入 hybrid reranking、外部多模态验证和更完整的端到端验证。

## 常见问题

- **后端 `/health` 返回 503**：确认 PostgreSQL 和 Qdrant 容器已启动（`docker compose ps`），端口与 `.env` 一致。
- **`POST /libraries` 返回 500**：通常是数据库未执行 migration。运行 `corepack pnpm --dir apps/server db:migrate` 后重试。
- **`/search` 向量检索不可用**：确认本地模型服务已启动（`http://127.0.0.1:4020`），它负责同步生成 query embedding。
- **创建 library 后无任务推进**：确认 Python worker 已启动；worker 通过 `FOR UPDATE SKIP LOCKED` 从 `jobs` 表领取任务。
- **首次运行很慢**：SigLIP / faster-whisper / PaddleOCR 首次需要从网络下载模型权重并缓存到本机，后续运行复用缓存。
- **macOS 内存紧张**：把 `.env` 中 `SIGLIP_DEVICE` 设为 `cpu`（默认 `auto` 在 Apple Silicon 上会选 `mps`）。
