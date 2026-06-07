'use client'

import { Bot, Send } from 'lucide-react'
import { createApiClient } from '../lib/api-client'

export function AgentWorkspace() {
  async function startRun(formData: FormData) {
    const prompt = String(formData.get('prompt') ?? '').trim()
    if (!prompt) {
      return
    }
    await createApiClient().createAgentRun({ prompt, allow_external_vlm: false })
  }

  return (
    <section className="panel max-w-3xl">
      <div className="flex items-center gap-3">
        <span className="grid size-12 place-items-center rounded-full bg-[var(--surface-card)]">
          <Bot aria-hidden="true" size={22} />
        </span>
        <div>
          <p className="eyebrow">助手</p>
          <h1 className="page-title">任务运行器</h1>
        </div>
      </div>
      <form action={startRun} className="mt-6 space-y-3">
        <textarea
          name="prompt"
          className="text-input min-h-36 w-full resize-y"
          placeholder="查找包含清晰产品镜头的发布会片段"
        />
        <button className="primary-action" type="submit">
          <Send aria-hidden="true" size={16} />
          启动任务
        </button>
      </form>
      <div className="mt-6 rounded-[16px] bg-[var(--surface-card)] p-4">
        <p className="text-sm font-bold">外部大模型</p>
        <p className="muted">默认关闭</p>
      </div>
    </section>
  )
}
