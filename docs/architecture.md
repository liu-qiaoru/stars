# 本地多模态媒体 Agent 架构

## 目标

本项目是一个本地优先的 Web 系统，用于搜索、检查和剪辑个人媒体资产。目标素材规模约 1 TB，以视频为主，同时包含图片、音频和文本。

系统默认保留原始文件在用户自己的磁盘上，不上传、不复制源素材。应用只在本地工作目录中保存 metadata、索引、临时抽帧、转写文本、Caption 和导出剪辑。

## 推荐形态

使用可拆分式 monorepo：

```text
apps/web        Next.js 前端
apps/server     TypeScript / NestJS 主控 API
apps/worker-py  Python 媒体与模型 worker
packages/shared 共享类型、API schema 和工具函数
infra           本地基础设施定义
docs            架构、API 和实施文档
```

## 检索评测域

评测域是独立于普通搜索的本地维护工具。它把冻结查询、正式 SearchService 返回的候选快照、盲标判断、当前 hybrid 排名、正式 RRF 排名及指标持久化到 PostgreSQL。Phase 5 起普通搜索默认使用 RRF；`ranking_mode=current` 仍保留旧 hybrid 排序用于对照。Phase 6 的评测视频目标直接引用 `video_scenes.id`，候选同时冻结文件 generation，禁止依赖旧 `video_segment` 或 `metadata_json.scene_id`。

评测候选以图片 Asset 或正式视频场景为语义实体。visual、caption、lexical 是三个独立信号；视频帧的场景 MaxSim 折叠和 RRF 都由生产 SearchService 完成，评测层只保存结果和调用公共指标函数。运行所需来源、Point 回表或 generation 校验失败时整次运行失败，禁止生成部分指标。

仓库统一管理，但前端、TypeScript API server、Python worker 保持独立进程、独立依赖和清晰边界。这样既能让主要业务逻辑使用 TypeScript，也能保留 Python 在媒体处理和多模态模型上的生态优势。

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind。
- 主控 API：TypeScript、NestJS、默认 Express adapter、Zod。
- Agent 持久化执行：NestJS Server + PostgreSQL 租约状态机；Phase C 在 Phase B 单次文本
  意图分类和原文搜索之后，加入候选选择、确认守卫与幂等导出 Job。
- 数据访问：PostgreSQL、Drizzle、node-postgres。
- 向量数据库：Qdrant，使用 Qdrant JS client。Collection、point、payload 和 PostgreSQL 引用结构见 `docs/vector-index-design.md`。
- 后台任务：PostgreSQL-backed jobs。Redis 只作为可选实时事件/pub-sub 通道。
- Python worker：FFmpeg、ffprobe、PySceneDetect、SigLIP2、faster-whisper、Caption 文本嵌入模型，以及通过 Ollama 调用的 Qwen2.5-VL。
- Agent 编排：Server 固定状态迁移、租约隔离与逐步持久化。RightAPI `qwen3.7-plus`
  仍只执行一次 AgentIntent；Phase C 的候选、确认和 Job 创建全部由 Server 守卫，Python
  只安全执行已确认的导出，不负责 Agent 决策。
- 外部多模态模型层：通过 TypeScript Model Gateway 接入 OpenAI、Claude、Gemini 或其他提供商。
- 存储：本地文件系统，用于源素材引用、缓存文件、缩略图、抽帧、转写文本和导出剪辑。

## 高层架构

```text
Local Media Disk
  -> TypeScript Job Creator
  -> PostgreSQL jobs
  -> Python Scanner / Media / Model Worker
  -> PostgreSQL metadata
  -> Qdrant vector indexes
  -> TypeScript Retrieval Service
  -> TypeScript Agent Runtime
  -> NestJS API
  -> Next.js UI
```

可选事件通道：

```text
Python Worker / TypeScript Server
  -> Redis pub-sub
  -> NestJS SSE/WebSocket
  -> Next.js UI
```

## 核心模块

### Frontend

前端是本地 Web UI，用于素材库管理、搜索、任务进度、媒体检查、剪辑导出和 agent run。界面应该是信息密度适中的工具型产品，而不是营销落地页。

主要页面：

- Library：添加本地目录、触发扫描、展示已索引数量和错误数量。
- Search：跨图片、视频、音频和文本查询媒体。
- Jobs：展示扫描、索引、剪辑导出和 agent 任务进度。
- Media detail：展示 metadata、视频场景帧、transcripts 和剪辑操作。
- Agent panel：接收自然语言任务，展示工具调用、候选结果和最终结果。

