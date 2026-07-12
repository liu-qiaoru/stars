'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Briefcase, Folder, Search, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { HealthIndicator } from './health-indicator'

const navItems = [
  { href: '/libraries', label: '素材库', icon: Folder },
  { href: '/search', label: '搜索', icon: Search },
  { href: '/jobs', label: '任务', icon: Briefcase },
]

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="min-h-screen text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--hairline)] bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link href="/search" className="flex items-center gap-2 font-semibold text-[var(--ink)]">
            <span className="grid size-8 place-items-center rounded-md border border-[var(--hairline)] bg-white text-sm shadow-[var(--shadow-1)]">
              <Sparkles aria-hidden="true" size={15} />
            </span>
            <span className="hidden sm:inline">媒体助手</span>
          </Link>
          <nav
            aria-label="主导航"
            className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto"
          >
            {navItems.map((item) => {
              const Icon = item.icon
              const active = routeMatches(pathname, item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? 'nav-pill nav-pill-active' : 'nav-pill'}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span className="hidden md:inline">{item.label}</span>
                </Link>
              )
            })}
          </nav>
          <HealthIndicator />
          <Link
            href="/agent"
            className={
              routeMatches(pathname, '/agent')
                ? 'primary-action primary-action-active hidden sm:inline-flex'
                : 'primary-action hidden sm:inline-flex'
            }
            aria-current={routeMatches(pathname, '/agent') ? 'page' : undefined}
          >
            <Sparkles aria-hidden="true" size={16} />
            <span>Ask</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  )
}

function routeMatches(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}
