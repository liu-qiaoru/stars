'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Save, Settings2 } from 'lucide-react'
import { createApiClient, type AgentSettingsResponse } from '../lib/api-client'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'

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
  { key: 'activity_timeout_ms', label: '活动执行超时', unit: '毫秒', min: 1_000, max: 120_000 },
  { key: 'lease_duration_ms', label: '租约时长', unit: '毫秒', min: 5_000, max: 300_000 },
  { key: 'waiting_ttl_seconds', label: '等待期限', unit: '秒', min: 60, max: 604_800 },
  { key: 'executor_interval_ms', label: 'Server 扫描间隔', unit: '毫秒', min: 500, max: 60_000 },
  { key: 'web_poll_interval_ms', label: 'Web 轮询间隔', unit: '毫秒', min: 500, max: 60_000 },
]

/** 设置页只编辑 Server 明确允许的数字和开关；凭证与 URL 从不写入 DOM。 */
export function SettingsWorkspace({
  apiClient = createApiClient(),
}: {
  apiClient?: SettingsClient
}) {
  const [settings, setSettings] = useState<AgentSettingsResponse | null>(null)
  const [draft, setDraft] = useState<AgentSettingsResponse['editable'] | null>(null)
  const [notice, setNotice] = useState('正在读取 Server 配置…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void apiClient
      .getAgentSettings({ signal: controller.signal })
      .then((value) => {
        setSettings(value)
        setDraft(value.editable)
        setNotice('配置已从 Server 读取。')
      })
      .catch((loadError: unknown) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError(loadError instanceof Error ? loadError.message : '读取 Server 配置失败。')
          setNotice('读取 Server 配置失败。')
        }
      })
    return () => controller.abort()
  }, [apiClient])

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
    const minimumLease = Math.max(draft.activity_timeout_ms, draft.tool_timeout_ms) + 5_000
    if (draft.lease_duration_ms < minimumLease) {
      setError(`租约至少需要 ${minimumLease} 毫秒，才能覆盖最长超时并保留 5000 毫秒提交余量。`)
      return
    }
    setError(null)
    try {
      const saved = await apiClient.saveAgentSettings(draft)
      setSettings(saved)
      setDraft(saved.editable)
      setNotice('配置已保存；allowlist 中的运行参数均在当前 Server 进程立即生效。')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Server 拒绝了这组配置。')
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-5">
      <div>
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Agent 运行配置</h1>
        <p className="muted mt-2">只开放安全 allowlist；协议、Provider、模型和凭证不可编辑。</p>
      </div>
      {settings && draft ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 aria-hidden="true" size={18} />
                冻结协议
              </CardTitle>
              <CardDescription>
                这些值决定模型输入输出契约，Phase C 不允许从浏览器修改。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {[
                ['Agent Provider', settings.provider],
                ['固定模型', settings.model],
                ['Prompt 版本', settings.prompt_version],
                ['Schema 版本', settings.schema_version],
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
                  Rerank：禁用；VLM 复核：禁用。
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
                保存仅影响当前 Server 进程；重启后重新使用环境变量默认值。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--hairline)] p-4">
                <span>
                  <span className="block font-medium text-[var(--ink)]">启用 Agent 执行器</span>
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