### TypeScript API Server

NestJS 负责 HTTP API、模块组织、依赖注入、请求校验、OpenAPI 输出、数据库访问、Qdrant 查询、任务创建、agent 编排和结果读取。HTTP controller 不执行抽帧、embedding、转写、Caption、剪辑等重任务，只调用 service 创建 PostgreSQL job 并返回状态。

默认使用 NestJS 的 Express adapter。当前用户量级下，极致吞吐不是第一优先级；更重要的是把 Library、Jobs、Media、Search、Agent、Model Gateway 等能力放进清晰模块边界，降低后续功能膨胀时的维护成本。

初始模块划分：

```text
AppModule
  ConfigModule        读取和校验本地环境变量
  HealthModule        暴露 /health 并聚合依赖状态
  DatabaseModule      持有 PostgreSQL 连接、Drizzle schema 和 repository provider
  QdrantModule        持有 Qdrant client、collection registry 和健康检查
```

后续业务模块按 Phase 增量加入：

```text
LibrariesModule
JobsModule
MediaModule
SearchModule
  AgentModule        持有 Agent 租约、固定搜索步骤、Phase C 确认导出和恢复 API
  CandidateEvidenceModule  校验冻结候选、创建/恢复 Phase D 本地证据 Job 和受控文件读取
ModelGatewayModule
```

### packages/shared

`packages/shared` 存放前端和 TypeScript server 共享的类型与协议：

```text
schemas/      Zod request/response schemas 和 job input/output schemas
types/        TypeScript type definitions
constants/    media types、job types、collection names、event types
api-client/   typed API client
generated/    给 Python worker 使用的 JSON Schema
```

Python worker 不直接 import TypeScript 代码，而是读取 `generated/` 中的 JSON Schema 或由构建流程复制出的协议文件。

### Python Worker

Python worker 负责必须依赖 Python 生态或命令行媒体工具的重任务：

- 递归扫描本地素材库。
- ffprobe 媒体探测。
- FFmpeg 抽帧、缩略图、转码和剪辑导出。
- PySceneDetect scene boundary。
- SigLIP2 图片与视频帧 embedding。
- Whisper 转写。
- Qwen2.5-VL Caption 和 Caption 文本 embedding。

Python worker 从 PostgreSQL `jobs` 表 claim 任务，执行后写回 job 状态和结果。它不拥有 schema，也不直接对外暴露产品 API。TypeScript 侧负责 Drizzle schema 和 job protocol，Python 侧使用 raw SQL 或极薄 query helper 访问明确字段。

Qdrant 写入也由 Python worker 负责。TypeScript server 负责创建/删除 collection、读取 Qdrant 做搜索和管理 collection registry；Python worker 负责生成 mock 或真实 embedding、upsert Qdrant points，并写回 `vector_refs`。

### Scanner

Scanner 由 Python worker 执行。TypeScript API 只创建 `scan_library` job。Scanner 递归发现已注册本地素材库中的文件，记录文件路径、媒体类型、大小、mtime 和索引状态。初次扫描大素材库时应避免计算全文件 hash，因为对 1 TB 素材做完整 hash 成本较高。MVP 使用 `path + size + mtime` 判断变化，后续提供可选 content hash rescan。

### Indexer

Indexer 从文件创建 media assets：

- 图片文件创建 image assets。
- 视频文件创建 `video_scenes` 行和引用场景 UUID 的 `video_frame` assets。
- 音频或视频转写后创建 `text_chunk` assets。

自动化测试使用 mock embeddings 隔离模型下载；本地运行使用真实 SigLIP2 和 Caption 文本 embedding。

### Retrieval

Retrieval 组合 Qdrant 向量搜索、PostgreSQL full-text search 和 PostgreSQL metadata 过滤。Qdrant 只返回召回结果和轻量 payload，最终响应必须回 PostgreSQL 补齐事实数据。

`POST /search` 先依据 `search_scope=visual|spoken|all` 选择召回来源，再 overfetch 合法候选。视频视觉帧由 Qdrant 按正式 `scene_id` 做 MaxSim，场景分数取命中帧最大 cosine，边界从 PostgreSQL `video_scenes` 补齐。默认 `ranking_mode=rrf` 按 visual、caption、lexical 三个通道过滤后的名次融合，输出 `score_kind='rrf_score'`；`current` 保留旧 hybrid 排序用于对照。原始 `groups` 仍保留逐来源结果用于调试。

