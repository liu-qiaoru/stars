# 项目任务清单

本文件用于跟踪实施工作。在真正开始实施前，它只作为规划文档。

## 执行规则

- 实施必须遵守 `docs/implementation-rules.md`。
- 每个 Phase 完成后必须等待用户确认，再进入下一个 Phase。
- 每个 Phase 的 `Review` 区域必须记录结果、验证和后续衔接点。

## 当前进度

- Agent 接入后续实施以
  `docs/superpowers/plans/2026-08-05-agent-integration-plan.md` 为单一执行方案；顺序为协议冻结
  → Agent 协议、数据库与逐步持久化 Loop → RightAPI `qwen3.7-plus` AgentIntent Runner
  → Web 与安全导出闭环 → 帧证据构建器
  → `qwen3-vl-rerank` 影子模式
  → 报告指标 → Top-3 VLM 未见盲测 → 显式小流量接入。
- 2026-08-12 决策：AgentIntent 与 Top-3 VLM 条件复核都使用 RightAPI `qwen3.7-plus`，
  但保持独立 Runner、Tool Schema 和文本/视觉授权；Agent V1 不接入 DeepSeek。单条 AgentIntent
  强制 Tool Call smoke 已返回 HTTP 200 且结构正确，正式质量仍以歧义与安全默认盲测为准。
- 当前 Agent 阶段：从冻结方案 Phase A 开始，只实施 Agent 协议、数据库、租约、恢复状态机和
  Phase A API；Phase A 验收并经用户确认后，才能进入 Phase B 的真实 Provider 接入。
- 当前阶段：视频检索重建 Phase 9A-C2 已完成；两个 Qwen 云模型均未达到生产多帧复核
  要求，Phase 9B～9D 继续跳过。
- 最近更新：2026-08-02，30 条新盲测中 Qwen3-VL-Plus 多数票答对 16 条，Flash 答对
  15 条；两者对 7 条人工 1 级样本均为 0 条正确。180/180 次调用成功，估算费用
  0.43290105 元，低于 2 元授权上限。
- 下一步：生产检索保持 Phase 8。若继续研究，先设计显式必须条件/排除条件的复核协议，
  再用另一批未见样本验证，不能在本轮 30 条上调 Prompt 后直接宣布通过。

## Agent V1 Phase A：协议、数据库、租约与恢复状态机

- Start：2026-08-12。目标是只交付 Agent V1 的持久化执行基础：由 NestJS Server
  使用 PostgreSQL 租约逐步推进 run，并提供 Phase A 的恢复、取消和能力查询 API。
- 范围边界：不调用 RightAPI、`qwen3.7-plus`、DeepSeek 或其他外部模型；不进入
  Phase B 的 AgentIntent 识别和真实检索；不实施 Phase C 的 Web 轮询与安全导出闭环。
- 验证计划：先增加协议、迁移、状态迁移、并发领取、过期接管、迟到写入拒绝、
  等待到期、恢复、取消和 API 的失败测试；实现后运行 Server 全量检查、迁移空库验证、
  仓库级检查和 `git diff --check`，最后完成双轴 Review。

- [x] 定义 AgentIntent、run 状态、等待输入、取消、授权和错误 Schema。
- [x] 扩展 `agent_runs`，并新增规范化步骤、用户输入、授权和副作用幂等数据。
- [x] 实现带 `lease_version` 隔离令牌的条件领取、过期接管和迟到结果拒绝。
- [x] 实现固定状态迁移、等待到期、活动超时、崩溃恢复与 `outcome_unknown` 显式重试边界。
- [x] 实现 `GET /agent/capabilities`、`POST /resume`、`POST /cancel` 和
      `POST /retry-unknown`。
- [x] 同步 Agent 架构、API 契约和数据库迁移说明。
- [x] 运行 Phase A 测试、空库迁移验证、完整检查与双轴 Review。

Review：

- Result：Phase A 已完成并停止在 Provider 接入前。Server 现在使用 PostgreSQL 短事务、
  `lease_version` 和 `step_attempt_id` 推进规范化 run；外部请求已派发但结果未知时进入
  `outcome_unknown`，只有独立幂等入口可授权重试。默认 handler 明确未就绪，因此创建接口
  在写数据库前返回 503，实际外部模型调用为 0。
- Notes：增量迁移 `0001_agent_v1_phase_a.sql` 保留 `0000` 基线，空库顺序应用后由 15 张表
  增至 20 张；不修改 Qdrant，不需回填媒体、重新索引或重新评测。`corepack pnpm check`
  通过 Shared 10、Web 47、Server 152 项测试及 Web 生产构建；`.venv` 中 Python Worker
  122 项测试通过，`cloud_calls=0`。双轴复审剩余 Standards 硬违规 0、Spec 缺口 0；仅保留
  一个非阻断的 Data Clumps 判断项，建议 Phase B 再把重复租约写权字段收拢为领域类型。

## Agent V1 Phase B：qwen3.7-plus 单次意图识别与一次原文搜索

- Start：2026-08-12。只实现一个固定的两步 Server 工作流：先用 RightAPI
  `qwen3.7-plus` 非思考模式识别一次 AgentIntent，再用用户完整原文调用一次本地
  SearchService。它不是模型自主 Tool Calling 循环。
- 范围边界：不实施 Phase C 的 Web 轮询、候选选择、导出确认；不实施 Rerank、VLM、
  DeepSeek 查询扩展、媒体扫描、重新索引或重新评测。正式 RightAPI 调用仍需另行列出
  精确外发数据、次数和最坏费用并等待用户授权。

- [x] 新增独立、可注入的 Qwen AgentIntent Runner，固定 `qwen3.7-plus`、非思考模式和
      唯一强制 `extract_agent_intent` Tool Call。
- [x] 严格校验 HTTP/响应模型/`stop_reason`/唯一工具名/Zod Schema/长度/原文连续子串，
      只允许 NFC、CRLF→LF 和 `source_text` 两端空白归一化。
- [x] 由 Server 本地解析素材库 UUID 并限制媒体/素材库范围；不存在、重名或越权时明确失败。
- [x] 固定使用完整原文、`query_expansion_mode=original` 和 `ranking_mode=rrf` 搜索一次，
      并在同一短事务中冻结候选身份、文件 generation、场景边界、排名和召回证据。
- [x] Provider 调用前持久化 `dispatched`、输入指纹和 `step_attempt_id`；不明结果进入
      `outcome_unknown`，只有显式 `/retry-unknown` 才生成新尝试。
- [x] 同步架构、API、环境变量和真实数据库迁移审计，并完成定向/全量验证与双轴 Review。

Review：

- Result：Phase B 已完成并停在 Phase C 前。普通 run 只执行一次 AgentIntent 与一次原文
  搜索；非法模型输出、范围扩大和候选身份变化均明确失败。重启只从 PostgreSQL 最后提交
  状态继续，旧 `lease_version` 无法提交迟到结果或候选。
- Migration：真实 PostgreSQL 先备份，再原地登记与现有 Schema 等价的 `0000`，最后只执行
  `0001`。迁移前后 35 个已索引文件、7,940 个 Asset、1,919 个场景、7,564 个已索引
  Vector Ref 和 9,910 个 Job 均未减少；Qdrant 三个 Collection 合计 7,564 个 Point 未变化。
- Validation：`corepack pnpm check` 通过 Shared 10、Web 47、Server 186 项测试及 Web
  生产构建；Python Worker 122 项测试、lint 和 `git diff --check` 通过。双轴 Review 结果见
  本阶段最终复审记录。真实 RightAPI 调用、费用和数据外发均为 0；所有 Provider 测试使用
  可注入测试桩。

## Agent V1 Phase C：配置页面、Web 生命周期与安全导出闭环

- Start：2026-08-12。目标是把 Phase B 的冻结候选接成可初步使用的完整闭环：Web 轮询
  持久化 run，用户选择视频场景和时间范围，Server 在单一 PostgreSQL 事务中幂等创建
  `export_clip` Job，Python Worker 以唯一临时文件安全导出，Web 独立展示 run 与 Job 状态。
- 范围边界：不进入 Rerank、VLM、证据构建、查询改写、重新扫描、重新索引或重新评测；
  所有自动化 Provider 测试继续使用 fake，真实 RightAPI 调用次数必须为 0。
- 验证计划：按 HTTP API、Web 可见行为和 Worker Job handler 三个公共测试缝隙逐条红绿实现；
  最后运行 Shared/Server/Web/Python 定向和全量检查、lint、format check、迁移与数据完整性核对，
  再以 `8a615b0` 为固定起点完成 Standards/Spec 双轴 Review 和复审。

- [x] 增加 allowlist 运行配置读取、保存、严格校验、协议只读字段和 API Key 脱敏。
- [x] 使用 shadcn/ui 更新 `/agent`、新增 `/settings`、AppShell 导航和导出/任务状态区域。
- [x] 实现约 2 秒轮询、隐藏暂停、恢复立即刷新、终态停止和卸载清理。
- [x] 展示 intent、Server enforced scope、候选证据、未验证条件和 `review_status=not_run`。
- [x] 实现冻结候选选择、时间范围预览和 stale generation/scope/场景边界复核。
- [x] 在单一 PostgreSQL 事务中实现确认条件守卫、唯一副作用、Job 创建/复用和事件更新。
- [x] Worker 使用唯一 `.partial`、原子 rename、不覆盖目标并在失败时清理临时文件。
- [x] 独立展示 Agent run 与导出 Job 状态，并保留 `outcome_unknown` 专用重试边界。
- [x] 同步架构、API、环境变量、Job 协议和本阶段 Review。
- [x] 完成定向/全量验证、真实数据核对和双轴 Review 后只提交 Phase C 文件。

