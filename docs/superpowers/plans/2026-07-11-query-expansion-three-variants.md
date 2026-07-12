# Query Expansion Three Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认只使用三个搜索词变体（包含原始查询），并记录搜索阶段耗时。

**Architecture:** Settings 负责校验上限，QueryExpansionService 同时约束 prompt 与模型响应，SearchService 编排层记录阶段耗时。服务端截断保证外部模型返回超量数据时仍不会放大查询次数。

**Tech Stack:** NestJS、TypeScript、Zod、Vitest。

## Global Constraints

- 默认上限为 3，且包含原始查询。
- 上限允许 1 到 10。
- 不记录 API key、查询向量或本地媒体内容。
- 不更改 hybrid score 语义。

---

### Task 1: 配置、截断、耗时和文档

**Files:**
- Modify: `apps/server/src/config/settings.ts`
- Modify: `apps/server/src/search/query-expansion.service.ts`
- Modify: `apps/server/src/search/search.service.ts`
- Modify: `apps/server/tests/settings.test.ts`
- Modify: `apps/server/tests/search/search.service.test.ts`
- Modify: `.env.example`
- Modify: `docs/api-contract.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: `Settings.queryExpansionMaxVariants: number`
- Consumes: `QUERY_EXPANSION_MAX_VARIANTS`, default `3`

- [x] **Step 1: 写失败测试**

增加 settings 默认值/显式值/非法值测试，并让 DeepSeek mock 返回超过上限的候选，断言 embedding 只收到三个不同文本且包含原始查询。

- [x] **Step 2: 运行测试确认 RED**

Run: `corepack pnpm --filter @local-media-agent/server exec vitest run tests/settings.test.ts tests/search/search.service.test.ts`

Expected: 因配置字段和三变体截断尚不存在而 FAIL。

- [x] **Step 3: 实现最小生产代码**

在 Zod settings 增加 `1..10` 整数配置；prompt 使用配置上限；归一化结果按该上限截断。使用单调时钟记录 expansion 和搜索各阶段耗时。

- [x] **Step 4: 更新文档**

在 `.env.example`、API contract 和 `AGENTS.md` 声明默认三个变体且包含原始查询。

- [x] **Step 5: 验证 GREEN**

Run: `corepack pnpm --filter @local-media-agent/server check`

Run: `corepack pnpm lint && git diff --check`

Expected: 全部退出码为 0。