### Agent Runtime

Agent Runtime 位于 TypeScript/NestJS Server 主控层。Agent 是固定工作流编排器，
不是搜索引擎本身，也不是模型自主 Tool Calling 循环。

Phase C 当前已实现的完整闭环：

```text
POST /agent/runs
→ 短事务原子写入 agent_runs + 逐 run 授权 + run_queued 事件
→ HTTP 立即返回 run_id/status=queued
→ AgentExecutorService 使用条件 UPDATE 领取租约并递增 lease_version
→ 同一短事务创建唯一 step_attempt_id
→ 若为外部步骤，先持久化 dispatched + 输入指纹
→ 在事务外调用一次 qwen3.7-plus AgentIntent Runner
→ 提交严格校验后的意图和 Server 本地解析的素材范围
→ 用用户完整原文、original、rrf 在事务外调用一次 SearchService
→ 短事务用 lease_owner + lease_version + status + step_attempt_id 提交
→ 同一事务冻结 agent_run_candidates
→ 普通搜索进入 succeeded；明确导出意图进入 waiting_for_export_selection
→ Web 约每 2 秒读取持久化 run，隐藏时暂停、恢复可见时立即刷新
→ 用户选择冻结视频候选和场景内时间范围
→ Server 重新核对 generation、enforced scope、场景和文件边界并生成只读预览
→ 用户确认后，同一事务条件领取 requires_confirmation tool call
→ 同事务保存确认、创建或复用唯一 export_clip Job、更新 run/event
→ Python Worker 写唯一 .partial，安全原子发布最终文件
→ Web 分别展示 Agent run 和独立 Job 状态
```

Lease（租约）是 Server 执行器的限时工作证。`lease_version` 是 Fencing Token
（隔离旧持有者的令牌）：新执行器接管后版本递增，旧执行器的迟到结果只会
更新 0 行，必须丢弃。外部请求若已记为 `dispatched` 但未完成，当前执行器仍在运行时会在
活动硬超时点立即提交 `outcome_unknown`；若进程已经崩溃，则由租约过期恢复扫描提交同一状态。
两条路径都只能由 `/retry-unknown` 的新用户授权重试。
纯本地活动步骤受 `AGENT_ACTIVITY_TIMEOUT_MS` 硬上限约束，默认 120 秒；超时后
run、step 和审计事件在同一短事务内进入 `timed_out`。已经标记 `dispatched` 的外部请求
不按纯本地超时处理或自动重放，而是按上述两条路径进入 `outcome_unknown`。

PostgreSQL 中的恢复事实分工：

- `agent_runs`：用户可见状态、下一步、租约、等待到期和脱敏错误。
- `agent_run_steps`：每次步骤尝试、输入指纹、外部派发状态和规范化输出。
- `agent_run_inputs`：`resume`/`cancel`/`retry-unknown` 用户输入，由
  `(run_id, client_request_id)` 唯一约束保证幂等。
- `agent_run_authorizations`：每个 run 的文本/视觉外发授权，两者不能互相替代。
- `agent_run_candidates`：Phase B 搜索后冻结 `file_generation`、Asset/场景身份、边界、
  RRF 排名和召回证据。提交前重新核对文件版本及 Server 强制范围。
- `agent_side_effects`：每个 run 的 `export_clip_v1` 唯一副作用、确认预览和关联 Job。

Phase C 继续复用独立、可注入的 RightAPI `qwen3.7-plus` AgentIntent Runner。它使用
Anthropic Messages 兼容接口、非思考模式和唯一强制 `extract_agent_intent` Tool Call，
只接收本次用户原文与去标识化能力边界。模型不输出 query，也看不到候选、Caption、转录、
文件名或路径。HTTP/Tool Call/Zod Schema/原文连续子串/范围任一校验失败时 run 明确失败，
不会从自由文本猜 JSON 或自动修复。`ALLOW_EXTERNAL_LLM`、RightAPI 配置或执行器未就绪时，
创建接口仍在数据库写入前拒绝。Rerank 和 VLM 仍未接入。

