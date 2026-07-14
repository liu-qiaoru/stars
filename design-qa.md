# 搜索设置浮层 Design QA

- Source visual truth: `docs/design-qa/2026-07-14-search-settings/00-source-option-2.png`
- Default implementation screenshot: `docs/design-qa/2026-07-14-search-settings/01-default.png`
- Open-state implementation screenshot: `docs/design-qa/2026-07-14-search-settings/02-settings-open.jpeg`
- Full-view comparison: `docs/design-qa/2026-07-14-search-settings/03-source-vs-implementation.png`
- Viewport: 1224 × 768（对比图去除了实现截图顶部 98px 的浏览器界面）
- State: `/search` 空结果页，搜索设置浮层打开

## Full-view comparison evidence

对比图左侧为用户选择的第二个设计方向，右侧为实际实现。两者都把查询方式和诊断开关从普通筛选行移入搜索框右侧的单一设置入口；浮层锚定在入口下方，结果区保持可见，没有增加新的页面区域或卡片嵌套。实际页面沿用全站既有主容器宽度和紧凑密度，因此标题区比生成稿略矮；这是为了避免只修改搜索页而破坏全站一致性。

## Focused region comparison evidence

没有额外裁切图。全尺寸对比图中的两个浮层文字、单选圆点、分隔线和开关均可读，已经足以检查本次唯一新增区域；实现截图原图同时保留在 `02-settings-open.jpeg`，可用于查看像素级细节。

## Required fidelity surfaces

- Fonts and typography: 沿用项目现有 Inter/系统字体栈；标题、选项标题和 13px 辅助说明形成与设计稿一致的三级层级，没有文本截断。
- Spacing and layout rhythm: 搜索框与 48px 设置按钮保持 12px 间距；浮层宽 360px，选项采用纵向节奏，诊断开关通过单条分隔线与查询方式区分。
- Colors and visual tokens: 完全复用项目黑、白、灰、hairline 和 focus token；只有浮层使用一次必要的阴影，未新增配色体系。
- Image quality and asset fidelity: 该界面没有栅格内容资产；搜索、调节和媒体图标均来自项目已经使用的 Lucide 图标库，没有占位图或自制 SVG。
- Copy and content: “仅原查询”“忠实翻译”“完整扩展”和“显示检索诊断”与实际 API 行为对应；辅助文案解释了每个模式会做什么。

## Interaction and runtime checks

- 设置按钮打开浮层：真实 Chrome 中通过。
- 查询方式从“完整扩展”切换到“忠实翻译”：真实 Chrome 中通过，辅助功能树确认选中值由 0 变为 1。
- “显示检索诊断”开关：真实 Chrome 中通过，辅助功能树确认值由 0 变为 1。
- Escape 关闭与请求参数传递：由 Vitest 自动化测试覆盖。
- 搜索请求未在浏览器中实际提交，避免触发外部查询扩展调用；请求字段由测试验证。
- 浏览器未出现 Next.js 错误覆盖层；控制台面板没有作为本次视觉验收的通过依据。

## Comparison history

1. 首次实现截图与选中设计并排检查：信息层级、浮层位置、宽度、控件顺序和黑白视觉语言一致，没有发现 P0、P1 或 P2 差异。
2. 有意保留的产品差异：实现默认选择“完整扩展”，而生成稿示例选择“仅原查询”；这是保留现有搜索默认行为，不是视觉缺陷。

## Findings

没有仍需处理的 P0、P1 或 P2 问题。

## Follow-up polish

- P3：生成稿的标题区更高，但实现继续遵循现有应用密度；如果未来统一放大所有页面标题区，应在全站设计调整中处理。

final result: passed
