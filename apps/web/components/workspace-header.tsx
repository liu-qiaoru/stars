import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 产品工作台的统一页头。
 *
 * 页面名称和一句用途说明组成两层信息；右侧只承载当前页面的主要操作。具体功能名称留在
 * 下方卡片中，避免“栏目标签 → 页面标题 → 卡片标题”连续堆叠。
 */
export function WorkspaceHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="workspace-header">
      <div className="workspace-header-main">
        <span className="workspace-header-icon" aria-hidden="true">
          <Icon size={21} strokeWidth={1.8} />
        </span>
        <div className="workspace-header-copy">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      {actions ? <div className="workspace-header-actions">{actions}</div> : null}
    </header>
  )
}
