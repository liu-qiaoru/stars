import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AppShell } from '../components/app-shell'

describe('AppShell', () => {
  test('renders primary workflow navigation', () => {
    render(
      <AppShell>
        <div>当前页面</div>
      </AppShell>,
    )

    const nav = screen.getByRole('navigation', { name: /主导航/i })
    expect(within(nav).getByRole('link', { name: /素材库/i })).toHaveAttribute('href', '/libraries')
    expect(within(nav).getByRole('link', { name: /搜索/i })).toHaveAttribute('href', '/search')
    expect(within(nav).getByRole('link', { name: /任务/i })).toHaveAttribute('href', '/jobs')
    expect(within(nav).queryByRole('link', { name: /媒体/i })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /助手/i })).toHaveAttribute('href', '/agent')
    expect(screen.getByText('当前页面')).toBeInTheDocument()
  })
})