Review：

- Result：Phase C 已形成可初步使用的闭环。Web 从 PostgreSQL 持久化 run 恢复，按可见性
  分别轮询 run 与导出 Job；用户选择冻结视频场景后，Server 返回并由页面明确展示只读预览。
  确认事务重新校验 run/步骤、候选身份、generation、enforced scope、场景和时间范围，并通过
  唯一副作用记录让重复或并发请求复用同一个 `export_clip` Job。Worker 只写唯一 `.partial`，
  再用平台原生 no-replace rename 原子发布；已有目标或失败都不会被覆盖或遗留半成品。
- Notes：本阶段没有新增 migration，也没有修改真实数据库或 Qdrant。只读核对前后均为 35 个
  活跃且已索引文件、7,940 个 Asset、1,919 个场景、7,564 个已索引 Vector Ref 和 9,910 个
  Job；Qdrant `image_vectors=8`、`video_frame_vectors=5,629`、`caption_text_vectors=1,927`，
  合计 7,564 个 Point。最终 `corepack pnpm check` 通过 Shared 12、Web 53、Server 190 项测试及
  Next 生产构建；`.venv` Python Worker 123 项通过，`cloud_calls=0`。lint 通过并保留 1 个既有
  未使用 import warning；Phase C 29 个可格式化文件和 `git diff --check` 通过，全仓 format
  check 仍由 38 个未改动历史文件阻断。Standards/Spec 首轮阻断项已修复，最终双轴复审无
  阻断项。真实 RightAPI 调用、费用和本地媒体数据外发均为 0。

## Agent V1 Phase D：独立候选证据构建器

- Start：2026-08-12。目标是只使用当前 generation 已索引的 1～12 张视频帧，异步生成
  `contact_sheet_v1` 拼图和 `all_indexed_frames_v1` 稳定 manifest，并把证据身份、指纹、
  状态与结构化错误保存为 PostgreSQL 长期事实。
- 范围边界：不调用任何外部 Provider，不执行 Rerank 或 VLM 判断，不改变候选顺序、
  不删除/过滤/补位候选，不重新搜索、扫描、抽样或索引，也不修改 Qdrant。
- 验证计划：以 Shared Job Schema、Server HTTP API、Worker Job handler 和 Web 用户可见行为
  为四条公共测试接缝，逐条红绿实现；最后运行定向/全量测试、lint、format、迁移与真实数据
  完整性核对，并以 `b1fbdea` 为固定起点完成 Standards/Spec 双轴 Review。

- [x] 定义 `build_candidate_evidence` 共享 Job 输入、输出与 Python JSON Schema。
- [x] 新增规范化 `candidate_evidence` PostgreSQL 事实和增量迁移。
- [x] 实现候选/generation/场景/Asset 身份校验及事务性 Job 幂等创建与恢复 API。
- [x] Worker 二次校验当前 generation 的全部已索引场景帧并生成两种证据协议。
- [x] 实现规范化指纹、唯一 `.partial`、原子发布、不覆盖与失败/取消清理。
- [x] Web 以明确用户操作构建证据，并展示等待、构建、完成、失败、取消和本地拼图预览。
- [x] 同步架构、API、Job 协议、迁移说明和本阶段 Review。
- [x] 完成定向/全量验证、真实数据核对和双轴 Review 后只提交 Phase D 文件。

Review：

- Result：Phase D 已完成。Agent 与 Evaluation 都只在用户明确操作后创建本地证据 Job；
  `contact_sheet_v1` 和 `all_indexed_frames_v1` 使用当前 generation 的全部 1～12 张已索引帧，
  状态、manifest、SHA-256、保留策略与结构化错误由 `candidate_evidence` 独立保存。页面明确显示
  证据准备状态，并持续声明尚未执行 Rerank 或 VLM 审核。
- Notes：迁移前已备份 PostgreSQL；迁移后媒体文件 35、Asset 7,940、场景 1,919、已索引
  Vector Ref 7,564 与迁移前一致，Qdrant 三个 Collection Point 仍为 8 / 5,629 / 1,927。
  不需要回填、重新扫描或重新索引。全量验证通过 Shared 14、Server 200、Web 62、Python
  Worker 133 项和 Web 生产构建；lint 仅有一个未修改历史文件 warning，全仓 format check 仍由
  34 个既有文件阻断，Phase D 22 个可格式化文件单独通过。真实 Provider 调用、费用、数据外发
  与 Qdrant 写入均为 0。以 `b1fbdea` 为固定点的 Standards/Spec 首轮发现已修复，最终复审无
  阻断项；实现严格停在 Phase D。

## Agent V1 Phase E：`qwen3-vl-rerank` 影子评测

- Start：2026-08-12。目标是只在 Evaluation 中读取冻结视觉查询、RRF Top-20 与
  Phase D 成功本地证据，用一次专用 `qwen3-vl-rerank` 协议产生 Top-10 影子
  排序，并把状态、名次、指纹、用量、费用和错误保存为 PostgreSQL 历史事实。
- 范围边界：不改普通 Search/Agent 候选顺序，不重新搜索、扫描、抽帧或索引，
  不写 Qdrant，不执行 Phase F VLM Review，不产生 `passed/rejected` 等结论。
  未获得真实图像外发与费用授权前 Provider 保持禁用，测试只使用本地 fake。
- 验证计划：以 Shared 公开 Schema、Server Evaluation HTTP/持久化、Web 用户可见状态/轮询
  和普通 Search/Agent 排序不变为测试接缝；以 `a1f23c4` 为固定起点完成
  Standards/Spec 双轴 Review。

- [x] 冻结完整 Top-20/唯一 Top-10 请求响应 Schema，拒绝非法 index、重复、非有限
      score 和不完整输出。
- [x] 新增规范化 shadow run/attempt/ranking 事实、冻结 `search_scope` 和增量迁移。
- [x] 实现候选/证据身份与 SHA-256 校验、单请求调度、严格 Provider 输出校验、
      幂等并发与 dispatched/unknown 重启恢复边界。
- [x] 保存/展示 RRF 与影子名次及指标、模型协议、token、请求字节、耗时、
      费用、Provider request ID、三类指纹、实际样本数和结构化错误。
- [x] Web 覆盖未运行、运行中、成功、部分失败、失败与不适用；实现页面隐藏
      暂停轮询、恢复立即刷新、终态停止和卸载取消。
- [x] 审计 `apps/web/app` 全部用户可访问页面，补齐 Evaluation 主页、运行详情、
      报告和历史 Phase 9 页的可见入口/返回路径及 Web 完整性测试。
- [x] 迁移前备份 PostgreSQL，迁移后核对媒体数据和三个 Qdrant Collection。
- [x] 完成定向/全量验证、lint、format、`git diff --check` 和双轴复审后只提交
      Phase E 文件。

Review：

- Result：Phase E 的本地实现与验证已完成。Evaluation 对每条适用查询冻结完整 RRF Top-20，
  图片按固定规则缩放、视频只读取 Phase D 指纹通过的 `contact_sheet_v1`，再通过一次专用
  `qwen3-vl-rerank` 请求产生严格有序 Top-10。普通 Search、Agent 候选与 Qdrant 均不改写；
  历史页面只读 PostgreSQL，并明确显示“尚未执行 VLM 审核”。
- Notes：迁移前备份位于
  `.media-agent/backups/agent-v1-phase-e-pre-migration-20260812.dump`；迁移后媒体文件 35、
  Asset 7,940、场景 1,919、已索引 Vector Ref 7,564 与迁移前一致，Qdrant 三个 Collection
  Point 仍为 8 / 5,629 / 1,927。影子 run/attempt/ranking 均为 0，因此本阶段没有真实评测
  指标；真实 Provider 调用、图片外发、费用与 Qdrant 写入均为 0。全量验证通过 Shared 21、
  Server 213、Web 79、Python Worker 133 项和 Web 生产构建；lint 仅有一个未修改历史文件
  warning，Phase E 23 个可格式化文件单独通过，全仓 format check 仍由 31 个既有文件阻断，
  `git diff --check` 通过。以 `a1f23c4` 为固定点的 Standards/Spec 首轮阻断项已修复，最终
  复审结论记录在本次交付报告中；实现严格停在 Phase E。
- 2026-08-13 真实 smoke 前置：已按阿里云官方北京专属协议增加默认禁用的 DashScope
  适配器、严格成功/错误响应边界和只读 preflight；官方未返回的响应模型、token 拆分与
  账单费用保存 null，另存图片最高单价保守估算。首次调用上限默认 1，后续即使另行授权
  也只能配置到 4；每次派发前以 PostgreSQL 表锁跨 Evaluation run 统计同一协议，并按单请求理论最高 ¥0.216 预留累计 ¥0.5 预算，新建 run 不能重置额度。既有调用用量
  未知时停止且 run 汇总保持 null。迁移前备份位于
  `/private/tmp/stars-phase-e-smoke-preflight-20260813.dump`；迁移后 PostgreSQL 媒体数量与
  Qdrant 8 / 5,629 / 1,927 Point 均未变化。随后按用户提供的“有人在海边走路”创建并冻结一条
  `search_scope=visual` 的 discovery 查询，本地检索得到完整 RRF Top-20，并成功生成 20 份
  `contact_sheet_v1` Evaluation 证据。真实数据暴露 Caption-only 视频候选原本被 Phase D 帧 Asset
  校验错误拒绝；已用公开 API 回归测试修复为保留冻结 Caption Asset、只为证据 Job 确定性选择同
  scene indexed 帧锚点。当前运行处于 `ready_for_labeling`，current/RRF 两个 Top-20 的并集共有
  27 个候选等待人工判断；在用户完成标签和 finalize 前不会生成 preflight。真实 Provider 调用、
  图片外发和费用仍为 0。
