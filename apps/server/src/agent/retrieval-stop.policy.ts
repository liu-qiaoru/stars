/** 校验模型的停止依据。只检查可验证的条件/候选/证据归属与预算，
 * 不把模型声称“继续无用”当成正确语义判断，也不代替模型强制补搜。
 */
import type { RetrievalAction, RetrievalMatchedEvidence, RetrievalStopBasis } from '@local-media-agent/shared/schemas'
import { AgentStepExecutionError } from './agent.types.js'
import type { SegmentDetails } from './segment-details.tool.js'

export function validateMatchedStopBasis(input: {
  action: Extract<RetrievalAction, { action: 'finish' }>
  conditions: Array<{ condition_id: string; kind: string }>
  matched: Record<string, RetrievalMatchedEvidence>
  details: Record<string, SegmentDetails>
  candidateKeys: string[]
  remaining: { tools: number; searches: number; details: number; models: number }
}): RetrievalStopBasis {
  const fail = () => { throw new AgentStepExecutionError('AGENT_STOP_BASIS_INVALID',
    '结束须引用当前原条件与已提供证据，并分别说明补搜和详情为何不再有用；不能伪称预算耗尽。') }
  const { action, conditions, matched, details, candidateKeys, remaining } = input
  const basis = action.stop_basis
  if (!basis) return fail()
  const ids = basis.condition_ids
  if (new Set(ids).size !== ids.length || ids.some(id => !conditions.some(row => row.condition_id === id)) ||
    new Set(basis.checked.map(row => row.candidate_key)).size !== basis.checked.length) return fail()
  for (const row of basis.checked) {
    const evidence = row.evidence_level === 'matched' ? matched[row.candidate_key]
      : row.evidence_level === 'detail' ? details[row.candidate_key] : undefined
    if (!candidateKeys.includes(row.candidate_key) || !evidence ||
      (!row.evidence_ids.length && evidence.status === 'available') ||
      row.evidence_ids.some(id => !evidence.evidence.some(item => item.evidence_id === id && item.source !== 'media_metadata'))) return fail()
    // 工具实际状态覆盖模型字段，不能把只提供命中图文伪装成读过完整详情。
    row.read_status = evidence.status
  }
  if (basis.kind === 'no_results') {
    if (action.reason !== 'no_results' || candidateKeys.length || ids.length || basis.checked.length) return fail()
  } else if (basis.kind === 'sufficient_evidence') {
    if (action.reason !== 'found' || !action.assessments.some(row => basis.checked.some(checked => checked.candidate_key === row.candidate_key) && row.conditions.length === conditions.length &&
      row.conditions.every(condition => condition.status === 'satisfied')) || !basis.checked.length) return fail()
  } else {
    if (!['partial', 'insufficient_evidence', 'conditions_not_met'].includes(action.reason) ||
      basis.checked.length < Math.min(2, candidateKeys.length)) return fail()
    // 没有完整支持的候选时，至少关联所有已承认的不确定/不符合条件；空判断则保留全部必需原条件。
    const unresolved = action.assessments.length ? action.assessments.flatMap(row => row.conditions
      .filter(condition => condition.status !== 'satisfied').map(condition => condition.condition_id))
      : conditions.filter(row => row.kind !== 'optional').map(row => row.condition_id)
    if (!ids.length || unresolved.some(id => !ids.includes(id))) return fail()
    if (basis.search.status === 'not_needed' || basis.detail.status === 'not_needed') return fail()
  }
  // 当前决策已消耗一次模型机会；工具或后续决策没额度时才允许exhausted。
  if (basis.search.status === 'exhausted' && remaining.tools > 0 && remaining.searches > 0 && remaining.models > 0) return fail()
  if (basis.detail.status === 'exhausted' && remaining.tools > 0 && remaining.details > 0 && remaining.models > 0) return fail()
  return basis
}
