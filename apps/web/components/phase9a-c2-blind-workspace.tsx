'use client'

import { useMemo, useState } from 'react'

export type ConstraintAnswer = 'yes' | 'no' | 'uncertain'

export interface Phase9aC2BlindCase {
  id: string
  query_id: string
  candidate_key: string
  file_id: string
  scene_id: string
  query: string
  must_have: string[]
  exclusions: string[]
  start_time_seconds: number
  end_time_seconds: number
}

export interface Phase9aC2BlindPacket {
  schema_version: 'phase9a-c2-blind-annotation-v1'
  phase8_run_id: string
  packet_fingerprint: string
  selection_summary: {
    case_count: number
  }
  cases: Phase9aC2BlindCase[]
}

interface CaseAnswers {
  must_have: Array<ConstraintAnswer | null>
  exclusions: Array<ConstraintAnswer | null>
  notes: string
}

type ConstraintGroupName = 'must_have' | 'exclusions'

interface SavedJudgment extends CaseAnswers {
  case_id: string
  relevance: number | null
  unjudgeable: boolean
}

/**
 * 按冻结协议从逐项答案推导整体等级，避免标注者凭整体印象随意改变 0/1/2 边界。
 * `uncertain` 单独成为无法判断；它不等于不相关，也不会被强行换算成某个等级。
 */
export function deriveBlindJudgment(
  mustHave: Array<ConstraintAnswer | null>,
  exclusions: Array<ConstraintAnswer | null>,
): { relevance: number | null; unjudgeable: boolean } {
  const answers = [...mustHave, ...exclusions]
  if (answers.some((answer) => answer === null || answer === 'uncertain')) {
    return { relevance: null, unjudgeable: true }
  }
  if (exclusions.some((answer) => answer === 'yes')) {
    return { relevance: 0, unjudgeable: false }
  }
  const matchedCount = mustHave.filter((answer) => answer === 'yes').length
  if (matchedCount === mustHave.length) return { relevance: 2, unjudgeable: false }
  if (matchedCount > 0) return { relevance: 1, unjudgeable: false }
  return { relevance: 0, unjudgeable: false }
}

/**
 * Phase 9A-C2 本地盲标页面。
 *
 * 页面只通过 Server 的媒体内容 API 播放已经索引的视频场景。答案保存在浏览器
 * localStorage（本机网页存储）并由用户导出 JSON；不会写 PostgreSQL、Qdrant，也不会
 * 调用任何视觉语言模型。A/B 轮使用不同存储键，第二轮不会读取第一轮答案。
 */
