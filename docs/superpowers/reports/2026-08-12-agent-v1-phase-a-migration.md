# Agent V1 Phase A 数据库迁移说明

> 日期：2026-08-12
> 迁移：`apps/server/drizzle/0001_agent_v1_phase_a.sql`
> 边界：只修改 PostgreSQL 中的 Agent 协议和审计事实；不修改 Qdrant，不删除源媒体，不需要重新索引或重新评测。

## 结论

Phase A 保留已经应用过的 `0000_final_baseline.sql` 不变，新增一个增量迁移 `0001`。
增量迁移是让已有数据库只执行尚未应用的变更，而不是删库后重建。

应用后：

- `agent_runs` 新增租约、`lease_version`、`next_step`、等待到期和脱敏错误字段。
- 新增 `agent_run_steps`，保存每次 `step_attempt_id`、输入指纹和外部派发状态。
- 新增 `agent_run_inputs`，使用 `(run_id, client_request_id)` 唯一约束防止重复恢复/取消/重试。
- 新增 `agent_run_authorizations`，分开保存文本与视觉授权。
- 新增 `agent_run_candidates`，为 Phase B 冻结候选身份和 `file_generation`。
- 新增 `agent_side_effects`，为 Phase C 的唯一副作用幂等键建立数据库边界。Phase A 不创建副作用。

## 已有 Agent 数据如何处理

历史 `succeeded` / `failed` run 和事件、tool call 审计行全部保留。

迁移不尝试恢复旧 `running` 或 `waiting_for_confirmation` run。原因是旧运行没有
`step_attempt_id`、`lease_version` 和逐 run 授权，无法判断 Provider 是否已调用，也无法安全区分
两个并发确认。这些旧活动 run 会明确改为：

```text
status = failed
error_code = AGENT_LEGACY_RUN_NOT_RECOVERABLE
```

每条历史 run 会补一条文本/视觉均为 `false` 的授权记录。迁移不会根据旧
`ALLOW_EXTERNAL_LLM` 全局开关猜测用户曾经授权。

## 应用方法

迁移会修改真实 PostgreSQL，因此应由维护者在启动新 Server 前手动执行：

```bash
corepack pnpm --filter @local-media-agent/server db:migrate
```

Server 的 `dev` 命令不会自动运行迁移。如果跳过该步，启动时 Schema Guard
（结构守卫，用来检查必要表是否存在）会因 Phase A 事实表缺失而快速失败，
并显示上述迁移命令，不会等到第一个 Agent API 请求才报 SQL 错误。

## 验证和回滚边界

自动化验证使用 PGlite（进程内 PostgreSQL 兼容数据库）分别确认：

1. `0000` 仍能单独创建原 15 张表。
2. 按顺序应用 `0000 + 0001` 后得到 20 张表。
3. `agent_runs` 包含租约、版本、下一步和等待到期字段。
4. 所有 Server 数据库集成测试都会从空库按相同顺序应用迁移。

活动执行硬超时由 Server 配置 `AGENT_ACTIVITY_TIMEOUT_MS` 控制，默认 120000 毫秒。
它不新增迁移字段：活动起点复用 `agent_run_steps.started_at`，到期时 run、step 和事件在
同一事务内写入。`AGENT_LEASE_DURATION_MS` 必须大于活动超时，避免正常执行先被租约接管。

本项目的 Drizzle Migration 不提供自动 down migration（向下迁移）。如果需要回退真实数据库，
应在应用前先创建 PostgreSQL 备份，然后恢复备份；不应手工删列猜测回退顺序。

## 2026-08-12 真实数据库原地迁移审计

Phase B 编码前已对真实 PostgreSQL 执行原地基线对齐。只读核对证明旧库的 15 张表、
171 个列定义、40 个索引和 16 个外键与 `0000_final_baseline` 快照等价；迁移登记仍是
压缩前的 6 条历史记录，因此没有直接运行迁移工具，避免它把 `0000` 当成未执行迁移。

修改迁移登记前创建了 PostgreSQL custom-format 备份：

```text
.media-agent/backups/agent-v1-phase-a-pre-migration-20260812.dump
SHA-256: fdcee372d86d82ac0d2c6476864a3455c774aae262ffa63805e950ddbd8d64ec
```

`pg_restore --list` 已验证备份目录可读。恢复时应先停止 Server 和 Worker，把备份复制进
PostgreSQL 容器，再对目标库执行 `pg_restore --clean --if-exists --no-owner`。该操作会覆盖
数据库，因此只能在明确回退时执行，不能用于日常重跑迁移。

基线对齐在一个 PostgreSQL 事务中完成，并用“最后一条旧迁移时间戳、现有表数、Phase A
表不存在”三个条件保护：只登记 SHA-256 为
`b883043172354490b1f6039575b665a5f2562dc43f6667a0f047edbfdbd135b5` 的等价 `0000`，随后
正常执行 SHA-256 为
`70bbcb50f635e44490feb874fc23571e8bfb5397b54e72c60f11b8e401b0abc6` 的
`0001_agent_v1_phase_a`。迁移后共有 20 张表、236 个列定义、55 个索引和 22 个外键，
与 `0001` 快照一致。

| 事实 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| `libraries` | 1 | 1 |
| `media_files` | 35，全部 `indexed` | 35，全部 `indexed` |
| `media_assets` | 7,940 | 7,940 |
| `video_scenes` | 1,919 | 1,919 |
| `vector_refs` | 7,564，全部 `indexed` | 7,564，全部 `indexed` |
| `jobs` | 9,910 | 9,910 |
| 5 张新增 Agent 表中的行 | 0 | 0 |

Qdrant 的 `image_vectors=8`、`video_frame_vectors=5,629`、
`caption_text_vectors=1,927`，合计 7,564 个 Point，迁移前后完全一致。整个过程没有删除或
重建 PostgreSQL、没有修改 Qdrant、没有触发扫描/索引/评测，也不需要媒体回填。
