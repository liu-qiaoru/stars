# 本地多模态媒体 Agent

这是一个本地优先的媒体检索与剪辑 Agent，用于管理个人图片、视频、音频和文本素材库。

项目实现遵循 `docs/architecture.md` 的架构设计，并按 `docs/tasks/todo.md` 中的 Phase 分阶段推进。当前阶段已经建立 monorepo 基础设施，并将 TypeScript API 基础服务迁移到 NestJS。

## 仓库结构

```text
apps/web          Next.js 前端，Phase 7 开始实现
apps/server       TypeScript / NestJS 主控 API，从 Phase 2 开始实现
apps/worker-py    Python 媒体与模型 worker，从 Phase 4 开始实现
packages/shared   共享 schemas、types、constants、API client 和生成给 Python 的 JSON Schema
infra             本地基础设施定义
docs              架构、API、任务协议、向量索引和实施记录
```

## 环境要求

- Node.js 22 或更新版本
- pnpm 10 或更新版本
- OrbStack、Docker Desktop，或其他兼容 Docker Compose 的本地容器运行时

Python worker 的依赖会在后续 Phase 添加。

## 初始化

```bash
nvm use
cp .env.example .env
pnpm install
```

启动 PostgreSQL 和 Qdrant：

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres qdrant
```

Redis 只用于后续可选的实时事件通道，不承担核心任务状态：

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile realtime up -d redis
```

## 启动服务

Phase 2A 已提供 NestJS 基础健康检查能力：

```bash
pnpm --filter @local-media-agent/server dev
```

默认地址来自 `.env`：

```text
http://127.0.0.1:4000
```

健康检查：

```bash
curl http://127.0.0.1:4000/health
```

当 PostgreSQL 和 Qdrant 都可连接时，返回：

```json
{
  "status": "ok",
  "dependencies": {
    "database": "ok",
    "qdrant": "ok"
  }
}
```

如果任一依赖不可用，接口会返回 HTTP 503，并在 `dependencies` 中标出失败项。

## 验证

验证整个 workspace：

```bash
pnpm check
```

只验证 server：

```bash
pnpm --filter @local-media-agent/server check
```

验证 Docker Compose 配置：

```bash
docker compose --env-file .env -f infra/docker-compose.yml config
```

后续 Phase 会继续加入数据库迁移、API contract、Python worker、前端界面和端到端验证。
