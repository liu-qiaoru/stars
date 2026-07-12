# 已索引统计与 Agent 导航去重设计

## 目标

移除与 Ask 重复的“助手”导航入口，并修复素材库 `indexed_count` 永远为 0。

## 根因

`getLibraryMediaCounts()` 按 `media_files.index_status='indexed'` 统计；probe 只写 `probed`，embedding 完成只写 `vector_refs.status='indexed'`，没有代码推进 file 状态。因此即使 Qdrant 已可搜索，文件仍停留在 `probed`。

## 设计

- 保留右上角 Ask，删除主导航 `/agent` 的“助手”项。
- `mark_vector_ref_indexed(point_id)` 在同一事务中先更新 vector ref，再把其 `file_id` 对应的 active 文件标记为 `indexed`。
- 语义固定为：一个文件只要存在至少一个成功写入 Qdrant 的 active indexed vector ref，即为已索引。
- 新增数据迁移，回填所有已有 active indexed refs 对应的 active media files。
- 保留 library 统计读取 `media_files.index_status`，避免前端、API 和 detail 使用不同事实来源。

## 验收

- embedding 成功后 file 从 `probed` 变成 `indexed`。
- 迁移后历史 indexed vector ref 对应文件变为 `indexed`。
- 素材库 `indexed_count` 正确增加。
- 主导航没有“助手”，Ask 仍链接 `/agent`。
