import Link from 'next/link'
import { Bot, Briefcase, Film, Folder, Search, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { HealthIndicator } from './health-indicator'

const navItems = [
  { href: '/libraries', label: '素材库', icon: Folder },
  { href: '/search', label: '搜索', icon: Search },
  { href: '/jobs', label: '任务', icon: Briefcase },
  { href: '/media/demo', label: '媒体', icon: Film },
  { href: '/agent', label: '助手', icon: Bot },
]

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--surface-soft)] text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--hairline)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link href="/search" className="flex items-center gap-2 font-bold text-[var(--primary)]">
            <span className="grid size-10 place-items-center rounded-full bg-[var(--primary)] text-white">
              媒
            </span>
            <span className="hidden sm:inline">媒体助手</span>
          </Link>
          <nav aria-label="主导航" className="ml-auto flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <Link key={item.href} href={item.href} className="nav-pill" aria-label={item.label}>
                  <Icon aria-hidden="true" size={16} />
                  <span className="hidden md:inline">{item.label}</span>
                </Link>
              )
            })}
          </nav>
          <HealthIndicator />
          <Link href="/agent" className="primary-action">
            <Sparkles aria-hidden="true" size={16} />
            <span>运行</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  )
}
