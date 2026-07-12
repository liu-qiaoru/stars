# CLAUDE.md

本仓库的项目事实、开发命令、运行拓扑、架构约束和协作原则统一维护在 `AGENTS.md`。

开始任何工作前必须完整阅读并遵守 `AGENTS.md`。不要在本文件复制架构内容；项目演进时只更新 `AGENTS.md`，避免两份说明漂移。

## Agent skills

### Issue tracker

需求、规格与实施 issues 使用仓库内 `.scratch/` 本地 Markdown 管理，不使用外部 PR 作为需求入口。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认状态词汇：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用 single-context 领域文档布局，共享根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。