`GET/PUT /agent/settings` 只暴露 Server allowlist 中的非敏感运行参数。Provider、固定模型、
Prompt/Schema 版本只读；`RIGHT_CODE_API_KEY` 只返回 configured 布尔值，Provider URL 和 Key
值不会返回浏览器。超时、租约、等待期限、启用开关、执行扫描间隔和 Web 轮询间隔都在
当前 Server 进程立即生效；进程重启后重新采用环境变量默认值。

### Agent V1 Phase D：独立候选证据

Phase D 在候选冻结之后增加一条完全本地的派生数据链，不改变候选排名，也不执行模型判断：

```text
用户在 Agent 或 Evaluation 页面明确点击“准备本地证据”
→ CandidateEvidenceModule 重新校验候选、文件 generation、场景和证据锚点 Asset
→ PostgreSQL 事务创建或复用 candidate_evidence 与 build_candidate_evidence Job
→ Python Worker 异步领取 Job，再次读取并校验当前 PostgreSQL 文件、场景和已索引帧事实
→ 按稳定时间顺序重新物化这些已有索引时间点，不新增时间点、不读取邻帧、不重新采样
→ 生成 contact_sheet_v1 拼图和 all_indexed_frames_v1 有序清单
→ 计算输入/产物 SHA-256，先写唯一 partial，再以不覆盖方式原子发布
→ 同一 PostgreSQL 事务提交 evidence 事实与 Job succeeded
→ Web 通过受控 artifact API 读取拼图，不接收本机绝对路径
```

`candidate_evidence` 是长期事实表，保存来源候选、generation、strategy（证据策略）、协议版本、
manifest（实际帧清单）、SHA-256 指纹、私有文件位置、状态和结构化错误。普通 Agent 证据记录约
24 小时缓存期限；正式 Evaluation 记录使用 `evaluation_frozen` 长期冻结。当前阶段只记录期限，
没有目录级自动清理，避免越界删除。Server 负责身份、幂等和 HTTP；Worker 负责耗时图像处理与
文件发布；PostgreSQL 负责重启恢复和审计；Qdrant 不读取也不写入。`queued → running →
succeeded|failed|cancelled` 均从数据库恢复，运行中取消先进入 `cancel_requested`。

Evaluation 的视频候选可能由 Caption 通道单独召回，此时冻结候选仍保留 Caption Asset，不能为了
证据构建改写检索快照。CandidateEvidenceModule 会先验证 Caption 与冻结 file/scene 一致，再按
`(frame_time_seconds, asset_id)` 选择同场景第一条非 stale 且已有 indexed
`video_frame_vectors` 引用的帧作为 Worker 身份锚点；联系表仍包含该场景全部已索引帧。Agent
候选不走这条转换，仍要求其冻结 Asset 本身就是视频帧。

`contact_sheet_v1` 使用 1600×900 RGB PNG、深灰背景、8 像素单格留白、保持宽高比的 contain
缩放和左下角 `T+HH:MM:SS.mmm` 时间戳。时间戳使用协议内置的 5×7 像素字形，渲染器固定为
Pillow 11.3.0；版本变化必须升级协议。1/2/3–4/5–6/7–9/10–12 帧分别使用
1×1、1×2、2×2、2×3、3×3、3×4 布局。`all_indexed_frames_v1` 保存全部 1～12 帧的稳定
顺序、Asset ID、秒数、标准化 PNG 指纹和受控标识。两种策略均使用
`candidate-evidence-v1`；协议参数变化必须升级版本，不能静默复用旧产物。

本阶段没有接入 Rerank（重排）或 VLM（Vision-Language Model，视觉语言模型）审核，没有任何
图片、Caption、转录、路径或文件名外发，也不产生通过/拒绝结论。

### Agent V1 Phase E：Evaluation 影子重排

Phase E 只在 Evaluation 中比较冻结的 RRF Top-20 和专用 `qwen3-vl-rerank`
返回的影子 Top-10。RRF（Reciprocal Rank Fusion，倒数排名融合）只利用各检索
通道名次合并结果；影子重排是只记录新排序但不改变用户结果的评测方式。