- 2026-08-13 用户完成 27/27 人工判断后，实际 `reported` run 为
  `bd5ebb5d-503b-4f1b-a6ce-88c5aae44994`；此前交付的旧详情链接仍指向未标注 run，两个事实没有
  混写。修复 NestJS `null` 被编码成 200 空正文时 Web 无条件 `response.json()` 导致的
  `Unexpected end of JSON input`：只有影子读取这一明确可空契约把成功空正文解释为 `null`，非空
  畸形 JSON 继续快速失败。为正确 reported run 生成 20/20 成功双指纹证据后，只读 preflight
  得到完整 20-document 请求 **18,530,463 bytes**，查询/证据指纹均已冻结；外部调用、图片外发、
  费用和 Qdrant 写入仍为 0。
- 2026-08-13 用户明确授权首轮单次真实 smoke 后，使用一次性进程配置完成 1 次北京
  `qwen3-vl-rerank` Top-20 请求并关闭临时 Server，持久 `.env` 仍默认禁用 Provider。请求外发
  20 张派生 PNG，HTTP 200、耗时 2,689 ms、Provider request ID 已保存，正文包含 10 个结果；
  但供应商成功正文没有通过严格运行时 Schema，所以尝试按 `completed/failed` 收敛且写入排名 0，
  不重试、不补位、不改变 Search/Agent。`total_tokens`、实际账单和估算费用保持 null；理论最高
  ¥0.216 不是实际费用，用量未知预算门将阻止后续派发，需按 request ID 在阿里云控制台复核账单
  并先诊断真实响应协议漂移。
- 2026-08-13 首次 smoke 复盘修复：通过红→绿回归证明 DashScope 无害扩展字段会被旧版
  `.strict()` 误判；适配器现只提取所需字段，核心 Top-10 仍严格校验，畸形核心只持久化字段
  路径/错误类型。Provider 用量缺失不再丢弃合法排名，但保持 null 并停止后续预算。新增 `0007`
  一对一用量核对表和本地 API，独立保存用户从阿里云模型监控核对的 25,640 总 Token（文本
  1,200、图片 24,440）及标准原价估算 ¥0.044832，未覆盖第一次 Provider 字段或失败排名。
  迁移前备份 `/private/tmp/stars-phase-e-rerank-fix-20260813.dump`；迁移前后 PostgreSQL
  `35 / 7,940 / 1,919 / 7,564`、Qdrant `8 / 5,629 / 1,927` 均不变。Provider 仍禁用，
  第二次真实调用必须再次明确授权。
  同一冻结 Top-20 的第二次 smoke 已增加递增 `execution_number` 和显式 retry：使用新
  run/attempt，派发前核对 query/evidence 指纹，第一次 request ID、错误和人工用量保持只读。
  `0008` 迁移前备份 `/private/tmp/stars-phase-e-retry-20260813.dump`；迁移前后 PostgreSQL
  `35 / 7,940 / 1,919 / 7,564 / 1 attempt / 0 ranking / 1 reconciliation` 不变，三个
  Qdrant Collection 仍为 `8 / 5,629 / 1,927`。
- 2026-08-13 用户明确授权第二次 smoke：对同一 reported Evaluation/冻结 Top-20 创建
  `execution_number=2`，一次北京 `qwen3-vl-rerank` 调用成功。Provider request ID
  `2878ae48-26f3-993c-ad0e-f29b2747a44b`，20 候选/10 结果，保存 20 条审计排名（10 条有
  shadow rank），25,640 tokens、3,138 ms、18,530,463 bytes，保守估算 ¥0.046152。
  单查询 n=1：Precision@5 从 0.60 提升到 0.80，Precision@10 从 0.50 提升到 0.70，
  nDCG@10 从 0.579 提升到 0.710。历史累计恰好 2 次外发，临时 Server 已停止；未进入 VLM
  Review，未改变 Search/Agent 排序，未写 Qdrant。

## Agent V1 Phase F：VLM 人工盲测准备

- Start：2026-08-13。本次只准备候选审核数据、共享 Schema、Server 本地数据集 API、
  fake Provider 和测试；不实现真实 VLM Provider，不调用 `qwen3.7-plus`，不进入
  Top-3 产品模拟或 Phase G。
- [x] 以当前索引重跑既有 50 条冻结查询，产生不受旧 generation 污染的 Evaluation 快照。
- [x] 确定性生成 60 对待审核建议，五组各 12 对；抽样依据明确标注为建议，
      不冒充人工真值。首次多样性复核调整为覆盖全部 50 条旧冻结查询、每条最多 2 对；
      用户随后明确要求查询语义本身也必须是新的，不能只对旧查询去重。
- [x] 实现可播放视频、对照原子条件、接受/拒绝/改组的候选审核页，并建立可见入口与面包屑。
- [x] 新增规范化批次/案例/条件表与增量 `0009` 迁移；`0010` 为建议包指纹增加唯一索引，
      并发或重复导入只产生一个批次，候选审核与条件级人工标签分开。
- [x] 冻结 `qwen3.7-plus` 请求/输出 Schema，严格拒绝条件和证据帧 ID 缺失、重复、改写或发明。
- [x] 实现本地 fake Provider 和 Server 固定状态派生规则，fake 记录请求但外部调用计数恒为 0。
- [x] 用户逐条审核 60 对候选；拒绝文本全部永久退出有效池，最终候选通过完整性门并冻结为
      只读快照。本阶段仍未进入条件级人工盲标、证据构建或真实 VLM 调用。

Review（候选审核准备里程碑）：

- Result：候选审核批次已保存并冻结到 PostgreSQL。首次创建时为待审核 60、已接受 0、
  已拒绝 0；最终为有效 accepted 60、pending/rejected 0，五组各 12，并保留全部替代历史。
  Web 明确显示“真实 VLM 调用：0”“尚未执行 VLM 审核”和只读冻结状态。后续若进入条件级
  人工盲标与 `all_indexed_frames_v1` 证据构建，应作为独立步骤继续，不能把候选冻结误认为
  已经执行模型审核。
