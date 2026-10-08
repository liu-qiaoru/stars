'use client'

import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Save, Settings2 } from 'lucide-react'
import { createApiClient, type AgentSettingsResponse } from '../lib/api-client'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { WorkspaceHeader } from './workspace-header'

type SettingsClient = Pick<
  ReturnType<typeof createApiClient>,
  'getAgentSettings' | 'saveAgentSettings'
>

type NumericAgentSetting = Exclude<keyof AgentSettingsResponse['editable'], 'enabled'>

const numberFields: Array<{
  key: NumericAgentSetting
  label: string
  unit: string
  min: number
  max: number
}> = [
  { key: 'tool_timeout_ms', label: '工具请求超时', unit: '毫秒', min: 1_000, max: 120_000 },
  { key: 'model_timeout_ms', label: '模型等待超时', unit: '毫秒', min: 1_000, max: 120_000 },
  { key: 'activity_timeout_ms', label: '活动执行超时', unit: '毫秒', min: 1_000, max: 120_000 },
  { key: 'lease_duration_ms', label: '租约时长', unit: '毫秒', min: 5_000, max: 300_000 },
  { key: 'waiting_ttl_seconds', label: '等待期限', unit: '秒', min: 60, max: 604_800 },
  { key: 'executor_interval_ms', label: '服务端扫描间隔', unit: '毫秒', min: 500, max: 60_000 },
  { key: 'web_poll_interval_ms', label: '页面轮询间隔', unit: '毫秒', min: 500, max: 60_000 },
]

/** 设置页只编辑 Server 明确允许的数字和开关；凭证与 URL 从不写入 DOM。 */
export function SettingsWorkspace({ apiClient }: { apiClient?: SettingsClient }) {
  // 每次页面挂载只创建一个默认 Client。状态更新造成的重新渲染会继续复用它，
  // 因而依赖 client 的 Effect 不会把一次 GET 变成无限请求循环。
  const defaultClient = useMemo(() => createApiClient(), [])
  const client = apiClient ?? defaultClient
  const [settings, setSettings] = useState<AgentSettingsResponse | null>(null)
  const [draft, setDraft] = useState<AgentSettingsResponse['editable'] | null>(null)
  const [notice, setNotice] = useState('正在读取服务端配置…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void client
      .getAgentSettings({ signal: controller.signal })
      .then((value) => {
        setSettings(value)
        setDraft(value.editable)
        setNotice('已读取服务端配置。')
      })
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : '读取服务端配置失败。')
          setNotice('读取服务端配置失败。')
        }
      })
    return () => controller.abort()
  }, [client])

  async function save() {
    if (!draft) return
    const invalidField = numberFields.find(
      (field) =>
        !Number.isInteger(draft[field.key]) ||
        draft[field.key] < field.min ||
        draft[field.key] > field.max,
    )
    if (invalidField) {
      setError(`${invalidField.label}必须是 ${invalidField.min} 到 ${invalidField.max} 的整数。`)
      return
    }
    const minimumLease = Math.max(draft.activity_timeout_ms, draft.tool_timeout_ms, draft.model_timeout_ms) + 5_000
    if (draft.lease_duration_ms < minimumLease) {
      setError(`租约至少需要 ${minimumLease} 毫秒，才能覆盖最长超时并保留 5000 毫秒提交余量。`)
      return
    }
    setError(null)
    try {
      const saved = await client.saveAgentSettings(draft)
      setSettings(saved)
      setDraft(saved.editable)
      setNotice('配置已保存；允许修改的运行参数已在当前服务端进程生效。')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '服务端拒绝了这组配置。')
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <WorkspaceHeader
        icon={Settings2}
        title="设置"
        description="管理智能检索的运行参数；模型、协议和凭证由部署环境统一维护。"
      />
      {settings && draft ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>服务配置</CardTitle>
              <CardDescription>
                模型服务商、固定模型和凭证只能查看，不能从页面修改。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {[
                ['模型服务商', settings.provider],
                ['固定模型', settings.model],
              ].map(([label, value]) => {
                const id = `frozen-${label.replaceAll(' ', '-').toLowerCase()}`
                return (
                  <div key={label}>
                    <Label htmlFor={id}>{label}</Label>
                    <Input id={id} value={value} readOnly aria-readonly="true" />
                  </div>
                )
              })}
              <div className="sm:col-span-2 flex items-center gap-3 rounded-lg border border-[var(--hairline)] p-4">
                <KeyRound aria-hidden="true" size={18} />
                <span>RIGHT_CODE_API_KEY</span>
                <Badge>{settings.api_key.configured ? '已配置' : '未配置'}</Badge>
              </div>
              <div className="sm:col-span-2 rounded-lg border border-[var(--hairline)] p-4">
                <p className="font-medium text-[var(--ink)]">当前能力</p>
                <p className="mt-1 text-sm text-[var(--mute)]">
                  外部文本：{settings.capabilities.external_text_available ? '可用' : '不可用'}；
                  智能重排：{settings.capabilities.rerank_available ? '可用' : '不可用'}。
                </p>
                {settings.capabilities.unavailable_reasons.length ? (
                  <p className="mt-2 text-sm text-[var(--error)]">
                    禁用原因：{settings.capabilities.unavailable_reasons.join('、')}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>运行参数</CardTitle>
              <CardDescription>
                模型等待与本地工具使用独立超时。保存仅影响当前服务端进程；重启后重新使用环境变量默认值。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--hairline)] p-4">
                <span>
                  <span className="block font-medium text-[var(--ink)]">启用智能任务执行器</span>
                  <span className="text-sm text-[var(--mute)]">
                    立即生效；部署开关和 API Key 仍是更高层守卫。
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  className="size-5 accent-[var(--primary)]"
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                {numberFields.map((field) => (
                  <div key={field.key} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`setting-${field.key}`}>
                        {field.label}（{field.unit}）
                      </Label>
                      <Badge>
                        {settings.apply_behavior[field.key] === 'immediate'
                          ? '立即生效'
                          : '需要重启'}
                      </Badge>
                    </div>
                    <Input
                      id={`setting-${field.key}`}
                      type="number"
                      min={field.min}
                      max={field.max}
                      step="1"
                      value={Number(draft[field.key])}
                      onChange={(event) =>
                        setDraft({ ...draft, [field.key]: Number(event.target.value) })
                      }
                    />
                  </div>
                ))}
              </div>
              {error ? <Alert aria-live="assertive">{error}</Alert> : null}
              <Button type="button" onClick={() => void save()}>
                <Save aria-hidden="true" size={16} />
                保存设置
              </Button>
              <p role="status" aria-live="polite" className="text-sm text-[var(--mute)]">
                {notice}
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="space-y-3 p-6" role="status">
            <p>{notice}</p>
            {error ? <Alert aria-live="assertive">{error}</Alert> : null}
          </CardContent>
        </Card>
      )}
    </section>
  )
}
