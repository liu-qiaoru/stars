# Library File Browser and Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为扫描、导航和素材库文件浏览提供明确反馈。

**Architecture:** NestJS 提供 library-scoped 分页文件接口；LibraryWorkspace 在展开时按需加载；AppShell 读取 pathname 计算 active 样式。所有列表请求都有明确分页和错误状态。

**Tech Stack:** NestJS、Drizzle、PGlite、Next.js 16、React 19、Vitest。

## Global Constraints

- 文件列表默认折叠，首次展开才请求。
- 默认每页 25 条，服务端最大 100。
- 扫描成功跳 `/jobs`，失败不跳转。
- 当前路由必须有 `aria-current='page'`。

---

### Task 1: 素材库文件分页 API

**Files:** `apps/server/src/database/repositories.ts`、`apps/server/src/libraries/libraries.service.ts`、`apps/server/src/libraries/libraries.controller.ts`、`apps/server/tests/libraries/libraries.controller.test.ts`

- [x] 写分页、排序、404 和参数校验失败测试并确认 RED。
- [x] 实现 repository/service/controller。
- [x] 运行 libraries 测试确认 GREEN。

### Task 2: API client 与素材库折叠列表

**Files:** `apps/web/lib/api-client.ts`、`apps/web/components/library-workspace.tsx`、`apps/web/tests/api-client.test.ts`、`apps/web/tests/library-workspace.test.tsx`、`apps/web/app/globals.css`

- [x] 写按需加载、加载更多、失败重试、扫描跳转测试并确认 RED。
- [x] 实现 typed client 和组件状态。
- [x] 运行目标 Web 测试确认 GREEN。

### Task 3: 当前路由高亮

**Files:** `apps/web/components/app-shell.tsx`、`apps/web/tests/app-shell.test.tsx`、`apps/web/app/globals.css`

- [x] 写 libraries/search/jobs/agent active 状态测试并确认 RED。
- [x] 使用 `usePathname()` 设置 class 与 `aria-current`。
- [x] 运行 AppShell 测试确认 GREEN。

### Task 4: 文档与验证

- [x] 更新 `docs/api-contract.md` 和 `AGENTS.md`。
- [x] 运行 server check、web check、lint 和 `git diff --check`。
