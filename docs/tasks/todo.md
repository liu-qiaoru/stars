# 项目任务清单

本文件用于跟踪实施工作。在真正开始实施前，它只作为规划文档。

## 执行规则

- 实施必须遵守 `docs/implementation-rules.md`。
- 每个 Phase 完成后必须等待用户确认，再进入下一个 Phase。
- 每个 Phase 的 `Review` 区域必须记录结果、验证和后续衔接点。

## 当前进度

- 当前阶段：Phase 2A 已完成，等待用户确认是否进入 Phase 3。
- 最近更新：2026-05-29 14:12 CST，完成 Phase 2 代码从 Fastify 到 NestJS 默认 Express adapter 的迁移。
- 下一步：用户确认后开始 Phase 3。

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

- [ ] 添加 libraries、media files、media assets、vector refs、jobs 和 agent runs 的 Drizzle schema。
- [ ] 添加 Drizzle migration。
- [ ] 添加 repository helpers。
- [ ] 添加 model relationship tests。
- [ ] 在 `packages/shared` 添加 job input/output Zod schemas。
- [ ] 生成 Python worker 可读取的 JSON Schema。
- [ ] 添加 schema consistency check。

Review：

- Result：
- Notes：

## Phase 4：Library 扫描与 Job 创建

- [ ] 添加 library create、list、detail 和 disable/delete APIs。
- [ ] 添加 scan job API。
- [ ] 添加 PostgreSQL-backed job claim 机制。
- [ ] 定义 Python worker 启动命令、heartbeat、超时回收和 graceful shutdown。
- [ ] 添加 Python worker scan handler。
- [ ] 添加按扩展名识别 media type。
- [ ] 添加幂等扫描行为。

Review：

- Result：
- Notes：

## Phase 5：媒体探测与索引骨架

- [ ] 添加 Python worker ffprobe 视频和音频探测。
- [ ] 添加 Python worker 图片尺寸探测。
- [ ] 添加 media asset 生成。
- [ ] 添加固定 30 秒视频 segments。
- [ ] 按 `docs/vector-index-design.md` 在 TypeScript server 中添加 collection registry。
- [ ] 添加 Qdrant collection 初始化。
- [ ] 添加 deterministic mock vectors。
- [ ] 添加 `vector_refs` 与 Qdrant point id 的幂等关联。
- [ ] 统一由 Python worker 写入 Qdrant points，TypeScript server 只管理 collection 和搜索读取。

Review：

- Result：
- Notes：

## Phase 6：Qdrant Retrieval

- [ ] 添加 `POST /search`。
- [ ] 使用 Qdrant JS client 搜索 image 和 video segment collections。
- [ ] 应用 media type 和 library filters。
- [ ] 查询 Qdrant 后回 PostgreSQL 补齐完整 metadata。
- [ ] 按 collection 分组返回搜索结果。
- [ ] 添加 `limit` 和 `offset` 分页参数。
- [ ] 返回 file path、score、media type 和 time range。
- [ ] 添加空结果处理。

Review：

- Result：
- Notes：

## Phase 7：Next.js 前端

- [ ] 创建 Next.js app。
- [ ] 添加 Tailwind。
- [ ] 添加 app shell navigation。
- [ ] 添加 Library page。
- [ ] 添加 Search page。
- [ ] 添加 Jobs page。
- [ ] 添加 Media Detail page。
- [ ] 添加 Agent page。
- [ ] 添加 typed API client。
- [ ] 参考 `DESIGN.md` 的视觉语言，并将其工具化适配到媒体管理和检索界面。

Review：

- Result：
- Notes：

## Phase 8：Clip Export

- [ ] 添加 `POST /clips/export`。
- [ ] TypeScript API 创建 `export_clip` job。
- [ ] Python worker 使用 FFmpeg 导出 clip。
- [ ] 将 clips 保存到 `.media-agent/exports/clips`。
- [ ] 添加 export job result。
- [ ] 添加 Media Detail export action。

Review：

- Result：
- Notes：

## Phase 9：Agent MVP

- [ ] 添加 TypeScript lightweight tool router。
- [ ] MVP 使用规则路由，不依赖 LLM function calling。
- [ ] 明确规则路由关键词、fallback 到 search、空 query 错误提示。
- [ ] 添加 `search_media` tool。
- [ ] 添加 `get_media_detail` tool。
- [ ] 添加 `create_index_job` tool。
- [ ] 添加 `export_clip` tool。
- [ ] 添加 `POST /agent/runs`。
- [ ] 添加 `GET /agent/runs/{id}`。
- [ ] 定义 agent run events 结构。
- [ ] 将 agent run state、events 和 tool calls 持久化到 PostgreSQL。
- [ ] 在前端展示 agent status 和 tool-call summary。

Review：

- Result：
- Notes：

## Phase 10：真实视觉 Embedding

- [ ] TypeScript Model Gateway 添加 embedding job 接口。
- [ ] 添加本地 Python model service，用于搜索时同步生成 query embedding。
- [ ] 明确 Python worker 与 model service 的进程模式、启动时机和 MPS 内存策略。
- [ ] Python worker 接入 OpenCLIP 或 SigLIP。
- [ ] index_media 完成后创建下游 embedding jobs。
- [ ] 为图片生成 image vectors。
- [ ] 为视频关键帧生成 frame vectors。
- [ ] 记录 model name、version 和 vector dim。
- [ ] 支持 CPU、MPS 和 CUDA 设备选择。

Review：

- Result：
- Notes：

## Phase 11：视频 Scene Segmentation

- [ ] Python worker 添加 PySceneDetect scene detection。
- [ ] 在 job protocol 中实现 `scene_detection` job。
- [ ] 保存 scene start/end。
- [ ] 为每个 scene 选择 1 到 3 个关键帧。
- [ ] 合并过短 scenes。
- [ ] 保留固定时间切片 fallback。

Review：

- Result：
- Notes：

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