```text
用户在已 reported 的 Evaluation run 明确点击运行
→ Server 以 (evaluation_run_id, protocol_version) 创建或复用 shadow run
→ search_scope=visual 的查询创建唯一 attempt；spoken/all 持久化为 not_applicable
→ Server 读取同一查询完整 RRF Top-20；视频读 Phase D contact_sheet_v1，图片校验当前 generation/Asset 后缩放
→ 校验候选身份、generation、场景、证据 SHA-256 和连续名次
→ 在网络调用前先提交 external_call_status=dispatched
→ Provider 一次接收完整 Top-20，严格返回唯一索引的 Top-10
→ PostgreSQL 事务保存 20 条 RRF rank、10 条 shadow rank/score 及请求审计事实
→ Web 从 PostgreSQL 只读比较名次与指标，打开历史页不再调 Provider
```

Server 负责发起请求、严格 Schema 校验和状态恢复；PostgreSQL 保存 run、attempt、
ranking、Provider/request ID、请求/返回模型、区域、三类指纹、实际供应商 JSON 字节数、
token、毫秒、供应商账单费用、本地保守费用估算和结构化错误。官方响应只提供
`usage.total_tokens` 与 `request_id`，因此输入/输出 token 拆分、响应模型和账单费用必须
保存为 null，不能用零值或请求配置伪造。保守估算按全部 token 使用图片最高单价计算，
并与账单事实分列。Qdrant 和 Python Worker 不参与 Phase E；`/search`、
`evaluation_candidates.rrf_rank` 和 `agent_run_candidates.rank` 不写入。Provider 返回的
`relevance_score` 不是概率，只能在同一次 Top-20 请求中比较。为计算 nDCG@20
和 MRR，影子 Top-10 之后按原 RRF 顺序接上未入选候选，该口径仅用于报告。
图片在 Server 内存中用 Sharp（Node.js 图像缩放库）等比缩到 1600×1600 边界内并固定
PNG 编码，不产生临时文件。报告同时展示技术成功样本的宏平均，以及把失败
查询按原 RRF 回退计算的完整产品样本宏平均，避免通过删除失败样本夸大改善。

Provider 成功正文只对项目依赖的 `output.results[].index/relevance_score`、`request_id`
做强类型提取；供应商新增且项目不使用的字段会被丢弃，不再因为外层扩展导致整包失败。
核心 index/score 仍由 Shared Top-10 Schema 拒绝缺失、重复、越界、非有限值和顺序矛盾。
`usage.total_tokens` 缺失或类型漂移时排名仍可原子保存，但 Provider token 保持 null、预算门
停止后续外发。若维护者随后从阿里云模型监控核对到同一 Request ID 的文本/图片/总 Token，
则写入独立的 `evaluation_shadow_usage_reconciliations` 一对一事实；它不会冒充 Provider
响应字段，只用分项标准价恢复预算判断，并在 Web 中明确标为“人工核对”。
同一冻结 Evaluation 的再次 smoke 使用递增 `execution_number` 创建全新的 shadow run 和
attempt；旧 attempt 永不重开或覆盖。新 attempt 派发前还必须匹配上一执行的 query/evidence
指纹，从而既复用同一 Top-20，又完整保留第一次调用的 request ID、错误和费用审计。
报告读取在主区域展示最新 execution，并携带全部 `execution_history`；Web 的“历史执行审计”
持续显示旧 request ID、状态和人工核对 Token，不会因后续成功而隐藏第一次失败事实。

幂等由唯一运行身份、每查询唯一 attempt 和条件更新共同保证。未 dispatched 的
pending attempt 可在 Server 重启后继续；已 dispatched 但没有确认结果的 attempt
只能转为 `outcome_unknown`，禁止自动重放以避免重复费用。阿里云北京专属适配器由
`SHADOW_RERANK_PROVIDER=dashscope` 显式选择，并要求同地域的
`DASHSCOPE_WORKSPACE_ID` 与 `DASHSCOPE_API_KEY`；默认仍为 `disabled`，仅配置凭证不会
启用。适配器只外发查询文本和 20 张 Data URI PNG，不外发候选 Key、指纹、路径、Caption
或转录。明确 HTTP 错误/畸形响应记为 `completed/failed`；只有无明确响应的网络失败才记为
`outcome_unknown`。首次 smoke 默认最多 1 次；以后即使另行授权也最多 4 次、累计预算不超过
¥0.5。每次派发通过 PostgreSQL 表锁，跨所有 Evaluation run 对同一 Phase E 协议执行原子次数/预算检查，并按单请求理论最高 ¥0.216 预留；新建 run 不能重置额度。只因策略门被拦截且从未外发的 attempt 可在后续明确扩大授权后恢复，已外发或结果未知的请求绝不重放；
任一已外发 attempt 缺用量时停止，汇总计量保持 null。用户重新授权前不会外发查询或图像，
也不执行 Phase F VLM 审核。

