# Indexed Count and Agent Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复素材库已索引数量并移除重复 Agent 导航。

**Architecture:** PostgreSQL `media_files.index_status` 继续作为文件级事实状态。Python embedding repository 在 vector ref 成功时推进 file 状态；数据迁移回填历史状态；前端只保留 Ask 入口。

**Tech Stack:** PostgreSQL、Python 3.12、NestJS/PGlite、Next.js/Vitest。

## Global Constraints

- 至少一个 active indexed vector ref 即代表文件已索引。
- vector ref 与 file 状态更新必须在同一事务提交。
- 历史数据必须回填。
- Ask 保留，主导航“助手”移除。

---

### Task 1: 索引状态推进与历史回填

**Files:**
- Modify: `apps/worker-py/media_agent_worker/repository.py`
- Modify: `apps/worker-py/tests/test_embedding_worker.py`
- Create: `apps/server/drizzle/0002_backfill_indexed_media_files.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/tests/libraries/libraries.controller.test.ts`
- Modify: `docs/job-protocol.md`

**Interfaces:**
- Consumes: `mark_vector_ref_indexed(point_id)`
- Produces: `media_files.index_status='indexed'` after the first successful active vector

- [x] **Step 1: 写失败测试并确认 RED**
- [x] **Step 2: 在同一事务推进 ref 与 file 状态**
- [x] **Step 3: 增加历史数据迁移和迁移测试**
- [x] **Step 4: 运行 Python 与 server 测试确认 GREEN**

### Task 2: 移除重复助手导航

**Files:**
- Modify: `apps/web/components/app-shell.tsx`
- Modify: `apps/web/tests/app-shell.test.tsx`

**Interfaces:**
- Produces: 主导航仅包含素材库、搜索、任务；Ask 仍指向 `/agent`

- [x] **Step 1: 写失败测试并确认 RED**
- [x] **Step 2: 删除 navItems 中的助手项和无用 Bot import**
- [x] **Step 3: 运行 Web 测试确认 GREEN**

### Task 3: 全量验证

- [x] **Step 1: 运行 server check、web check 和 Python tests**
- [x] **Step 2: 运行 lint 与 git diff --check**
