# Issue tracker：本地 Markdown

本仓库的需求、规格和实施 issues 统一保存为 `.scratch/` 下的 Markdown 文件。

## 约定

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 功能规格保存为 `.scratch/<feature-slug>/PRD.md`。
- 实施 issue 保存为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 每个 issue 在文件顶部附近使用 `Status:` 记录状态；状态名称见 `triage-labels.md`。
- 评论和讨论历史追加到文件末尾的 `## Comments`。
- 技能要求“发布到 issue tracker”时，应创建或更新上述本地文件，不调用远端 tracker。
- 技能要求“读取 ticket”时，应读取用户给出的本地路径或对应编号文件。

## Wayfinding 约定

- Map：`.scratch/<effort>/map.md`。
- 子 ticket：`.scratch/<effort>/issues/<NN>-<slug>.md`。
- 子 ticket 使用 `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`。
- 子 ticket 使用 `Status:` 记录 `claimed` 或 `resolved`。
- `Blocked by:` 保存阻塞 ticket 编号；所列 ticket 全部 resolved 后才视为解除阻塞。
- 认领时先写入 `Status: claimed`；完成时追加 `## Answer` 并写入 `Status: resolved`，随后更新 map 的 Decisions-so-far。