### Phase F 候选审核与 VLM 协议准备

Phase F 在真实 VLM 之前增加独立的人工候选审核门。本地抽样器只从一次完整
Evaluation 快照读取查询、条件、候选 UUID、场景时间与索引帧数，确定性生成
5 组各 12 对的建议包。候选审核发现查询语义陈旧时，系统会先建立一份新的冻结
Evaluation，再只用该 run 中的新查询替换待审核案例；不能把旧查询去重或改写同义词后
冒充新查询。当前批次保留 30 个已审核案例，并用 30 条全新查询分别替换 30 个 pending
案例；后续拒绝文本淘汰与配额再平衡继续保持至少 50 条唯一查询、每条查询最多出现两次。
分组依据仍只是名次、时长与帧数的抽样启发，不是人工真值。候选审核进行中需要调整
多样性时，只允许替换 `pending` 案例，已接受或拒绝的人工事实保持只读。新旧查询文本
重合、新 run 查询数不足或无法让每个 pending 案例使用不同新查询时必须整体失败。

用户完成一轮审核后，被拒案例不会被改回 `pending` 或覆盖候选身份。人工 `rejected` 表示
查询文本不适合进入盲测：该文本成为数据集级永久排除事实，所有仍使用它的 active 叶子都要
退出，而不只是用户点击拒绝的那一个视频。Server 为每个退出叶子追加新案例行，并用
`replaces_case_id` 指向前代；因此旧 rejected、accepted 或 pending 行都保留为历史审计。
替代只能来自数据集已有冻结 Evaluation runs 中未拒绝、未使用的查询—候选，同时维持每查询
最多两对和至少 50 个唯一查询；任何一条找不到合法替代都会使整个事务回滚。
若旧 runs 的未拒绝查询不足，系统不能静默降低多样性门槛。维护者先把用户提供的新原文建立为
独立冻结 Evaluation，并完成本地召回；替代请求再显式传入该 run UUID。Service 会验证 run 已
完整到达 `ready_for_labeling | labeled | reported`，随后只扩展冻结候选读取范围，不自动扫描其他
Evaluation，也不在替代事务中触发 Search 或 Provider。

候选全部接受后，人工改组可能使五组不再各有 12 条。配额再平衡在锁定 dataset 与案例行后，
把超额组中的 accepted 叶子作为只读父记录，从父记录同一冻结 run、同一 query 的未使用候选中
寻找能补足缺额组的后继。匹配必须一次覆盖全部缺额，否则不写任何行；成功后页面同时显示
当前 pending/accepted 与历史 accepted/rejected，避免把保留的人工审核误认为被覆盖。该过程只读
PostgreSQL 冻结候选，不调用 Search、Provider 或 Qdrant；若 active 叶子仍使用历史拒绝文本，
必须先完成查询丢弃替代，不能通过配额再平衡把它带回盲测池。

PostgreSQL 将数据拆成 `evaluation_vlm_blind_datasets`、`evaluation_vlm_blind_cases` 和
`evaluation_vlm_blind_conditions`：批次表保存数量与指纹，案例表保存查询—候选快照以及
用户的接受/拒绝/改组，条件表预留一审、二审和最终 `yes/no/uncertain`。仅当
60 对全部通过候选审核后，后续步骤才能使用现有 `build_candidate_evidence` Job 构建
`all_indexed_frames_v1`；被拒绝的建议不抽帧。
建议包指纹在 PostgreSQL 中具有唯一索引；并发导入由数据库选择唯一胜者，其他请求读取
同一批次，因此双击或多个 Server 不会生成两套 60 对数据。

候选审核的最后一步是冻结，而不是直接调用模型。Server 在一个 PostgreSQL 事务中重新锁定
批次与全部案例，按后继关系找出 60 个有效叶子，再核对全部 accepted、五组各 12、候选唯一、
查询多样性、历史拒绝文本排除和条件完整性。只有全部成立才把规范化快照计算为 SHA-256
指纹并写入 `status=frozen`；任何一项不成立都整体回滚并返回冲突错误。重复冻结返回同一指纹，
冻结后的审核与替代入口保持关闭。该状态只说明人工候选池已经不可变，不代表已经构建证据或
执行 VLM；真实模型运行仍需后续独立授权与实现。

