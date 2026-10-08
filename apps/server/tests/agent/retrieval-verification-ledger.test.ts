import { textOnlyMessages, matchedPositionSupplementCostLimit } from '../../scripts/retrieval-verification-ledger.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { saveVerificationLedger, reloadVerificationLedger, verificationAttemptsReady } from '../../scripts/retrieval-verification-ledger.js'
import { sofaPhoneApproval, sofaPhoneSelectionControlAllowed } from '../../scripts/retrieval-sofa-phone-authorization.js'

/** 使用真实临时文件验证排他锁边界；不连接数据库或任何收费服务。 */
test('未持锁进程不能覆盖旧账本，持锁后重新读最新累计记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stars-ledger-'))
  const file = join(directory, 'ledger.json')
  try {
    const current = { attempts: [{ status: 'dispatched', reserve_cny: .216 }] }
    await writeFile(file, JSON.stringify(current))
    await expect(saveVerificationLedger(false, file, { attempts: [] })).rejects.toThrow('requires owned lock')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(current)
    await expect(reloadVerificationLedger(false, file, { attempts: [] })).rejects.toThrow('requires owned lock')
    const fresh = await reloadVerificationLedger(true, file, { attempts: [] })
    expect(fresh).toEqual(current)
    await saveVerificationLedger(true, file, { ...fresh, completed: true })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...current, completed: true })
  } finally { await rm(directory, { recursive: true }) }
})


test('只有用户确认恢复的明确402拒绝可保留全额预留后继续；未知成功用量/未知结果仍阻断', () => {
  const rejected = { kind: 'glm', status: 'received', http_status: 402, request_sha256: 'a'.repeat(64),
    usage: null, estimated_cost_cny: null, reserve_cny: .410472 }
  expect(verificationAttemptsReady([rejected])).toBe(false)
  expect(verificationAttemptsReady([rejected], 'a'.repeat(64))).toBe(true)
  expect(verificationAttemptsReady([rejected], 'b'.repeat(64))).toBe(false)
  expect(verificationAttemptsReady([{ ...rejected, http_status: 200 }], 'a'.repeat(64))).toBe(false)
  expect(verificationAttemptsReady([{ ...rejected, status: 'outcome_unknown' }], 'a'.repeat(64))).toBe(false)
  expect(verificationAttemptsReady([{ ...rejected, reserve_cny: 0 }], 'a'.repeat(64))).toBe(false)
  expect(verificationAttemptsReady([{ ...rejected, kind: 'rerank' }], 'a'.repeat(64))).toBe(false)
})


test('多次明确402各需直接确认，不能用确认旧拒绝覆盖新的缺用量请求', () => {
  const rejected = { kind: 'glm', status: 'received', http_status: 402, request_sha256: 'a'.repeat(64),
    usage: null, estimated_cost_cny: null, reserve_cny: .410472 }
  const second = { ...rejected, request_sha256: 'b'.repeat(64) }
  expect(verificationAttemptsReady([rejected, second], ['a'.repeat(64)])).toBe(false)
  expect(verificationAttemptsReady([rejected, second], ['a'.repeat(64), 'b'.repeat(64)])).toBe(true)
})

test('纯文字验收接受意图工具的标准text数组，图片和陌生块仍拒绝', () => {
  expect(textOnlyMessages([{ role: 'user', content: [{ type: 'text', text: '小猫' }, { type: 'text', text: '{}' }] }])).toBe(true)
  expect(textOnlyMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }])).toBe(false)
  expect(textOnlyMessages([{ role: 'user', content: [{ type: 'text', text: '猫', image: 'hidden' }] }])).toBe(false)
})

// 素材许可按场景/图片身份，不能因为属于同一个文件便外发未批准的另一场景。
test('真实验证拒绝批准身份以外的补搜场景和图片', async () => {
  const { mediaResultsAuthorized } = await import('../../scripts/retrieval-verification-ledger.js')
  const approved = new Set(['video:approved-scene', 'image:approved-image'])
  expect(mediaResultsAuthorized([{ scene_id: 'approved-scene', asset_id: 'frame' }, { scene_id: null, asset_id: 'approved-image' }], approved)).toBe(true)
  expect(mediaResultsAuthorized([{ scene_id: 'other-scene', asset_id: 'frame' }], approved)).toBe(false)
  expect(mediaResultsAuthorized([{ scene_id: null, asset_id: 'other-image' }], approved)).toBe(false)
})

