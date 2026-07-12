# 搜索词扩展三变体设计

## 目标

将在线搜索词变体默认上限从 5 降为 3，且 3 包含用户原始查询，以减少同步 embedding 与 Qdrant 查询次数。

## 设计

- 新增 `QUERY_EXPANSION_MAX_VARIANTS`，默认 `3`，允许范围 `1..10`。
- `QueryExpansionService` 的 prompt 和服务端归一化都使用该配置；服务端截断是事实边界，不能信任模型严格遵守 prompt。
- 原始查询始终进入结果并保持权重 `1`；其余候选去空、去重、按权重降序后截断。
- 查询扩展日志记录配置上限和扩展耗时；搜索总链路记录 expansion、vector、FTS、hybrid 和 total 毫秒数，不记录 API key 或媒体内容。
- 更新 `.env.example`、API contract 和 `AGENTS.md`，保持 Living Documentation。

## 验收

- DeepSeek 返回 5 个不同短语时，最终只执行 3 个变体，并包含原始查询。
- 配置缺省为 3；非法范围启动失败。
- provider 为 `none` 时仍只返回原始查询。
- Server typecheck、搜索/设置测试和 lint 通过。