VLM 协议的 TypeScript/Zod Schema 固定 `qwen3.7-plus`、用户完整原文、Server 分配的
条件 ID 和 1～12 张独立索引帧。Server 严格对照候选、条件和帧 ID，然后用固定规则
派生状态。当前只有可注入 fake Provider 与测试，没有真实 HTTP Provider 适配器或运行
入口，因此打开页面、导入批次和审核候选都不会外发图片。

候选冻结后的人工条件盲标使用独立 `evaluation_vlm_blind_labeling_sessions`，候选 dataset 继续
保持 `frozen`。Web 明确请求证据准备后，NestJS Server 逐条复用冻结 Evaluation candidate 身份，
由现有 CandidateEvidenceService 创建 `build_candidate_evidence`；Python Worker 异步读取当前
场景的 1～12 张已索引帧并发布 `all_indexed_frames_v1`。这条链路只重新物化既有帧时间点，不
调用 Search、不访问外部 Provider、不写 Qdrant。

证据全部成功后，Server 才开放 `first → second → final` 人工阶段。复核开始后锁定一审；final
只处理两轮不一致或含 `uncertain` 的条件。两轮一致的 `yes/no` 与人工 final 共同形成 resolved
verdict，冻结时写入独立标签指纹，候选指纹不变。会话行同时承担保存与冻结的事务锁，避免并发
保存落在标签指纹之后。

标签冻结后可运行一次 `evaluation_vlm_blind_fake_runs` 本地协议演练。Server 校验 bundle manifest、
每帧 SHA-256 和相对路径边界，再只在内存组装 Base64；当前依赖图唯一注册
`FakeVlmReviewProvider`，它没有 URL、凭证或 HTTP 客户端，真实调用恒为 0。持久化结果不含图片、
路径、Caption 或转录。该演练只验证请求/输出 Schema、固定状态派生、失败记录和指标报告，不能
作为真实 `qwen3.7-plus` 能力结论，也不进入 Phase G。

NestJS AgentModule 组织：

```text
apps/server/src/agent/
  agent.controller.ts          run、恢复、取消和能力 HTTP API
  agent.service.ts             输入校验、capabilities 和用例边界
  agent-runtime-config.service.ts  设置 allowlist、脱敏响应与跨字段校验
  agent-run.repository.ts      短事务、租约、幂等输入和恢复状态机
  agent-executor.service.ts    定时领取、过期恢复与事务外步骤执行
  qwen-agent-intent.runner.ts  唯一强制 Tool Call 和严格 AgentIntent 校验
  agent-v1-step.handler.ts     一次意图识别、一次原文搜索和候选快照
  agent.types.ts               可注入的步骤 handler 协议
```

### Model Gateway

Model Gateway 位于 TypeScript 主控层，用统一接口封装本地 Python worker 能力和外部多模态模型。外部多模态模型只检查小规模候选集，例如 top search results 或选中的 keyframes。它们不应接收完整媒体库。

在线搜索需要低延迟 query embedding。真实 embedding 阶段默认增加本地 Python model service，只监听 localhost，负责加载模型并提供 `/embed/text`、`/embed/image` 等轻量 RPC。批量索引仍通过 PostgreSQL jobs 进入 Python worker。

Python worker 和 Python model service 是两个独立进程，但共享同一套推理代码。`python -m media_agent_worker.model_service` 默认监听 `127.0.0.1:4020`，TypeScript `ModelGatewayService` 通过 `MODEL_SERVICE_URL` 同步调用 `/embed/text` 获取查询向量。为避免 MPS/内存压力，在线查询 embedding 由 model service 常驻模型处理；worker 进程内的 image/video embedding handlers 共享一个 SigLIP2 embedder，避免同一 worker 重复加载模型。Apple Silicon 上可用 `SIGLIP_DEVICE=mps`，资源紧张时用 `SIGLIP_DEVICE=cpu`，CUDA 机器可用 `SIGLIP_DEVICE=cuda`。

### Clip Export

Clip Export 由 TypeScript API 创建 job，Python worker 使用 FFmpeg 直接处理原始本地视频文件。
Agent 确认以 `agent_side_effects.id` 作为 `export_request_id`，所以重复确认只关联一个 Job 和一个
输出目标。Worker 先用 FFmpeg `-n` 写唯一 `.partial`，成功后在同一文件系统原子发布；目标已存在
或任一步失败时 Job 明确失败并清理临时文件，绝不使用 `-y` 覆盖。