- Notes：迁移前备份为 `/private/tmp/stars-phase-f-pre-migration-20260813.dump`；迁移前后 PostgreSQL
  媒体文件 35、Asset 7,940、Vector Ref 7,564 不变，Qdrant 三个 Collection Point 仍为
  8 / 5,629 / 1,927。新候选 Evaluation run 为 `86d3cd3a-152e-46a6-887e-d549a0ee8411`。
  生成、导入与页面验收只读本地媒体和 Qdrant，真实 Provider 调用、图片外发、费用和 Qdrant 写入均为 0。
  `0010` 前另备份 `/private/tmp/stars-phase-f-identity-pre-migration-20260813.dump`；迁移后仍为
  1 个候选批次、60 对案例和 364 条条件，媒体与 Qdrant 数量不变。
  2026-08-13 用户审核至接受 12、拒绝 18、待审核 30 时发现跨组查询重复偏多；调整前备份
  `/private/tmp/stars-phase-f-query-diversity-pre-refresh-20260813.dump`，只替换 30 个 pending
  案例。调整后 60 个候选身份仍全部唯一，覆盖 50 条唯一查询且每条最多 2 对，条件共 363 条；
  已审核 30 对的整行 SHA-256 校验和前后一致，Qdrant 点数仍为 8 / 5,629 / 1,927。
  这次调整随后被用户指出仍复用了旧 Evaluation 文本，因此只保留为历史时点，不能代表
  当前候选包。
  2026-08-13 根据用户澄清新建 30 条视觉自然发现查询；它们彼此唯一，与 PostgreSQL
  既有 Evaluation 文本精确重合数为 0。修改前备份
  `/private/tmp/stars-phase-f-fresh-queries-pre-refresh-20260813.dump`，新 set/version/run 分别为
  `1ccae129-dc61-44a9-a0f8-ae5a26b2d965`、`8d0e7145-159f-4da9-bb05-86f6f3f33366`、
  `1965dbe7-fb53-4f05-9366-da42aad167af`。run 对 30 条查询完整召回 798 个主池候选并进入
  `ready_for_labeling`；随后只替换 30 个 pending 案例，接受 12/拒绝 18 的旧人工事实不动。
  当前 60 个候选全部唯一，覆盖 55 条唯一查询；30 个 pending 分别使用 30 条不同的新查询。
  三个 Qdrant Collection 仍为 8 / 5,629 / 1,927，真实 VLM 调用、图片外发和费用仍为 0。
  2026-08-13 用户完成首轮 60 对审核：接受 38、拒绝 22、待审核 0。增量 `0011` 前备份
  `/private/tmp/stars-phase-f-replacements-pre-migration-20260813.dump`；迁移只新增
  `replaces_case_id` 自关联和唯一索引。随后从各原查询的同一冻结 run 中为 22 条拒绝案例
  各生成一条未使用候选，旧拒绝审计保持只读。当前有效候选为接受 38、待审核替代 22、
  拒绝 0，另有历史拒绝 22；总审计行 82、有效叶子仍恰好 60。未重新搜索、未调用真实
  VLM、未外发图片、未写 Qdrant。
  第二轮替代审核完成后为接受 53、拒绝 7、待审核 0；第三轮生成前备份
  `/private/tmp/stars-phase-f-replacements-round3-pre-20260813.dump`。7 条拒绝叶子均成功追加
  `replacement-2` 后继，且保持同一冻结查询/run。当前有效候选仍为 60 个唯一身份：接受 53、
  待审核 7、拒绝 0；历史拒绝累计 29，总审计行 89。Qdrant 点数仍为 8 / 5,629 / 1,927，
  未重搜、未调用真实 VLM、未外发图片。
  2026-08-14 用户完成第三轮审核后，60 个有效候选均 accepted，但人工组别为
  10 / 28 / 9 / 7 / 6，未满足五组各 12 条。再平衡前备份
  `/private/tmp/stars-phase-f-rebalance-pre-20260814.dump`；事务化匹配保留 16 条超额组 accepted
  历史，并追加 16 条同 run、同 query 的未使用 pending 后继。当前总审计行 105、有效候选仍为
  60 个唯一身份，按“accepted 的人工组别 + pending 的目标组别”统计五组均为 12；状态为
  accepted 44、pending 16、rejected 0、历史 rejected 29、历史 accepted 16。真实 VLM 调用、
  图片外发、费用和 Qdrant 写入仍为 0。
  用户随后澄清：人工拒绝的是查询文本，而不只是单个视频。修复前只读核对发现 18 个历史拒绝
  文本仍关联 23 个有效叶子（accepted 15、pending 8）。备份
  `/private/tmp/stars-phase-f-discard-rejected-queries-pre-20260814.dump` 后，事务化保留这些前代
  审计并追加 23 个从未被拒绝的冻结查询—候选。当前总审计行 128、有效叶子仍为 60 个唯一
  候选，且 60 个查询文本全部唯一；与 18 个拒绝文本的重合数为 0。五组仍各 12 条，状态为
  accepted 29、pending 31、rejected 0、历史 rejected 29、历史 accepted 31。真实 VLM、图片
  外发、费用和 Qdrant 写入仍为 0。
  用户完成下一轮审核后新增拒绝 20 条。旧冻结 runs 虽有足够视频候选，但排除累计 38 个拒绝
  文本后只剩 42 个查询，无法满足至少 50 个唯一查询；首次替代尝试以 409 整体回滚。用户随后
  提供 13 条新原文，与全部历史及拒绝文本精确重合均为 0。新 set/version/run 分别为
  `7db14fe0-ae95-4d80-b675-fc291298151c`、`9b73728e-d3a4-4596-a035-447a5ec1863c`、
  `dcfff4cf-a7c4-4296-8c12-fb70fcdd2c55`；13 次本地检索完整冻结 545 个候选并进入
  `ready_for_labeling`。替代 API 显式接收该 run 后成功追加 20 个 pending 后继：当前总审计行
  148、有效候选 60、有效查询 55 个，累计 38 个拒绝文本与有效池重合为 0；accepted 40、
  pending 20、rejected 0、历史 rejected 49、历史 accepted 31。真实 VLM、图片外发、费用和
  Qdrant 写入仍为 0。操作前备份为
  `/private/tmp/stars-phase-f-discard-rejected-round2-pre-20260814.dump`。
  用户随后接受全部 20 条，有效池达到 accepted 60、拒绝文本重合 0，但人工组别为
  11 / 16 / 10 / 15 / 8。最终配额再平衡前备份
  `/private/tmp/stars-phase-f-final-rebalance-pre-20260814.dump`；事务化保留 7 条超额组 accepted
  历史，并追加完全符合 1、证据不足 2、部分相关 4 条 pending 后继。当前总审计行 155、有效
  候选仍为 60 个唯一身份、55 个不同查询，五组按 accepted 人工组别与 pending 目标组别合计
  均为 12；accepted 53、pending 7、rejected 0、历史 rejected 49、历史 accepted 38。真实
  VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户接受首轮 7 条配额候选后，人工组别再次变为 11 / 15 / 11 / 13 / 10。第二次最终
  再平衡前备份 `/private/tmp/stars-phase-f-final-rebalance-round2-pre-20260814.dump`，随后保留
  4 条超额组 accepted 历史，并追加完全符合 1、证据不足 1、部分相关 2 条 pending 后继。
  当前总审计行 159、有效候选 60、五组各 12；accepted 56、pending 4、rejected 0、历史
  rejected 49、历史 accepted 42。真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户接受第二轮 4 条配额候选后，人工组别为 12 / 12 / 13 / 13 / 10。第三次最小再平衡前
  备份 `/private/tmp/stars-phase-f-final-rebalance-round3-pre-20260814.dump`，保留证据不足与缺少
  必须条件各 1 条 accepted 历史，并追加 2 条部分相关 pending 后继。当前总审计行 161、有效
  候选 60、五组各 12；accepted 58、pending 2、rejected 0、历史 rejected 49、历史 accepted
  44。真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户拒绝第三轮 2 条部分相关候选；它们不能因目标配额为 12 而进入盲测。清理前备份
  `/private/tmp/stars-phase-f-discard-final-two-pre-20260814.dump`，随后永久排除这 2 个文本并
  追加 2 条未拒绝查询下的部分相关 pending 后继。当前总审计行 163、有效候选 60、不同查询
  53、拒绝文本重合 0、五组各 12；accepted 58、pending 2、rejected 0、历史 rejected 51、
  历史 accepted 44。真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户接受上述 2 条后，其中 1 条人工改判为命中排除条件，组别为 12 / 13 / 12 / 12 / 11。
  第四次最小再平衡前备份 `/private/tmp/stars-phase-f-final-rebalance-round4-pre-20260814.dump`，
  保留 1 条超额排除条件 accepted 历史并追加 1 条部分相关 pending 后继。当前总审计行 164、
  有效候选 60、五组各 12；accepted 59、pending 1、rejected 0、历史 rejected 51、历史
  accepted 45。真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户拒绝第四轮最后 1 条部分相关候选；该查询文本同时被另一条 accepted 叶子复用，因此按
  数据集级永久排除规则必须同时退出 2 条。清理前备份
  `/private/tmp/stars-phase-f-discard-shared-final-query-pre-20260814.dump`，随后保留两条前代审计
  并追加命中排除条件 1、部分相关 1 条 pending 后继。当前总审计行 166、有效候选 60、不同
  查询 52、拒绝文本重合 0、五组各 12；accepted 58、pending 2、rejected 0、历史 rejected
  52、历史 accepted 46。真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户接受上述 2 条后，其中命中排除条件候选被人工改判为证据不足，组别变为
  12 / 11 / 13 / 12 / 12。第五次单条再平衡前备份
  `/private/tmp/stars-phase-f-final-rebalance-round5-pre-20260814.dump`，保留 1 条超额证据不足
  accepted 历史并追加 1 条命中排除条件 pending 后继。当前总审计行 167、有效候选 60、
  五组各 12；accepted 59、pending 1、rejected 0、历史 rejected 52、历史 accepted 47。
  真实 VLM、图片外发、费用和 Qdrant 写入仍为 0。
  用户接受最后 1 条后，冻结前只读核对为 accepted 60、pending/rejected 0、历史 rejected 52、
  历史 accepted 47；60 个有效候选身份全部唯一，覆盖 52 条不同查询，五组各 12。冻结前备份
  `/private/tmp/stars-phase-f-final-freeze-pre-20260814.dump`（21 MB）。本地冻结 API 在一个
  PostgreSQL 事务内复核上述事实与条件完整性后，将数据集更新为 `frozen`，指纹为
  `ba43387caccda3706fbcbf997dcb3a3efd2ac35ca742a4d0128fd139ce037f52`；重复冻结返回同一
  指纹，未新增案例。页面显示只读冻结状态并禁用审核/改组控件。真实 VLM 调用、图片外发、
  费用和 Qdrant 写入仍为 0；Phase F 停在人工盲测数据冻结，不进入模型执行或 Phase G。

### Phase F：条件级人工盲标闭环

- Start：2026-08-14。基于已冻结的 60 条候选，复用 Phase D 独立索引帧证据，建立一审、复核、
  裁决、标签冻结和冻结后 fake 协议演练；真实 Provider、图片外发和 Phase G 保持关闭。
- [x] 新增独立 labeling session、fake run/result 与条件标注时间的增量 `0012` 迁移；候选 dataset
      保持 `frozen`。
- [x] 只用 `source_evaluation_run_id + source_candidate_id` 创建或复用
      `all_indexed_frames_v1`，不重新搜索、扫描、索引或写 Qdrant。
- [x] 实现严格 `first / second / final` API、阶段锁、争议裁决、resolved verdict 与人工标签指纹。
- [x] 实现键盘可操作的条件卡、卡内保存反馈、总进度、可见时轮询、失败重试和状态播报。
- [x] 标签冻结前隐藏 fake 输出；冻结后只运行本地 fake，保存脱敏结果与条件/案例一致率报告，
      外部调用数固定为 0。