test('追加12元上限只覆盖批准的位置新版本一次，不扩大历史总额或重放次数', () => {
  const approval = { protocol: 'matched-position-budget12-v1', source: 'direct_user_approval', authorized_on: '2026-10-07',
    user_answer: '金额上限调整，继续验收', fingerprint: 'a'.repeat(64), case_id: 'position', revision: 47,
    maximum_new_calls: 1, prior_deepseek_agent_calls: 68, maximum_deepseek_total_cost_cny: 12,
    maximum_historical_total_cost_cny: 20, maximum_product_rerank_calls: 19, unknown_requests_replay: false }
  const scope = { caseId: 'position', revision: 47, fingerprint: 'a'.repeat(64), deepseekAgentCalls: 68 }
  expect(matchedPositionSupplementCostLimit(null, scope)).toBe(10)
  expect(matchedPositionSupplementCostLimit(approval, scope)).toBe(12)
  expect(() => matchedPositionSupplementCostLimit(approval, { ...scope, caseId: 'cat' })).toThrow()
  expect(() => matchedPositionSupplementCostLimit(approval, { ...scope, revision: 44 })).toThrow()
  expect(() => matchedPositionSupplementCostLimit(approval, { ...scope, deepseekAgentCalls: 69 })).toThrow()
  expect(() => matchedPositionSupplementCostLimit({ ...approval, maximum_historical_total_cost_cny: 25 }, scope)).toThrow()
})

test('新词条许可只增加3次DeepSeek，保留12/20金额、19次重排及未知请求不重放', () => {
  const approval = { source: 'direct_user_message', authorized_on: '2026-10-07',
    user_answer: '授权。你能不能快点完成这块，我现在检索会走到deepseek决策是否补搜的逻辑上吗',
    case_id: 'sofa-phone', protocol: 'matched-multimodal-v1', model: 'deepseek-v4-flash', fingerprint: 'a'.repeat(64),
    freeze_sha256: 'b'.repeat(64), minimum_revision: 48, maximum_revision: 49, case_ids: ['sofa-phone'],
    maximum_new_calls: 3, prior_deepseek_agent_calls: 69, prior_product_rerank_calls: 17, maximum_product_rerank_calls: 19,
    maximum_candidates: 20, maximum_frames_per_candidate: 1, maximum_texts_per_candidate: 2, maximum_characters_per_text: 1200,
    maximum_details_per_candidate: 8, maximum_request_bytes: 750000, maximum_deepseek_total_cost_cny: 12,
    maximum_historical_total_cost_cny: 20, unknown_requests_replay: false, independent_local_selection_control_allowed: true }
  const scope = { fingerprint: 'a'.repeat(64), freezeSha256: 'b'.repeat(64), revision: 48 }
  expect(sofaPhoneApproval(approval, scope).maximum_new_calls).toBe(3)
  const validated = sofaPhoneApproval(approval, scope)
  const selection = { caseId: 'sofa-phone', revision: 49, live: true, localChain: false }
  expect(sofaPhoneSelectionControlAllowed(validated, selection)).toBe(true)
  for (const change of [{ caseId: 'cat' }, { revision: 48 }, { live: false }, { localChain: true }])
    expect(sofaPhoneSelectionControlAllowed(validated, { ...selection, ...change })).toBe(false)
  expect(sofaPhoneSelectionControlAllowed(null, selection)).toBe(false)
  for (const change of [{ maximum_new_calls: 4 }, { maximum_historical_total_cost_cny: 25 }, { maximum_frames_per_candidate: 3 },
    { unknown_requests_replay: true }, { maximum_product_rerank_calls: 20 }]) expect(() => sofaPhoneApproval({ ...approval, ...change }, scope)).toThrow()
  expect(() => sofaPhoneApproval(approval, { ...scope, freezeSha256: 'c'.repeat(64) })).toThrow()
  expect(() => sofaPhoneApproval(approval, { ...scope, revision: 50 })).toThrow()
})
