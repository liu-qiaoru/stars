import type { Metadata } from 'next'
import { AppShell } from '../components/app-shell'
import './globals.css'

export const metadata: Metadata = {
  title: '媒体助手',
  description: '本地媒体搜索和工作流界面',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
