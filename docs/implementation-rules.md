# 实施规则

## 目标

本文档记录项目进入实施阶段后的执行规则。后续代码实施必须遵守这些规则，除非用户明确修改。

## 分阶段推进

- 按 `docs/tasks/todo.md` 的 Phase 顺序执行。
- 每个 Phase 完成后停止，向用户汇报变更、验证结果和遗留风险。
- 未获得用户确认前，不进入下一个 Phase。
- 如果某个 Phase 内发现设计与现实冲突，先更新文档和任务清单，再继续实施。

## 进度记录

- 每次开始一个 Phase 前，在 `docs/tasks/todo.md` 的对应 Phase 下记录开始时间和目标。
- 每完成一个任务项，勾选对应 checkbox。
- 每个 Phase 的 `Review` 区域必须记录：
  - `Result`：完成了什么。
  - `Notes`：验证结果、已知问题、后续衔接点。
- 如果任务中断，下一次恢复时先读取：
  - `docs/tasks/todo.md`
  - `docs/tasks/lessons.md`
  - 当前 Phase 相关设计文档
  - `git status`

## 代码注释规则

- 关键步骤需要增加清晰、足够完整的注释，方便不熟悉 Python、TypeScript server、数据库和 SDK 的读者 review、接手和排查。
- 注释的默认目标读者是：理解本项目目标，但不一定熟悉 NestJS、Drizzle、PostgreSQL raw SQL、Qdrant client、Python worker、FFmpeg/ffprobe 或模型 SDK 的维护者。
- 必须注释的区域：
  - 跨语言边界，例如 TypeScript job creation 与 Python worker claim。
  - Python worker 的 job handler、repository/helper、外部命令或 SDK 调用入口。
  - NestJS module/controller/service/provider 的职责边界，尤其是为何某段逻辑放在 server 而不是 worker。
  - Drizzle schema/repository 与 Python raw SQL 访问同一张表时的字段约定。
  - PostgreSQL job claim、下游 job 触发、幂等 upsert、事务边界和状态流转。
  - Qdrant point id、payload、`vector_refs` 的幂等写入逻辑。
  - job heartbeat、超时回收、graceful shutdown。
  - FFmpeg 命令构造和安全边界。
  - ffprobe、Qdrant、Vercel AI SDK、embedding/model SDK 等第三方工具调用时的关键参数含义。
  - query embedding RPC 与批量 embedding job 的区别。
  - Agent tool routing 的规则和 fallback。
- 注释应优先解释：
  - 这段代码在整体链路中的位置，例如“API 创建 job、worker 执行 job、Qdrant 只存轻量 payload”。
  - 为什么使用这个工具/API/SQL 写法，例如 `FOR UPDATE SKIP LOCKED`、deterministic point id、raw SQL helper。
  - 输入输出字段与协议文档的对应关系，尤其是跨 TS/Python 的 JSON 字段名。
  - 幂等、重试、失败、超时、取消、隐私和本地文件安全边界。
  - 后续 Phase 不应该在这里提前承担的职责。
- 不写空泛注释，也不要机械重复代码表面含义。例如不要写“调用函数 X”，应写“这里用 X 保证同一个 worker claim 后其他 worker 不会重复执行同一个 job”。
- 对简单纯函数、显而易见的 getter/setter、测试中的普通 arrange/assert，不需要为了凑数量写注释。

## 验证规则

- 每个 Phase 必须有可运行验证。
- 能写测试的地方优先写测试，再实现。
- 如果某个验证因为依赖未安装、环境缺失或外部工具缺失无法运行，必须在 Phase Review 中记录原因和风险。
- 不能把“代码已写完”当作完成标准，必须有事实验证。

## 文档同步规则

- 实施中发现架构、API、job protocol、向量索引或任务步骤变化时，同步更新相关文档。
- 用户纠正或 review 反馈形成稳定规则时，更新 `docs/tasks/lessons.md`。
- 不允许代码实现与文档长期不一致。

## 变更边界

- 每个 Phase 只做该 Phase 必需内容。
- 不引入未要求的功能。
- 不提前实现后续 Phase 的完整能力，除非它是当前 Phase 的必要基础。
- 不删除用户已有文件或无关内容。

## 恢复执行规则

任务中断后恢复时，先完成以下检查：

```text
1. 读取 docs/tasks/todo.md，确认当前 Phase 和已完成项。
2. 读取 docs/tasks/lessons.md，应用已记录经验。
3. 读取当前 Phase 相关架构/API/协议文档。
4. 运行 git status，确认工作区变化。
5. 从第一个未完成 checkbox 继续。
```

恢复后如果发现文档和代码不一致，先向用户报告并提出修正方案。
