# Agent V1 Phase D 数据库迁移记录

日期：2026-08-12

## 结论

Phase D 只应用了新增 `candidate_evidence` 表的增量迁移
`0002_agent_v1_phase_d_candidate_evidence.sql`。没有删除、重建或清空 PostgreSQL 表，没有写入
Qdrant，没有重新扫描或重新索引媒体。迁移后 `candidate_evidence=0`，表示本次只建立能力，没有
用真实媒体自动生成证据。

## 迁移前保护

- PostgreSQL 与 Qdrant 容器均处于运行状态；PostgreSQL 健康检查为 healthy。
- 先创建 PostgreSQL 自定义格式完整备份：
  `.media-agent/backups/agent-v1-phase-d-pre-migration-20260812.dump`，大小 3.6 MB。
- 首次受限环境执行 Drizzle 时因沙箱拒绝连接本机 `127.0.0.1:5432` 而退出，错误为
  `connect EPERM`；只读 SQL 证明目标表尚未创建、数据库无迁移锁，因此没有部分提交。
- 获准连接本机 PostgreSQL 后，同一 Drizzle 命令成功；再次执行仍成功且没有重复建表，证明迁移
  登记和幂等边界正常。迁移登记数从 8 增至 9。

## PostgreSQL 数量核对

所有核对查询都在 `BEGIN READ ONLY ... ROLLBACK` 只读事务中执行。

| 事实 | 迁移前 | 迁移后 | 变化 |
| --- | ---: | ---: | ---: |
| libraries | 1 | 1 | 0 |
| media_files | 35 | 35 | 0 |
| active 且 indexed 的 media_files | 35 | 35 | 0 |
| media_assets | 7,940 | 7,940 | 0 |
| video_scenes | 1,919 | 1,919 | 0 |
| indexed vector_refs | 7,564 | 7,564 | 0 |
| jobs | 9,910 | 9,910 | 0 |
| agent_run_candidates | 20 | 20 | 0 |
| candidate_evidence | 不存在 | 0 | 新表为空 |

## Qdrant 数量核对

Qdrant 是向量数据库，`points_count` 表示每个 Collection（向量集合）中的 Point（向量记录）数量。
Phase D 不需要向量，因此三个数值必须保持不变；本次只读 HTTP 核对结果如下。

| Collection | 迁移前 Point | 迁移后 Point | 变化 |
| --- | ---: | ---: | ---: |
| image_vectors | 8 | 8 | 0 |
| video_frame_vectors | 5,629 | 5,629 | 0 |
| caption_text_vectors | 1,927 | 1,927 | 0 |

三个 Collection 合计 7,564 个 Point，与 PostgreSQL 中 `status='indexed'` 的 Vector Ref 数量一致。

## 后续数据要求

不需要回填、重新扫描或重新索引。普通 Agent 页面只有在用户明确点击“准备本地证据”时才创建
证据 Job；正式 Evaluation 也只为明确触发的候选建立长期冻结证据。Phase D 没有 Rerank、VLM
审核或任何外部 Provider 调用。