- [x] 迁移真实 PostgreSQL 前完成备份；迁移后复核媒体事实、60 条候选和三个 Qdrant Collection。
- [x] 完成 Shared、Server、Web、Python Worker、仓库 check/lint/format/diff 验证并精确提交。

Review：

- Result：已为冻结候选建立独立人工标签会话；页面可从 60 条 `all_indexed_frames_v1` 证据准备
  进入一审、复核、争议裁决和标签冻结。标签冻结后才开放本地 fake 演练，持久化条件输出、
  Server 固定派生状态和两项一致率；候选 dataset/指纹保持不变，真实 Provider 适配器仍不存在。
- Notes：`0012` 前备份为 `/private/tmp/stars-phase-f-human-labeling-pre-20260814.dump`（4.1 MB，
  PostgreSQL custom 压缩格式）。迁移记录 18→19；迁移前后 PostgreSQL 均为媒体文件 35、Asset
  7,940、Vector Ref 7,564、候选审计行 167、条件 992，冻结 dataset UUID/指纹不变；新 labeling
  session 与 fake run 均为 0。Qdrant Point 前后均为 8 / 5,629 / 1,927。验证通过：
  `corepack pnpm check`（Shared 26、Web 92、Server 261 个测试及 Next.js 生产构建）、Python Worker
  `.venv` 133 个测试、lint、本次 37 个文件 format check 与 `git diff --check`。全仓 format check
  仍报告 31 个未触及的历史文件；lint 仅报告 `repositories.test.ts` 的既有未使用 import 警告。
  按用户本次明确要求跳过 Standards/Spec 双轴复审。真实 VLM 调用、图片外发、费用、Qdrant 写入
  和人工标签均为 0；页面停在“可开始准备证据/第一轮盲标”的边界，未进入 Phase G。

### Phase F：真实 qwen3.7-plus 能力盲测执行边界

- Start：2026-08-17。用户已经完成 60 条候选的 357/357 条件一审、357/357 独立复核和
  36/36 争议裁决，并冻结 labeling session `4605b962-bb97-4a1b-8612-88edf56f7d6c`；标签指纹为
  `5b98e0e86128047a3bc868cd25a107eba333116442eb43cbfa4264de2833a107`。
- [x] 保留 fake run `1cadb7f8-32c6-4838-830f-054c83988920` 的独立历史：60/60 成功、外部调用
      0；条件一致 191/357（53.50%），案例状态一致 18/60（30%）。这些数值只证明请求、严格解析、
      Server 状态派生和指标链路能运行，不代表模型质量，也不会填入真实报告。
- [x] 新增独立 RightAPI `qwen3.7-plus` Provider：固定非思考模式、Anthropic Messages Base64
      图片与唯一强制 Tool Call；严格拒绝工具名、candidate/condition/frame 身份、重复、缺失或
      额外项错误，不从 Markdown/自由文本猜测结果。
- [x] 新增默认 `disabled` 的 `VLM_REVIEW_PROVIDER` 部署闸门，以及绑定 dataset、labels、evidence
      和 preflight 指纹的独立视觉授权；仅有 RightAPI Key 或 AgentIntent 文本授权都不能发图。
- [x] 新增 `0013` 增量迁移，分表保存视觉授权、真实 run、attempt 和 result。dispatch 先于网络
      请求持久化；中断恢复为 `outcome_unknown` 且停止，只有显式 `retry-unknown` 才新建
      `step_attempt_id`，旧 attempt 永不覆盖。
- [x] 新增只读 preflight、受控运行、轮询和历史报告 API；正式协议固定 60 条各一次，并把冻结
      `partial_relevance` 组 12 条各追加两次，总上限 84。报告保存错误通过、总体/分组正确数、
      条件分类准确率、三次稳定性、P50/P95、token、费用和晋级门槛。
- [x] 在既有 `/evaluation/vlm-blind` 页面增加本地 preflight、Provider/授权状态、84 次与预算确认、
      真实运行状态及历史只读报告；保留评测主页和历史报告入口，没有新增孤立路由。
- [x] 迁移前创建 `/private/tmp/stars-phase-f-labels-frozen-pre-real-vlm-20260817.dump`（4.2 MB，
      SHA-256 `4db1b1ed64500bf810a6648d33f17ffb5211881b7a937e820f3519d161aeb984`）。迁移登记
      19→20；迁移后媒体文件 35、Asset 7,940、场景 1,919、已索引 Vector Ref 7,564 不变，
      Qdrant Point 仍为 8 / 5,629 / 1,927，真实 run/attempt 均为 0。
- [x] 用真实冻结输入完成本地 preflight：dataset/labels 指纹一致，evidence 指纹
      `21d543642fd1ffa77623b997930300e196e90bb3664bd1605d525bbabce19c5b`，60 条候选、84 次上限、
      363 张累计外发图片、请求体合计 689,852,994 bytes，单候选 1～12 张、单请求
      521,144～41,041,499 bytes；Provider 配置存在但部署闸门为 disabled，视觉授权不存在，
      `external_call_count=0`。

当前限制：冻结最终条件只有 yes=147、no=210，没有 uncertain 真值，因此严格的
`yes/no/uncertain` 三分类宏平均无法计算，报告必须显示“未知/门槛未通过”，不能删除缺失类别或
伪造分数。真实 VLM 调用、查询/图片外发和费用仍为 0；尚未生成真实质量指标，未进入真实 Top-3
模拟或 Phase G。

### Agent V1 Phase F：五类型真实 VLM smoke（2026-08-17）

- [x] 新增与 84 次正式评测隔离的 `vlm-review-smoke-v1`：从 `exact_match`、
      `missing_must_have`、`exclusion_hit`、`partial_relevance`、`insufficient_evidence` 五个冻结
      分组各选一条。每组先取真实请求字节最小者，字节相同时按 case UUID，保证冻结输入不变时
      选择稳定，并尽量减少首次媒体外发。
- [x] 新增独立 smoke preflight、视觉授权和运行入口。Smoke 指纹包含选择规则与五条请求，只允许
      恰好 5 次调用、费用硬上限 ¥0.50；该授权无法启动 84 次正式评测。报告只说明协议、审计和
      五个样本是否跑通，不用每类一条的小样本计算正式晋级门槛。
- [x] 真实冻结数据的只读 preflight 选择 5 条、每条 1 张图，共 5 张派生 PNG、3,971,489 bytes；
      单请求 521,144～979,046 bytes。preflight 指纹为
      `c4a6f12d8d5665f5108ad7e65575e480e1ddf898cbec81b9bfe5f882d80bf8d0`。Provider 部署闸门仍为
      `disabled`，独立视觉授权不存在，真实外部调用、媒体外发和费用仍为 0。

下一步边界：在用户核对五条 smoke 清单并重新明确授权前，不开启 `VLM_REVIEW_PROVIDER=rightapi`，
不创建真实 run。Smoke 完成后先核对响应模型、Tool Call、条件身份、token、费用、响应指纹和
`outcome_unknown` 状态，再决定是否单独授权 84 次正式评测；不直接进入 Phase G。

- [x] 用户明确授权后执行真实 smoke run `a5800b99-a391-4d7f-86f1-46ac1020c428`。第 1 条
      `exact_match` 成功，响应模型 `qwen3.7-plus`，Provider request ID
      `chatcmpl-b45dab7d-cfda-9bf2-9842-78b1899da460`，响应指纹
      `b9d1447d5de5cae748e0e1f2a62f987f5b190a4ad6879fba78618e150ce32d07`；耗时 77,674 ms，
      2,790 input tokens + 426 output tokens = 3,216 total tokens，案例状态与人工真值一致，6 个
      条件中 5 个一致，唯一差异为 `optional-2`（模型 yes、冻结人工真值 no）。
- [x] 第 2 条 `missing_must_have` 在 120,010 ms 超时并进入 `outcome_unknown`；Server 立即停止，
      第 3～5 条保持 `not_dispatched`。最终实际外部调用 2 次、成功 1、结果未知 1、未外发 3，
      没有自动重试。Provider 未返回成功请求的账单费用，超时请求是否产生 token/费用也未知，
      因此 run 的 `billed_cost_cny` 保持 null，不能把未知费用按 0 报告。

真实 smoke 已按停止条件结束。未经新的明确授权，不调用 `retry-unknown`，不补跑后三条，不启动
84 次正式评测，也不进入 Phase G。

### Agent V1 Phase F：五类型 smoke 恢复执行（2026-08-17）

- [x] 用户追加授权“重试原 unknown + 补跑三条未派发”，最多新增 4 次、4 张派生 PNG、预算
      ¥0.40。为避免覆盖原 5 次授权和 attempt，新增 `vlm-review-smoke-recovery-v1` 独立 run；
      recovery preflight 指纹为
      `86485db696826e32a7b47c6b7c96e2aedca585006d97b0f8eca8eb4fe753aa37`，总请求体
      3,042,421 bytes。新重试 attempt 通过 `retry_of_attempt_id` 引用原 unknown，后三条引用原
      `not_dispatched` 请求身份；原 run 事实不变。
- [x] Recovery run `0c0987da-5061-4dc4-9b1b-e2bc691e575a` 先成功重试
      `missing_must_have`：49,403 ms、3,155 tokens、响应指纹
      `0d6a8a986dd0db6bd83cc1b85b837858bdbd92c82dec88233737ddb48c389001`；随后成功执行
      `exclusion_hit`：53,406 ms、3,214 tokens、响应指纹
      `41fdd8b98d47af1b8a79146a4fcf560cf411ffa8dc6756b689ccae0607911f6e`。两条案例状态均与
      人工真值一致，但条件仅 5/11 一致（45.45%），不能只看最终 rejected 状态而忽略条件误判。
