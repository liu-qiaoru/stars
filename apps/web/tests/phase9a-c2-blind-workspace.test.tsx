import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  deriveBlindJudgment,
  Phase9aC2BlindWorkspace,
  type Phase9aC2BlindPacket,
} from '../components/phase9a-c2-blind-workspace'

const packet: Phase9aC2BlindPacket = {
  schema_version: 'phase9a-c2-blind-annotation-v1',
  phase8_run_id: '6298b745-d9d3-44bf-86a0-2d0a0b46360c',
  packet_fingerprint: `sha256:${'a'.repeat(64)}`,
  selection_summary: {
    case_count: 1,
  },
  cases: [
    {
      id: 'c2-01-abcd1234',
      query_id: 'query-1',
      candidate_key: 'scene-1',
      file_id: 'file-1',
      scene_id: 'scene-1',
      query: '有人用筷子吃盒饭',
      must_have: ['至少一人', '可见筷子'],
      exclusions: ['只有食物没有人物'],
      start_time_seconds: 3,
      end_time_seconds: 8,
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('Phase 9A-C2 blind workspace', () => {
  test('derives relevance from atomic answers and preserves uncertainty', () => {
    expect(deriveBlindJudgment(['yes', 'yes'], ['no'])).toEqual({
      relevance: 2,
      unjudgeable: false,
    })
    expect(deriveBlindJudgment(['yes', 'no'], ['no'])).toEqual({ relevance: 1, unjudgeable: false })
    expect(deriveBlindJudgment(['yes', 'yes'], ['yes'])).toEqual({
      relevance: 0,
      unjudgeable: false,
    })
    expect(deriveBlindJudgment(['yes', 'uncertain'], ['no'])).toEqual({
      relevance: null,
      unjudgeable: true,
    })
  })

  test('records each constraint without showing old labels or retrieval evidence', () => {
    render(<Phase9aC2BlindWorkspace packet={packet} apiBaseUrl="http://localhost:4000" />)

    fireEvent.change(screen.getByLabelText('标注轮次'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: '开始独立标注' }))
    expect(screen.getByText('查询：有人用筷子吃盒饭')).toBeInTheDocument()
    expect(screen.getByText('已完成 0 / 1')).toBeInTheDocument()
    expect(screen.queryByText(/RRF|Caption-only|旧标签/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('至少一人：是'))
    fireEvent.click(screen.getByLabelText('可见筷子：是'))
    fireEvent.click(screen.getByLabelText('只有食物没有人物：否'))
    expect(screen.getByText('系统推导：高度相关（2）')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }))

    expect(screen.getByText('1 条已全部完成，可导出本轮 JSON。')).toBeInTheDocument()
    const storageKey = window.localStorage.key(0)
    expect(storageKey).toContain('phase9a-c2')
    expect(window.localStorage.getItem(storageKey!)).toContain('"relevance":2')
  })

  test('shows a recoverable error when saved browser progress is corrupted', () => {
    window.localStorage.setItem(`phase9a-c2:${packet.packet_fingerprint}:A`, '{not-json')
    render(<Phase9aC2BlindWorkspace packet={packet} apiBaseUrl="http://localhost:4000" />)

    fireEvent.change(screen.getByLabelText('标注轮次'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: '开始独立标注' }))

    expect(screen.getByRole('alert')).toHaveTextContent('本轮本地进度无法读取')
    fireEvent.click(screen.getByRole('button', { name: '清除本轮损坏进度' }))
    expect(window.localStorage.getItem(`phase9a-c2:${packet.packet_fingerprint}:A`)).toBeNull()
    expect(screen.getByText('查询：有人用筷子吃盒饭')).toBeInTheDocument()
  })

  test('keeps the current answers visible when browser storage rejects a write', () => {
    render(<Phase9aC2BlindWorkspace packet={packet} apiBaseUrl="http://localhost:4000" />)
    fireEvent.change(screen.getByLabelText('标注轮次'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: '开始独立标注' }))
    fireEvent.click(screen.getByLabelText('至少一人：是'))
    fireEvent.click(screen.getByLabelText('可见筷子：是'))
    fireEvent.click(screen.getByLabelText('只有食物没有人物：否'))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }))

    expect(screen.getByRole('alert')).toHaveTextContent('当前答案尚未提交')
    expect(screen.getByText('查询：有人用筷子吃盒饭')).toBeInTheDocument()
    expect(screen.getByLabelText('至少一人：是')).toBeChecked()
  })
})
