# Agent V1 Phase E 迁移记录

## 结论

2026-08-12 已在本地 PostgreSQL 备份后应用 Phase E 增量迁移
`0003_happy_morlun.sql`。迁移只新增影子重排事实和 Evaluation 查询的冻结范围，
没有更新媒体、候选或向量数据。不需要回填、重新搜索、重新抽帧、重新索引
或重新评测。

## 迁移内容

- `evaluation_queries.search_scope`：可空的人工冻结检索范围。旧数据保持 null，
  Phase E 不会根据文本猜测为可外发视觉查询。
- `evaluation_shadow_runs`：每个 Evaluation run/协议的总状态、Provider/模型、
  实际样本数、token、字节、耗时、费用和结构化错误。
- `evaluation_shadow_attempts`：每条查询的唯一幂等尝试、dispatched/恢复边界、
  Provider request ID、请求/响应模型、区域、指纹和用量。
- `evaluation_shadow_rankings`：成功尝试的完整 20 个 RRF 候选，以及其中
  Top-10 的影子名次和 `relevance_score`。

## 备份与数量核对

迁移前备份位于 `.media-agent/backups/agent-v1-phase-e-pre-migration-20260812.dump`，
是约 3.6 MiB 的 PostgreSQL custom-format 备份。该本地运行数据不进入 Git。

迁移后只读核对：

| 事实 | 数量 | 含义 |
| --- | ---: | --- |
| Drizzle migration | 10 | Phase E 增量迁移已记录 |
| Library | 1 | 素材库数不变 |
| Media file / active indexed | 35 / 35 | 活动文件全部仍可检索 |
| Asset | 7,940 | 派生媒体单元不变 |
| Video scene | 1,919 | 正式视频场景不变 |
| Indexed Vector Ref | 7,564 | PostgreSQL 向量引用不变 |
| Job | 9,915 | 迁移没有创建 Worker Job |
| Agent candidate | 20 | 普通 Agent 候选不变 |
| Candidate evidence | 8 | Phase D 本地证据不变 |
| Shadow run / attempt / ranking | 0 / 0 / 0 | 未授权真实运行，无影子评测结果 |

Qdrant 三个 Collection 的 Point 数仍为：

- `image_vectors=8`
- `video_frame_vectors=5,629`
- `caption_text_vectors=1,927`
- 合计 `7,564`

这与迁移前一致，证明 Phase E 没有写 Qdrant。本次真实 Provider 请求、
本地图片外发和费用均为 0；因此当前没有可报告的真实 RRF/影子指标结果。