- [x] 第 3 条 `partial_relevance` 在 120,007 ms 再次进入 `outcome_unknown`，Server 按授权立即
      停止；最后的 `insufficient_evidence` 保持 `not_dispatched`。本次新增外部调用 3 次、成功 2、
      未知 1、未外发 1，无自动重试；成功请求共 6,369 tokens。Provider 仍未返回账单费用，超时
      请求费用未知，所以 recovery `billed_cost_cny` 保持 null。
- [x] 修正 smoke 派生指标分母：只有成功且有严格结构化输出的案例才进入案例/条件准确率；
      `outcome_unknown`、失败和未派发只进入运行完整性指标。Recovery 因此显示已评估 2/计划 4、
      案例状态 2/2、条件 5/11，而不是把无模型输出的条件伪装成答错。

恢复执行再次按停止条件结束。未经新授权，不重试 `partial_relevance`，不补跑最后一条，不启动
84 次正式评测，也不进入 Phase G。

### Agent V1 Phase F：剩余两类型 continuation（2026-08-17）

- [x] 将 `VLM_REVIEW_TIMEOUT_MS` 的默认值和部署上限从 120,000 ms 调整为 180,000 ms（3 分钟），
      同时将 84 次正式能力评测的 P95 接入门槛从不高于 90,000 ms 调整为不高于 180,000 ms。
      P95 是把请求耗时从小到大排列后的第 95 百分位；数值越低越快，门槛放宽只减少慢请求被
      判失败的概率，不会放宽条件准确率、稳定性或完整性要求。
- [x] 恢复协议现在也能以一个 `vlm-review-smoke-recovery-v1` unknown run 为来源，只选择其中唯一
      的 `outcome_unknown` 和唯一的 `not_dispatched` 槽位，创建新的两条 run/attempt 审计链；旧
      recovery run 和两次超时事实保持不变。自动化测试覆盖“原 smoke 停止 → 四条 recovery 再次
      停止 → 两条 continuation 成功”的完整顺序。
- [x] 本地只读 preflight 已确认剩余 `partial_relevance` 和 `insufficient_evidence` 各 1 张派生
      PNG，共 2 张、1,724,468 bytes，指纹为
      `6806cf9f88a9bb67b6b5b64f8050e528e00033a86043fa5e62443a9808b916fe`；真实外部调用仍为 0。
- [x] 用户补充本次新增预算上限 ¥0.20 后创建独立授权
      `e2942838-4280-4a25-a51c-78d5116c3797`，并完成 continuation run
      `c65073b7-524e-44be-8cbf-040382fbc68c`。两条均在 180 秒内成功，外部调用 2、成功 2、失败 0、
      unknown 0；P50/P95 为 39,908/60,504 ms，输入 6,043 + 输出 843 = 6,886 tokens。Provider
      没有返回账单费用，因此 `billed_cost_cny` 仍为 null，不能把未知费用记为 0。
- [x] `partial_relevance` 响应指纹
      `2d8ac828b2ee5d904cc1427c381cc008f7bfc2941e94866bdc2b28384c5efc89`，条件 4/7 与人工真值
      一致；模型把舞台/演出背景、唱歌、观众或装饰错误判断为 yes，Server 派生 `passed`，与人工
      条件派生状态不一致。`insufficient_evidence` 响应指纹
      `7938f36254ee8af613902fb3f49f0feba9915a02888eaf87bab7bdcd550d334d`，条件 6/6 一致且派生
      `passed`，但冻结分组期望 `insufficient_evidence`，暴露“全部人工真值只有确定 yes/no”与该
      分组状态之间的评测口径冲突。Continuation 汇总案例状态 0/2、条件 10/13（76.92%）。

五个 smoke 类型现在都至少获得一次成功结构化响应；两次历史超时仍作为独立 unknown attempt 保留。
本轮只证明 Provider、Tool Call、审计、停止和恢复链路可运行，质量与评测口径均未达到启动 84 次
正式评测的条件；不进入 Phase G。

## 视频检索重建 Phase 9A-C2：未见样本与标签一致性复测

- Start：2026-08-02。只读复用 Phase 8 正式 run
  `6298b745-d9d3-44bf-86a0-2d0a0b46360c` 的当前索引 generation，从未进入原 Phase 9A
  12 条清单的查询—视频场景对中确定性选择 30 条。协议见
  `docs/superpowers/reports/2026-08-02-phase9a-c2-blind-test-protocol.md`。
- 当前边界：本轮先实施本地样本冻结和人工标注工具。人工标签冻结前不调用任何 VLM；
  新一轮外发图片、查询和时间戳需要用户重新明确授权供应商与预算，旧授权不自动扩大。

- [x] 测试先行实现 30 条确定性选择、旧样本排除、类别/来源/等级配额和 manifest 校验。
- [x] 生成不含旧人工等级、来源分数、排名和本地路径的冻结盲标包。
- [x] 实现逐项 `是 / 否 / 不确定` 标注、自动等级推导、本地暂存和 JSON 导出。
- [x] 完成第一位标注者的 30 条判断；条件允许时由第二位标注者独立判断，否则由同一人
      间隔后复标。
- [x] 在揭示旧标签或模型结果前完成分歧裁决，冻结新的参考标签和一致性报告。
- [x] 取得新一轮外发授权后，运行 Qwen3-VL-Plus/Flash 各 3 次并生成独立质量报告。
- [x] 运行全量验证、双轴审查并使用中文信息提交当前分支。

Review（本地准备里程碑）：

- Result：30 条正式盲标包与 `/evaluation/phase9a-c2` 页面已完成；包指纹为
  `sha256:c016eb5a2a06500fe5e38eeb16cd9930601f89581f37836c1c2ec339406f1afc`。当前等待
  人工轮次 A/B，因此 Phase 9A-C2 尚未形成模型质量结论。
- Notes：生成过程只读 PostgreSQL，数据库写入和云端调用均为 0；答案仅保存在浏览器
  localStorage 并导出 JSON。重复生成内容完全一致，盲包未包含旧等级、来源/排名、Caption、
  本地路径或音频判断词。最终验证通过 Python Worker 112 项、Web 46 项、Server 136 项、
  Shared 6 项测试及 Web 生产构建；Standards/Spec 双轴复审无剩余发现。
- Human freeze：整体等级 26/30 一致，逐项条件 23/30 一致；7 条裁决后最终为 0 级 16 条、
  1 级 7 条、2 级 7 条、无法判断 0 条。冻结后只读揭示旧标签，18/30 不变、12/30 变化；
  该差异同时包含人工理解浮动和更严格的逐项协议，不能解释成单一“人工错误率”。
- Cloud result：Plus 多数票准确率 53.3%、加权 kappa 0.4862、估算费用 0.379407 元；
  Flash 多数票准确率 50.0%、加权 kappa 0.3820、估算费用 0.05349405 元。Plus 只多答对
  1 条，但约贵 7.1 倍、慢 2 倍；两个模型都没有正确识别任何 1 级样本，因此不进入生产。
- Validation：Python Worker 122 项、Web 46 项、Server 136 项、Shared 6 项测试及 Web
  生产构建全部通过；报告 180 个调用身份唯一，指纹可重算，未发现 API Key 或真实本地
  路径。真实 PostgreSQL 连接验证为只读事务；Standards/Spec 双轴复审无剩余发现。

## 视频检索重建 Phase 9A-C：国产云端视觉模型回归对照

- Start：2026-08-01。只读复用 Phase 8 正式快照与原 Phase 9A 的 12 个候选；比较智谱
  GLM-4.6V-Flash、阿里云 Qwen3-VL-Plus 和 Qwen3-VL-Flash，不接入生产搜索。
- 数据授权：用户允许发送缩放临时帧、查询与时间戳；完整视频、路径、Caption、转录、
  PostgreSQL 行和 Qdrant 向量不允许外发。

- [x] 冻结供应商、模型 snapshot、相同抽帧/Prompt/重复次数和旧样本回归口径。
- [x] 测试先行实现 OpenAI-compatible 多图片请求、严格 JSON 解析和 token 用量读取。
- [x] 实现调用前最坏成本预留、2 元默认总预算、已知价格档位上限和异常快速失败。
- [x] 实现显式外发确认、只从环境变量读取密钥、报告脱敏和临时帧统一清理。
- [x] 记录复跑命令、指标解释、隐私边界以及“旧样本不能直接充当新正式闸门”。
- [x] 本机配置两家供应商密钥后执行真实对照并保存 JSON 报告；Qwen 完成，GLM 429 阻塞
      且失败尝试单独保留，未伪造完整指标。
- [x] 人工逐条复核 Qwen 模型理由；两条歧义标签保持冻结，约 20 条未见盲测样本留作未来
      新评测，不能在本轮已观察样本上事后补入。
- [x] 运行全量验证、双轴审查并使用中文信息提交当前分支。

Review：

- Result：云端替换未证明质量提升。Plus 为 6/12、Flash 为 7/12，排除两条歧义标签后
  均为 6/10；Plus 至少 3 个理由问题，Flash 至少 5 个且有等级/理由矛盾。GLM 单例格式
  修复后可用，但 30 秒主动间隔仍触发 429，因此只记录可用性阻塞，不制造质量结论。
