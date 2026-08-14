import Link from 'next/link'

/**
 * Evaluation 页面共享的层级导航。最后一项表示当前位置，前面的项目都是可见返回路径；
 * 使用有序列表让屏幕阅读器能按页面层级朗读，而不是把斜杠当作正文。
 */
export function EvaluationBreadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>
}) {
  return (
    <nav
      aria-label="面包屑"
      className="w-fit max-w-full rounded-xl border border-neutral-200/80 bg-white/85 px-2 py-2 shadow-sm backdrop-blur"
    >
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {items.map((item, index) => {
          const current = index === items.length - 1
          return (
            <li key={`${item.label}:${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-neutral-400"
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              ) : null}
              {item.href && !current ? (
                <Link
                  href={item.href}
                  className="rounded-lg px-2.5 py-1.5 font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={current ? 'page' : undefined}
                  className="truncate rounded-lg bg-blue-50 px-2.5 py-1.5 font-semibold text-blue-800"
                >
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
