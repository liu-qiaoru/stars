'use client'

import { useState } from 'react'
import { Bot, Send } from 'lucide-react'
import { createApiClient, type AgentRunDetail } from '../lib/api-client'

interface AgentApiClient {
  createAgentRun(input: { prompt: string; allow_external_vlm: boolean }): Promise<{
    run_id: string
    status: string
    message?: string
  }>
  getAgentRun(id: string): Promise<AgentRunDetail>
  confirmAgentToolCall(id: string, toolCallId: string): Promise<{ job_id: string; status: string }>
}

export function AgentWorkspace({ apiClient = createApiClient() }: { apiClient?: AgentApiClient }) {
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<AgentRunDetail | null>(null)
  const [statusMessage, setStatusMessage] = useState('外部大模型默认关闭')

  async function startRun() {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      return
    }
    setStatusMessage('正在启动任务...')
    const created = await apiClient.createAgentRun({
      prompt: trimmedPrompt,
      // 前端 MVP 默认不启用外部 VLM/LLM；服务端也会用 ALLOW_EXTERNAL_LLM 做最终守卫。
      allow_external_vlm: false,
    })
    setStatusMessage(created.message ?? `任务状态：${created.status}`)
    const detail = await apiClient.getAgentRun(created.run_id)
    setRun(detail)
  }

  async function confirmToolCall(toolCallId: string) {
    // 只确认服务端标记为 requires_confirmation 的 tool call；实际 job 创建发生在后端。
    if (!run) {
      return
    }
    const job = await apiClient.confirmAgentToolCall(run.id, toolCallId)
    setStatusMessage(`已创建任务 ${job.job_id}`)
    setRun(await apiClient.getAgentRun(run.id))
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void startRun()
  }

  return (
    <section className="panel max-w-3xl">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)]">
          <Bot aria-hidden="true" size={22} />
        </span>
        <div>
          <p className="eyebrow">助手</p>
          <h1 className="page-title">任务运行器</h1>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        <textarea
          name="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="text-input min-h-36 w-full resize-y"
          placeholder="查找包含清晰产品镜头的发布会片段"
        />
        <button className="primary-action" type="submit">
          <Send aria-hidden="true" size={16} />
          启动任务
        </button>
      </form>
      <div className="mt-6 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] p-4">
        <p className="text-sm font-bold">外部大模型</p>
        <p className="muted">{statusMessage}</p>
      </div>
      {run ? (
        <div className="mt-4 space-y-3">
          <div className="info-tile">
            <span>运行状态</span>
            <strong>{run.status}</strong>
          </div>
          {run.summary ? <p className="muted">{run.summary}</p> : null}
          <div className="grid gap-3">
            {run.tool_calls.map((toolCall) => (
              <article key={toolCall.tool_call_id} className="row-card">
                <div>
                  <h3 className="card-title">{toolCall.name}</h3>
                  <p className="muted">{toolCall.summary}</p>
                </div>
                {toolCall.requires_confirmation ? (
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => {
                      void confirmToolCall(toolCall.tool_call_id)
                    }}
                  >
                    确认
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