- Notes：当前代码不创建 Job、Server API 或 Web 入口，不写数据库/Qdrant，不需要迁移、
  回填或重新索引。正式 Qwen 批次估算 0.16315695 元，包含冒烟和诊断的全部付费调用约
  0.17087885 元，低于 2 元上限。`corepack pnpm check` 通过：Shared 6、Web 42、Server
  136 项测试及 Web 生产构建成功；Python Worker 102 项 unittest 通过。规格与规范双轴
  复审均无剩余问题。

## 视频检索重建 Phase 9A：真实 Top-K 多帧 VLM 可行性闸门

- Start：2026-08-01。输入只允许来自 Phase 8 正式 run
  `6298b745-d9d3-44bf-86a0-2d0a0b46360c`；使用本机 Ollama `qwen2.5vl:7b`，不加载
  Transformers Qwen 权重、不删除缓存、不创建搜索任务，也不修改生产 RRF。
- 当前边界：本阶段只产出隔离实验工具、冻结样本清单和真实报告。9B 的 Job Schema、
  Server API、Worker handler、`/verify-frames` 与 Web 入口均不得提前实现。

- [x] 只读审计 FFmpeg、Ollama 模型版本和 Phase 8 Top-3 视频候选覆盖。
- [x] 测试先行实现真实快照解析、帧时间选择、变化峰值、边界、上限和去重规则。
- [x] 实现 Ollama 温度 0 严格 JSON 调用、模型 digest 锁定、3 次重复和资源监控。
- [x] 在查看模型输出前冻结样本、人工期望等级、Caption-only 分组阈值和最小样本量。
- [x] 运行真实实验，记录冷/热耗时、平均值、P95、Top-3、内存、swap 与失败分类。
- [x] 人工复核自由文本理由只引用已抽取画面中的可见证据，并保存最终通过/失败报告。
- [x] 运行全量验证与双轴审查，使用中文信息提交当前分支。

Review：

- Result：Phase 9A 隔离实验已完成但未通过质量闸门。12 个场景中只有 7 个等级与冻结
  人工判断一致，人工复核还发现至少 9 条理由包含画面无法支持的断言。
- Notes：36/36 次调用成功、12/12 个场景三次等级稳定，真实冷启动 11.955 秒，热调用
  平均 8.063 秒，最坏三个 30 秒场景合计 89.935 秒，实验期间 swap 正增长为 0；均通过
  预设门槛。Phase 9B～9D 跳过，生产 RRF 未修改，Phase 8 正式快照保持不可变；无需迁移、
  回填或重新索引。`corepack pnpm check` 通过：Shared 6、Web 42、Server 136 项测试和 Web
  生产构建均成功；Python Worker 84 项 unittest 通过。规格与规范双轴复审均无剩余问题。

## 视频检索重建 Phase 8：核心检索干净评测基线

- Start：2026-07-31。只使用阶段 6 已实现的评测表、API、盲标和指标模块创建真实数据，
  不修改 RRF 公式，不启用阶段 9 多帧复核。评测协议见
  `docs/superpowers/reports/2026-07-31-phase8-evaluation-protocol.md`；正式结果见
  `docs/superpowers/reports/2026-08-01-phase8-core-retrieval-baseline.md`。
- 当前边界：正式素材为 15 个视频和 8 张图片；冻结版本、运行快照、人工判断和报告
  均已保存，Phase 9 只能读取快照，不得回写本基线。

- [x] 审计评测数据库、服务状态和当前素材覆盖。
- [x] 修复 Evaluation Controller 依赖未注入导致真实 `/evaluation/*` 路由返回 500，
      并增加 NestJS Controller 回归测试。
- [x] 预先固定查询结构、样本量、盲标等级、A/B 定义、指标口径和 Recall `N/A` 原因。
- [x] 创建 10 条查询的试标草稿（5 条自然发现、5 条指定目标），保持 `draft` 且不运行。
- [x] 用户确认试标判断风格，创建收紧讲话、坐姿、实际打鼓和车辆行驶边界的 v2 草稿；
      回读确认仍为 `draft`，数量为 5 条自然发现 + 5 条指定目标。
- [x] 补充 8 张正式图片并完成 SigLIP2 与 Caption 索引；PostgreSQL 的 16 条图片向量引用
      与 Qdrant 的 8 个视觉 Point、8 个 Caption Point 数量一致。
- [x] 完成试标复核，建立并冻结 40 条基础查询 + 10 条忠实英文配对查询；图片、视频、
      4 个短场景和中英文配对完整性检查全部通过。
- [x] 运行同快照 current/RRF 召回，完成全部必标池候选盲标；修正后快照共 2,101 个
      诊断候选，指定目标及两种排序都在 Top-20 之外的项不需要人工等级。
      必标池为 686 条，686/686 全部完成，`unjudgeable` 为 0。
- [x] Web 增加按运行 ID 恢复盲标和已标/总数进度，支持刷新后分批继续评测。
- [x] 生成分类宏平均、通道诊断、失败案例和不可变 Top-K 快照报告。
- [x] 运行全量验证与双轴审查，使用中文信息提交当前分支。

Review：

- Result：Phase 8 已完成。正式 run `6298b745-d9d3-44bf-86a0-2d0a0b46360c`
  已进入 `reported`，686/686 必标候选完成，`unjudgeable` 为 0。中文自然发现
  Precision@5 从 0.5700 升到 0.6400，nDCG@10 从 0.6370 升到 0.7197；中文指定目标
  Hit@5 从 0.7500 升到 0.8000，MRR 从 0.6357 升到 0.7408，但 Hit@10 从 0.9000
  降到 0.8500，报告保留该限制。
- Notes：图片 Caption 已映射回源图片 Asset；current 与 RRF 使用同一正式必标池构造
  nDCG 理想分母，前 20 名外的 564 条额外判断只保留审计。`corepack pnpm check` 通过：
  Shared 6、Web 42、Server 136 项测试以及 Web 生产构建全部成功；Python Worker 73 项
  unittest 通过；规格与规范双轴复审均无剩余问题。Phase 9 多帧复核未提前实施。

## 视频检索重建 Phase 4：Caption 文本向量与 SigLIP2 模型一致性

- [x] Caption Asset、`caption_text_vectors` pending Vector Ref 和 `embed_text_asset` 继续使用阶段 2 的协议，不改写场景身份。
- [x] Caption 索引和同步查询统一使用 `paraphrase-multilingual-MiniLM-L12-v2`、384 维和有效 Token 平均池化。
- [x] Worker 在推理和写入前校验 Embedder 的模型名称、版本和向量维度；不匹配时任务失败且不写 Qdrant、不标记 `indexed`。
- [x] 图片、视频帧和同步查询统一切换到 `google/siglip2-base-patch16-224` / `siglip2-base-patch16-224`。
- [x] TypeScript Collection registry、Python 索引配置、Worker、模型服务和测试统一为 768 维 SigLIP2。
- [x] Qdrant 启动检查同时核对向量维度与 PostgreSQL Vector Ref 模型配置；模型变化即使维度相同也重建 Collection。
- [x] Qdrant Collection 缺失时，重建后把 PostgreSQL 引用重置为 `pending`，避免空 Collection 配合错误的 `indexed` 状态。
- [x] 忠实翻译模式继续让视觉通道只使用经过校验的英文译文，Caption 通道只使用中文原查询。
- [x] 在 CPU 与 Apple MPS 上运行真实 SigLIP2 冒烟测试，记录加载、首次/热推理、内存和中英文单样本消融。
- [x] 运行真实 Caption 文本模型测试，验证模型身份、384 维、MPS 和单位向量。
- [x] 更新 `.env.example`、README、任务协议、工具清单、向量索引设计和验证报告。

Review：

- Result：Phase 4 已完成。视觉 checkpoint 统一为 SigLIP2；Caption 保持独立多语言文本模型。新增模型身份守卫，解决“SigLIP 与 SigLIP2 都是 768 维，旧向量可能被误认为兼容”的根因；新增 Collection 丢失恢复，保证 PostgreSQL 状态与 Qdrant 真实 Point 一致。
- Real model：SigLIP2 CPU/MPS 均输出 768 维；CPU 峰值进程内存约 1.50 GiB，MPS 峰值约 0.86 GiB。Caption 文本模型输出 384 维，归一化向量 L2 范数为 1。详细数字、统计口径和限制见 `docs/superpowers/reports/2026-07-30-phase4-siglip2-caption-validation.md`。
- Tests：`corepack pnpm check` 通过，其中 Shared Schema 6 项测试、Web 39 项测试和生产构建、
  Server 109 项测试全部成功；`PYTHONPATH=apps/worker-py .venv/bin/python -m unittest discover
apps/worker-py/tests` 通过 73 项 Python 测试；`git diff --check` 通过。测试使用 fake
  PostgreSQL/Qdrant/VLM 覆盖失败恢复，真实模型数字单独记录在 Phase 4 验证报告中。

## 视频检索重建 Phase 5：搜索范围与 RRF

- Start：2026-07-30。目标是在正式视频场景候选上增加 `search_scope` 请求路由和
  `ranking_mode` 排序选择，并让生产搜索复用公共 RRF（Reciprocal Rank Fusion，
  倒数排名融合）实现。