export function Phase9aC2BlindWorkspace({
  packet,
  apiBaseUrl,
}: {
  packet: Phase9aC2BlindPacket
  apiBaseUrl: string
}) {
  const [round, setRound] = useState('')
  const [started, setStarted] = useState(false)
  const [saved, setSaved] = useState<Record<string, SavedJudgment>>({})
  const [draft, setDraft] = useState<CaseAnswers | null>(null)
  const [error, setError] = useState<string | null>(null)

  const storageKey = useMemo(
    () => `phase9a-c2:${packet.packet_fingerprint}:${round}`,
    [packet.packet_fingerprint, round],
  )
  const currentCase = packet.cases.find((item) => !saved[item.id])
  const completedCount = Object.keys(saved).length

  function startIndependentRound() {
    if (!round) return
    setError(null)
    try {
      const restored = window.localStorage.getItem(storageKey)
      setSaved(restored ? parseStoredProgress(packet, round, restored) : {})
      setDraft(null)
      setStarted(true)
    } catch (cause) {
      setError(`本轮本地进度无法读取：${errorMessage(cause)}`)
    }
  }

  function clearCorruptedRound() {
    try {
      window.localStorage.removeItem(storageKey)
      setSaved({})
      setDraft(null)
      setError(null)
      setStarted(true)
    } catch (cause) {
      setError(`本轮损坏进度无法清除：${errorMessage(cause)}`)
    }
  }

  function currentDraft(item: Phase9aC2BlindCase) {
    return (
      draft ?? {
        must_have: item.must_have.map(() => null),
        exclusions: item.exclusions.map(() => null),
        notes: '',
      }
    )
  }

  function answerConstraint(
    item: Phase9aC2BlindCase,
    group: ConstraintGroupName,
    index: number,
    answer: ConstraintAnswer,
  ) {
    const next = currentDraft(item)
    setDraft({
      ...next,
      [group]: next[group].map((value, currentIndex) => (currentIndex === index ? answer : value)),
    })
  }

  function updateNotes(item: Phase9aC2BlindCase, notes: string) {
    setDraft({ ...currentDraft(item), notes })
  }

  function saveAndContinue(item: Phase9aC2BlindCase) {
    const answers = currentDraft(item)
    const judgment = deriveBlindJudgment(answers.must_have, answers.exclusions)
    const nextSaved = {
      ...saved,
      [item.id]: {
        case_id: item.id,
        ...answers,
        ...judgment,
      },
    }
    const exportEnvelope = {
      schema_version: 'phase9a-c2-human-annotation-v1',
      packet_fingerprint: packet.packet_fingerprint,
      annotation_round: round,
      results: nextSaved,
    }
    // 每完成一条就同步保存；浏览器刷新或服务重启后可以继续，且不会产生数据库写入。
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(exportEnvelope))
      setSaved(nextSaved)
      setDraft(null)
      setError(null)
    } catch (cause) {
      // localStorage 可能因浏览器隐私模式或容量限制写失败；保持当前题目和答案，供用户重试。
      setError(`本轮进度保存失败，当前答案尚未提交：${errorMessage(cause)}`)
    }
  }

  function exportRound() {
    const payload = {
      schema_version: 'phase9a-c2-human-annotation-v1',
      packet_fingerprint: packet.packet_fingerprint,
      annotation_round: round,
      results: saved,
    }
    try {
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `phase9a-c2-annotation-${round}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setError(null)
    } catch (cause) {
      setError(`标注文件导出失败：${errorMessage(cause)}`)
    }
  }

  if (!started) {
    return (
      <section className="space-y-6">
        <header>
          <p className="eyebrow">Phase 9A-C2 · 本地工具</p>
          <h1 className="page-title">30 条全新多帧盲标</h1>
          <p className="muted">
            每条只判断画面能否支持具体条件。答案只保存在本机浏览器，完成后导出 JSON。
          </p>
        </header>
        {error ? (
          <div className="panel space-y-2" role="alert">
            <p>{error}</p>
            <button className="secondary-action" onClick={clearCorruptedRound}>
              清除本轮损坏进度
            </button>
          </div>
        ) : null}
        <div className="panel max-w-xl space-y-4">
          <label className="block space-y-2">
            <span>标注轮次</span>
            <select
              aria-label="标注轮次"
              className="w-full rounded border p-2"
              value={round}
              onChange={(event) => setRound(event.target.value)}
            >
              <option value="">请选择</option>
              <option value="A">A（第一位标注者或第一次）</option>
              <option value="B">B（第二位标注者或间隔后的第二次）</option>
            </select>
          </label>
          <button className="primary-action" disabled={!round} onClick={startIndependentRound}>
            开始独立标注
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-6">
      <header>
        <p className="eyebrow">Phase 9A-C2 · 轮次 {round}</p>
        <h1 className="page-title">逐约束盲标</h1>
        <p className="muted">
          已完成 {completedCount} / {packet.cases.length}
        </p>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {currentCase ? (
        <BlindCaseForm
          apiBaseUrl={apiBaseUrl}
          item={currentCase}
          answers={currentDraft(currentCase)}
          onAnswer={answerConstraint}
          onNotes={updateNotes}
          onSave={saveAndContinue}
        />
      ) : (
        <div className="panel space-y-4">
          <p>{packet.selection_summary.case_count} 条已全部完成，可导出本轮 JSON。</p>
          <button className="primary-action" onClick={exportRound}>
            导出轮次 {round} 标注
          </button>
        </div>
      )}
    </section>
  )
}

function parseStoredProgress(
  packet: Phase9aC2BlindPacket,
  round: string,
  raw: string,
): Record<string, SavedJudgment> {
  const envelope = JSON.parse(raw) as {
    schema_version?: unknown
    packet_fingerprint?: unknown
    annotation_round?: unknown
    results?: unknown
  }
  if (
    envelope.schema_version !== 'phase9a-c2-human-annotation-v1' ||
    envelope.packet_fingerprint !== packet.packet_fingerprint ||
    envelope.annotation_round !== round ||
    !isRecord(envelope.results)
  ) {
    throw new Error('文件版本、样本指纹、轮次或结果结构不匹配')
  }
  const casesById = new Map(packet.cases.map((item) => [item.id, item]))
  const restored: Record<string, SavedJudgment> = {}
  for (const [caseId, rawResult] of Object.entries(envelope.results)) {
    const item = casesById.get(caseId)
    if (!item || !isRecord(rawResult) || rawResult.case_id !== caseId) {
      throw new Error(`包含不属于当前样本包的结果：${caseId}`)
    }
    const mustHave = parseAnswerList(rawResult.must_have, item.must_have.length, caseId)
    const exclusions = parseAnswerList(rawResult.exclusions, item.exclusions.length, caseId)
    const notes = rawResult.notes ?? ''
    if (typeof notes !== 'string' || notes.length > 1000) {
      throw new Error(`${caseId} 的备注格式无效`)
    }
    const derived = deriveBlindJudgment(mustHave, exclusions)
    if (
      rawResult.relevance !== derived.relevance ||
      rawResult.unjudgeable !== derived.unjudgeable
    ) {
      throw new Error(`${caseId} 的自动等级与逐项答案不一致`)
    }
    restored[caseId] = {
      case_id: caseId,
      must_have: mustHave,
      exclusions,
      notes,
      ...derived,
    }
  }
  return restored
}

function parseAnswerList(value: unknown, expectedLength: number, caseId: string) {
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    value.some((answer) => !['yes', 'no', 'uncertain'].includes(String(answer)))
  ) {
    throw new Error(`${caseId} 的逐项答案格式无效`)
  }
  return value as ConstraintAnswer[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function BlindCaseForm({
  item,
  answers,
  apiBaseUrl,
  onAnswer,
  onNotes,
  onSave,
}: {
  item: Phase9aC2BlindCase
  answers: CaseAnswers
  apiBaseUrl: string
  onAnswer: (
    item: Phase9aC2BlindCase,
    group: ConstraintGroupName,
    index: number,
    answer: ConstraintAnswer,
  ) => void
  onNotes: (item: Phase9aC2BlindCase, notes: string) => void
  onSave: (item: Phase9aC2BlindCase) => void
}) {
  const judgment = deriveBlindJudgment(answers.must_have, answers.exclusions)
  const complete = [...answers.must_have, ...answers.exclusions].every((answer) => answer !== null)
  const fragment = `#t=${Math.max(0, item.start_time_seconds)},${Math.max(0, item.end_time_seconds)}`

  return (
    <div className="panel space-y-5">
      <p className="font-medium">查询：{item.query}</p>
      <video
        aria-label="待标注视频场景"
        className="max-h-[32rem] w-full rounded"
        controls
        muted
        src={`${apiBaseUrl}/media/${item.file_id}/content${fragment}`}
      />
      <p className="muted">
        请保持静音，只根据这段连续画面判断；看不清或画面没有覆盖的条件请选择“不确定”。
      </p>
      <ConstraintGroup
        title="必须条件"
        constraints={item.must_have}
        answers={answers.must_have}
        onAnswer={(index, answer) => onAnswer(item, 'must_have', index, answer)}
      />
      <ConstraintGroup
        title="排除条件"
        constraints={item.exclusions}
        answers={answers.exclusions}
        onAnswer={(index, answer) => onAnswer(item, 'exclusions', index, answer)}
      />
      <label className="block space-y-2">
        <span>可选备注（例如：哪句话容易产生两种理解）</span>
        <textarea
          className="w-full rounded border p-2"
          maxLength={1000}
          value={answers.notes}
          onChange={(event) => onNotes(item, event.target.value)}
        />
      </label>
      <p className="font-medium">系统推导：{judgmentLabel(judgment, complete)}</p>
      <button className="primary-action" disabled={!complete} onClick={() => onSave(item)}>
        保存并继续
      </button>
    </div>
  )
}

function ConstraintGroup({
  title,
  constraints,
  answers,
  onAnswer,
}: {
  title: string
  constraints: string[]
  answers: Array<ConstraintAnswer | null>
  onAnswer: (index: number, answer: ConstraintAnswer) => void
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="section-title">{title}</legend>
      {constraints.map((constraint, index) => (
        <div key={`${constraint}:${index}`} className="rounded border p-3">
          <p>{constraint}</p>
          <div className="mt-2 flex flex-wrap gap-4">
            {(
              [
                ['yes', '是'],
                ['no', '否'],
                ['uncertain', '不确定'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  aria-label={`${constraint}：${label}`}
                  checked={answers[index] === value}
                  name={`${title}:${index}`}
                  type="radio"
                  value={value}
                  onChange={() => onAnswer(index, value)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  )
}

function judgmentLabel(
  judgment: { relevance: number | null; unjudgeable: boolean },
  complete: boolean,
) {
  if (!complete) return '请完成全部逐项判断'
  if (judgment.unjudgeable) return '无法可靠判断'
  if (judgment.relevance === 2) return '高度相关（2）'
  if (judgment.relevance === 1) return '部分相关（1）'
  return '不相关（0）'
}
