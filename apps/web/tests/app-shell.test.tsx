import { render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AppShell } from '../components/app-shell'

let pathname = '/libraries'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

describe('AppShell', () => {
  test('renders primary workflow navigation', () => {
    render(
      <AppShell>
        <div>当前页面</div>
      </AppShell>,
    )

    const nav = screen.getByRole('navigation', { name: /主导航/i })
    expect(within(nav).getByRole('link', { name: /素材库/i })).toHaveAttribute('href', '/libraries')
    expect(within(nav).getByRole('link', { name: /素材库/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: /搜索/i })).toHaveAttribute('href', '/search')
    expect(within(nav).getByRole('link', { name: /任务/i })).toHaveAttribute('href', '/jobs')
    expect(within(nav).queryByRole('link', { name: /媒体/i })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: /助手/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ask' })).toHaveAttribute('href', '/agent')
    expect(screen.getByText('当前页面')).toBeInTheDocument()
  })

  test.each([
    ['/search', '搜索'],
    ['/jobs', '任务'],
    ['/agent', 'Ask'],
  ])('highlights %s route', (route, label) => {
    pathname = route
    render(
      <AppShell>
        <div>页面</div>
      </AppShell>,
    )

    expect(screen.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
  })
})