- 验证计划：先增加失败测试，覆盖默认值、视觉/语音/全部范围、当前排序兼容、RRF
  多通道融合、场景去重、过滤后连续名次、稳定并列、Top-K 和分页；实现后运行
  Server/Web/Shared 全量检查、Python Worker 回归测试及 `git diff --check`。

- [x] Search API 增加 `search_scope=visual|spoken|all`，默认 `visual`。
- [x] Search API 增加 `ranking_mode=current|rrf`，默认 `rrf`。
- [x] `visual` 只调用 SigLIP2 视觉与可用的 Caption 通道，`spoken` 只查询转录全文，
      `all` 才同时执行三类召回。
- [x] 生产搜索复用公共 `rankByRrf`，按过滤后的连续来源名次计算 `1/(60+rank)`。
- [x] 图片使用 Asset ID、正式视频候选使用场景 UUID 作为稳定语义身份；同场景视觉与
      Caption 合并，不能依赖数据库偶然顺序。
- [x] RRF 结果保留来源原始分数，并在显式诊断模式返回各通道名次、贡献、最佳帧和时间。
- [x] 同步 Web API 类型、API 契约、README 和任务记录，不提前实现 Phase 6 搜索控件。
- [x] 运行完整验证与双轴代码审查，并记录 Review。

Review：

- Result：Phase 5 已完成。Search API 默认使用 `search_scope=visual` 和
  `ranking_mode=rrf`；`spoken` 完全跳过查询扩展、模型服务和 Qdrant，`all` 在 Caption
  开启时同时执行 visual、caption、lexical 三类召回。生产搜索复用公共 `rankByRrf`，
  视频视觉与 Caption 按正式场景 UUID 合并，图片和无场景 transcript 使用 Asset ID。
- Notes：RRF 在 PostgreSQL 过滤后重新生成连续通道名次，按 `1/(60+rank)` 计算贡献，
  最后执行稳定并列和分页；显式诊断返回通道名次、贡献和最佳帧时间。回表额外校验
  `Asset → File → Library`、场景文件归属和同场景边界一致性，拒绝跨文件/跨素材库脏引用。
  `corepack pnpm check` 通过：Shared Schema 6 项、Web 39 项及生产构建、Server 122 项测试；
  Python Worker 73 项测试通过；`git diff --cached --check` 通过。规格与工程规范双轴复核
  最终均无阻断问题。本阶段无数据库迁移、无模型重装或媒体重索引要求。

## 视频检索重建 Phase 6：核心 Web 搜索、任务反馈与评测运行层

- Start：2026-07-30。目标是让用户能在 Web 选择视觉、语音或全部范围以及当前/RRF
  排序；让媒体处理失败具备结构化详情和人工重试入口；并在最终 Search API、正式
  `video_scenes.id` 和公共指标函数之上重建可盲标、可冻结的评测运行层。
- 验证计划：先增加失败测试覆盖搜索控件、任务错误/重试、六张评测表、正式场景目标、
  运行失败原子性、证据隐藏和快照不可变；实现后运行 Server/Web/Shared/Python 全量检查、
  当前迁移 PGlite 空库验证、`git diff --check` 和双轴代码审查。

- [x] Web 搜索页显示搜索范围与排序方式，并把选择同步传给正式 Search API。
- [x] 诊断界面显示来源名次、RRF 贡献、场景边界和 SigLIP2 最佳帧时间。
- [x] Jobs 页面显示场景检测、抽帧、Embedding、Caption 结构化错误与人工重试入口。
- [x] 定义六张评测表并生成第二个开发迁移，PGlite 可从空库直接创建。
- [x] 指定目标使用正式 `video_scenes.id`，随机目标选择器不读取旧 video segment Asset。
- [x] 重建 Evaluation Controller、Service、Module、Web API Client 和 `/evaluation` 页面。
- [x] 评测复用正式 Search API、公共 RRF 证据与指标；完整性失败时整次运行失败。
- [x] 冻结查询版本、候选快照和盲标证据边界，完成最小 Fixture 回归测试。
- [x] 更新 API/架构文档，运行完整验证与双轴代码审查并记录 Review。

Review：

- Result：Phase 6 已完成。搜索页可明确选择视觉、语音或全部范围以及 current/RRF
  排序；诊断显示通道名次、RRF 贡献、场景边界和 SigLIP2 最佳帧。Jobs 页面显示结构化
  错误并以新任务重试。评测域已用六张表、正式场景 UUID、同一份生产搜索快照、盲标和
  公共指标重建，普通搜索路径改为相对路径，避免泄露本机绝对目录。
- Notes：开发迁移为 `0006_cloudy_shockwave.sql`；新环境由 PGlite 空库测试验证，已有本地
  PostgreSQL 需在启动前运行 `db:migrate`。完整检查通过：Shared 6 项、Web 41 项及生产
  构建、Server 127 项、Python Worker 73 项，Oxlint 与 `git diff --check` 通过。双轴审查
  首轮发现的媒体快照外键、current 独有候选、运行原子性、报告后改标、随机目标稳定性、
  视频目标缺场景、盲标操作不完整、绝对路径和模型任务结构化错误均已修复；Phase 7 的
  迁移压缩和正式基线样本未提前实施。

## 视频检索重建 Phase 7：唯一基线与本地服务/素材索引重建

- Start：2026-07-30。目标是把阶段 2～6 的开发迁移压缩为唯一 `0000`，证明空库可直接
  获得最终 Schema；然后只删除 PostgreSQL、Qdrant 和 `.media-agent/cache` 中可重建的
  派生数据，保留源媒体，恢复 SigLIP2、Caption、语音检索所需服务并重新索引。
- 安全边界：先做 dry-run 和服务端口检查；只操作 `.env` 指向的本地数据库、项目拥有的
  Qdrant Collection 和经过路径防护的缓存目录。不得删除源素材、Ollama 模型或 Hugging
  Face 模型缓存。
- 验证计划：压缩前后运行同一组 Schema/Repository 测试；新增唯一迁移和禁用旧结构断言；
  用全新 PGlite 与临时 PostgreSQL 执行基线；重建后分别核对 PostgreSQL 事实行、Qdrant
  Point、任务状态和 generation；最后运行全仓检查、Python 测试和双轴代码审查。

- [x] 记录压缩前 Schema/Repository 测试基线。
- [x] 删除开发迁移并从最终 Drizzle Schema 生成唯一 `0000`。
- [x] 验证基线无 OCR、video segment、旧 Collection、多帧任务或兼容列。
- [x] 人工核对外键、级联、唯一约束、generation、任务 claim 和六张评测表。
- [x] 在全新 PGlite 和临时 PostgreSQL 执行唯一基线。
- [x] dry-run 核对本地 PostgreSQL、Qdrant、缓存与受保护源素材范围。
- [x] 确认本地派生数据已为空，应用唯一基线并创建 SigLIP2/Caption Collections。
- [x] 恢复 Server、模型服务、Worker、VLM、Ollama 和 Web，并重新添加/扫描素材库。
- [x] 等待索引任务完成并执行 Phase 7 完整性检查。
- [x] 更新文档、运行全量验证与双轴审查，使用中文信息提交当前分支。

Review：

- Result：通过。唯一 `0000` 在 PGlite 和临时 PostgreSQL 16 中均可直接创建最终 15
  张表；基线不含 OCR、`video_segment`、旧 Collection、多帧任务或兼容列。真实重建得到
  15/15 个 indexed 视频、1073 个当前场景、3024 个视频帧、3024 条 SigLIP2 引用和
  1073 条 Caption 引用。PostgreSQL 的 4097 条 indexed 引用与 Qdrant 的 4097 个 Point
  逐条匹配，缺场景、缺帧、缺当前模型向量、错误 generation、旧引用和 pending/failed
  引用均为 0。
- Notes：13 条 Caption 超时记录均已有成功重试；1 条无音轨视频的转录失败按事实保留，
  不影响视觉与 Caption 索引。真实中文搜索同时返回 `vector_match` 和 `caption_match`，
  Jobs Web 分页可展示失败记录。最终验证通过 Server 131、Web 41、Shared 6、Python 73
  个测试及 Next.js 生产构建。双轴审查发现并修复 PostgreSQL 微秒游标精度和权威文档
  漂移问题，复审通过；未创建 Phase 8 的评测样本、指标报告或候选快照。

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
- [x] 增加 seeded 随机目标抽样，一批最多 20 个、图片/视频尽量平衡且同一视频最多一个 scene；文件搜索保留为辅助入口。
- [x] 完成审查修复后的最终全量验证与提交。

Review：

- Result：评测 MVP 已形成数据库、server、web 与文档闭环；生产 `/search` 排序保持不变。独立代码审查发现的深层候选、scene 对齐、current rank、盲标绕过、版本与恢复入口问题已在提交前修正。
- Notes：独立 Standards/Spec 双轴审查先发现来源状态、深层候选、scene 对齐、current 对照、盲标绕过和版本/恢复入口问题，修复后 Spec 复核无阻塞项。最终 `corepack pnpm check` 通过：shared 5、web 36、server 88 个测试及 Next 生产构建成功；`corepack pnpm lint` 通过。Oxfmt 已格式化本次涉及文件；全仓 `format:check` 仍报告 18 个未改动既有文件的历史格式差异，未扩大范围重写。真实 PostgreSQL migration 由维护者按既有手动流程执行，本次未直接修改本机数据库。
