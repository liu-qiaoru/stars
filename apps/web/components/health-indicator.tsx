'use client'

import { useEffect, useState } from 'react'
import { createApiClient } from '../lib/api-client'

type HealthStatus = 'checking' | 'ok' | 'error'

const statusConfig: Record<HealthStatus, { dot: string; label: string }> = {
  checking: { dot: 'bg-[var(--mute)]', label: '检查中' },
  ok: { dot: 'bg-[var(--link)]', label: '已连接' },
  error: { dot: 'bg-[var(--error)]', label: '未连接' },
}

export function HealthIndicator() {
  const [status, setStatus] = useState<HealthStatus>('checking')

  useEffect(() => {
    const client = createApiClient()
    let cancelled = false

    async function check() {
      try {
        await client.getHealth()
        if (!cancelled) setStatus('ok')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    check()
    const interval = setInterval(check, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const config = statusConfig[status]

  return (
    <span title={`后端状态：${config.label}`} className="inline-flex items-center gap-1.5 text-xs">
      <span className={`size-2 shrink-0 rounded-full ${config.dot}`} />
      <span className="hidden text-[var(--mute)] lg:inline">{config.label}</span>
    </span>
  )
}