## 数据归属

原始媒体保留在用户自己的目录中。应用保存：

```text
.media-agent/
  cache/
    thumbs/
    frames/
    transcripts/
    scenes/
  evidence/
    <evidence-id>.png
    <evidence-id>.bundle/
  exports/
    clips/
    montages/
  logs/
```

PostgreSQL 保存事实数据和任务状态。Redis 不再作为核心任务队列，因为 PostgreSQL-backed jobs 已经承担跨语言任务事实状态；Redis 只作为可选实时事件通道，不作为长期业务状态存储。Qdrant 保存向量和轻量 payload，payload 引用 PostgreSQL asset IDs。Qdrant 不是媒体 metadata 的事实来源。向量结构必须显式定义，避免后续索引重建、模型升级、删除同步和 payload filter 难以维护。

## 关键决策

### TypeScript 主控，Python 辅助

主语言使用 TypeScript，因为前端、API contract、业务状态、检索接口和 agent orchestration 都可以共享类型与工具链。Python 只负责媒体处理和模型推理，避免让不熟 Python 的维护者承担主业务逻辑。

### NestJS

NestJS 用作本地 API server。此前 Phase 2 已用 Fastify 建立基础服务，但用户明确希望切换为 NestJS，以获得严格模块化、依赖注入、Controller/Service/Module 边界和更稳定的长期组织方式。

为什么使用 NestJS：

- 后续模块数量多，包含 libraries、jobs、media、search、agent、model gateway、database、qdrant 等边界；NestJS 的模块系统能把这些依赖关系显式化。
- 依赖注入适合封装 PostgreSQL、Qdrant、job repository、agent tools 和 model gateway，便于测试时替换 provider。
- 当前本地工具的用户量级较小，极致性能不是最初目标；可维护性和边界清晰优先。
- 默认 Express adapter 足够满足 MVP。除非后续压测证明 HTTP 层成为瓶颈，否则不引入 Fastify adapter。

不用于：

- 不在 controller 中执行媒体重任务。
- 不让 NestJS 直接承担 Python worker 的长任务执行职责。
- 不把所有能力塞进单个 `AppModule`；每个业务域必须独立 module。

### PostgreSQL-backed jobs

跨 TypeScript 和 Python 的任务队列不绑定 Dramatiq 或 Celery。TypeScript API 将任务写入 PostgreSQL `jobs` 表，Python worker 使用 `SELECT ... FOR UPDATE SKIP LOCKED` claim 任务并更新状态。这样任务事实状态天然可查询，后续如需更复杂队列再迁移。

任务协议见 `docs/job-protocol.md`。TypeScript 维护 Zod schema 和 Drizzle schema，Python worker 不维护独立 ORM 模型。

### PostgreSQL 和 Qdrant

PostgreSQL 用于 metadata、jobs、事实数据和关系查询。Qdrant 用于向量，因为当前素材库已接近 1 TB，最终向量规模不确定。当前在线 Qdrant collection 按用途拆分为 `image_vectors`、`video_frame_vectors` 和 `caption_text_vectors`；转录文本仍由 PostgreSQL 全文检索承载。

### FFmpeg 和 PySceneDetect

FFmpeg 是媒体引擎，负责 probe、抽帧、转换和剪辑。PySceneDetect 是 scene boundary 决策工具。OpenCV 和 PyAV 可在后续用于高级帧处理或更精细的解码控制，但不是第一版媒体管线。

### 外部多模态模型

允许通过 Model Gateway 接入外部多模态模型。它们用于候选验证、结果解释、reranking 和 clip summary，不用于全库索引。

## MVP 边界

第一版应产生一个可运行的本地 Web 闭环：

1. 添加本地素材库路径。
2. 扫描文件并写入 PostgreSQL。
3. 创建索引任务。
4. Python worker 写入 media assets 和 placeholder vectors。
5. 从前端搜索。
6. 查看媒体详情。
7. 导出视频 clip。
8. 运行一个调用 search 并总结候选结果的 agent 任务。

MVP 不需要达到完整视频理解质量。它必须先建立系统边界，并证明从本地磁盘到前端结果的完整路径可行。
