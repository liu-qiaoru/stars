# 素材库文件浏览与导航反馈设计

## 目标

扫描成功后跳转任务页；导航高亮当前路由；素材库卡片默认折叠并按 25 条分页浏览文件。

## 设计

- 新增 `GET /libraries/:id/media?limit=25&offset=0`，只返回 active 文件，按 `relative_path,id` 稳定排序。
- 响应包含 `id`、`relative_path`、`media_type`、`index_status` 及分页字段。
- 素材库卡片默认不请求文件；展开后加载第一页，点击“加载更多”追加下一页；折叠不清空缓存。
- 文件行链接 `/media/:id`；移动端使用紧凑行，不依赖固定表格宽度。
- 扫描按钮请求期间禁用，成功 `router.push('/jobs')`，失败保留当前页并显示错误。
- AppShell 根据 `usePathname()` 高亮主导航；`/agent` 高亮 Ask。

## 错误与规模约束

- limit 允许 1..100，offset 必须为非负整数，非法参数返回 400。
- library 不存在返回 404。
- 加载失败保留已有文件并提供重试，不一次性加载全库。
