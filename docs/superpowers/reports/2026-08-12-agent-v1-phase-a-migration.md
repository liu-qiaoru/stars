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
