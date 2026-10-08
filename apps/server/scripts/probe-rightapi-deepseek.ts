/** 自建无敏感图片与合成上下文的显式模型试验，默认仅准备；不修改产品模型或数据库。
 * 与真实验收共用目录锁和累计账本，未知结果绝不重发，凭证只用于同一已配置目的地。
 */
import { loadEnvFile } from 'node:process'
import { createHash, randomUUID, randomInt } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import sharp from 'sharp'
import { z } from 'zod'
import { retrievalActionSchema, retrievalActionJsonSchema } from '@local-media-agent/shared/schemas'
import { chatRequest, chatResponse, chatCompletionsUrl } from '../src/agent/rightapi-chat.protocol.js'
import { verificationCostFits } from '../src/agent/retrieval-budget.policy.js'
import { saveVerificationLedger, reloadVerificationLedger, verificationAttemptsReady } from './retrieval-verification-ledger.js'

const root = '../../.scratch/retrieval-quality'
const model = 'deepseek-v4-flash'
const reserve = 0.410472
const live = process.argv.includes('--live')
const revision = z.union([z.literal(1), z.literal(2)]).parse(Number(process.argv.find(arg => arg.startsWith('--revision='))?.split('=')[1] ?? 1))
const suffix = revision === 1 ? '' : `-r${revision}`
const preparedPath = `${root}/deepseek-probe-prepared${suffix}.json`
const runId = `deepseek-capability-probe-2026-10-06${suffix}`
const observationSchema = z.object({ left: z.string().max(80), right: z.string().max(80), text: z.string().max(32) }).strict()
const visionTool = { name: 'observe_probe', description: 'Report only the visible left and right shapes and text.',
  input_schema: { type: 'object', properties: { left: { type: 'string' }, right: { type: 'string' }, text: { type: 'string' } },
    required: ['left', 'right', 'text'], additionalProperties: false } }

/** 生成受控挑战；答案仅留本地，不在提示中泄露随机字符。PNG中没有文件路径或私人素材。 */
async function prepare() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const label = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320"><rect width="512" height="320" fill="white"/><rect x="50" y="50" width="120" height="120" fill="#1766df"/><circle cx="355" cy="110" r="60" fill="#ed7b13"/><text x="125" y="270" font-family="Arial" font-size="52" fill="black">${label}</text></svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  const vision = chatRequest({ model, max_tokens: 256, temperature: 0, thinking: { type: 'disabled' },
    system: 'Examine the image and call observe_probe. Do not guess unseen details. Use English color and shape names.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the left and right shapes (including color) and copy the text below them.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }],
    tools: [visionTool], tool_choice: { name: 'observe_probe' } })
  const decision = chatRequest({ model, max_tokens: 512, temperature: 0, thinking: { type: 'disabled' },
    system: 'Choose exactly one retrieval action using next_retrieval_action. Preserve the full original goal. Read necessary existing candidate details before judging. No external media is present; context is a synthetic protocol fixture.',
    messages: [{ role: 'user', content: JSON.stringify({ original_goal: '小猫趴在猫爬架上', enforced_scope: { search_scope: 'visual', media_types: ['video'] },
      conditions: [{ condition_id: '11111111-1111-4111-8111-111111111111', source_text: '小猫趴在猫爬架上' }],
      candidates: [{ candidate_key: 'video:22222222-2222-4222-8222-222222222222', overview: { text: '小猫出现在猫爬架旁，概要没有说明姿势。', truncated: false } }],
      queries: [{ query: '小猫趴在猫爬架上', candidate_keys: ['video:22222222-2222-4222-8222-222222222222'] }],
      budget: { remaining: { tools: 2, details: 1, searches: 1, models: 1 } }, details: {},
      instruction: 'Prefer reading this unread candidate with a gap tied to the original condition; absence of a pose in the overview is unknown, not contradiction.' }) }],
    tools: [{ name: 'next_retrieval_action', description: 'Choose one bounded retrieval action.', input_schema: retrievalActionJsonSchema }],
    tool_choice: { name: 'next_retrieval_action' } })
  const prepared = { prepared_at: new Date().toISOString(), expected: { left: 'blue square', right: 'orange circle', text: label },
    image_sha256: createHash('sha256').update(png).digest('hex'), bodies: [vision, decision] }
  await writeFile(`${root}/deepseek-synthetic-probe${suffix}.png`, png)
  await writeFile(preparedPath, JSON.stringify(prepared, null, 2))
  console.log(JSON.stringify({ prepared: true, external_calls: 0, model, request_bytes: prepared.bodies.map(b => Buffer.byteLength(JSON.stringify(b))) }))
}

if (process.argv.includes('--inspect-models')) {
  // 目录读取不运行模型、不传素材；单独保存响应分类，不能把目录声明当成看图实测。
  loadEnvFile('../../.env')
  const base = process.env.RIGHT_CODE_BASE_URL, key = process.env.RIGHT_CODE_API_KEY
  if (!base || !key) throw new Error('Configured RightAPI credentials unavailable')
  const response = await fetch(chatCompletionsUrl(base).replace(/\/chat\/completions$/, '/models'), {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
  let data: any = null
  try { data = await response.json() } catch { /* 非JSON目录没有可验证模型声明，不保存可能含秘密的正文。 */ }
  const matches = Array.isArray(data?.data) ? data.data.filter((row: any) => typeof row.id === 'string' &&
    (row.id.toLowerCase().includes('deepseek') || row.id === 'glm-5.3'))
    .map((row: any) => ({ id: row.id, owned_by: typeof row.owned_by === 'string' ? row.owned_by.slice(0, 80) : null })) : []
  const result = { directory_http_status: response.status, listed_models: matches, inference_calls: 0, personal_media_sent: false }
  await writeFile(`${root}/deepseek-model-directory${suffix}.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
else if (!live) await prepare()
else {
  loadEnvFile('../../.env')
  const base = process.env.RIGHT_CODE_BASE_URL, key = process.env.RIGHT_CODE_API_KEY
  if (!base || !key) throw new Error('Configured RightAPI credentials unavailable')
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'))
  let ownsLock = false
  try {
    await mkdir(`${root}/live.lock`); ownsLock = true
    const ledger = await reloadVerificationLedger<any>(ownsLock, `${root}/live-ledger.json`, null)
    if (!ledger || !Array.isArray(ledger.attempts)) throw new Error('Missing existing ledger; do not reset')
    if (ledger.attempts.some((a: any) => a.run_id === runId)) throw new Error('Probe already dispatched; automatic replay forbidden')
    let recovered403: string | undefined
    if (revision === 2) {
      const approval = z.object({ source: z.literal('direct_user_reply'), date: z.literal('2026-10-06'),
        user_answer: z.literal('我更新了，重试一下，刚刚网站没有设置允许访问`deepseek-v4-flash`'),
        confirmed_rejected_request_sha256: z.literal('ccd78b62c37e91451ea4a1472398907fb4cd791a04163c00bb8778070ae16b6d'),
        confirmed_http_status: z.literal(403), fresh_revision: z.literal(2), maximum_new_inference_calls: z.literal(2),
        maximum_total_cost_cny: z.literal(20), reserve_cny_per_call: z.literal(reserve),
        prior_unknown_fee_reserve_retained: z.literal(true), model: z.literal(model), scope: z.string() }).strict()
        .parse(JSON.parse(await readFile(`${root}/deepseek-permission-recovery.json`, 'utf8')))
      const previous = ledger.attempts.filter((a: any) => a.request_sha256 === approval.confirmed_rejected_request_sha256)
      if (previous.length !== 1 || previous[0].kind !== 'deepseek_probe' || previous[0].status !== 'received' ||
        previous[0].http_status !== 403 || !(previous[0].reserve_cny > 0) || previous[0].estimated_cost_cny !== null)
        throw new Error('Explicit permission recovery must match a known rejection with retained fee reserve')
      recovered403 = approval.confirmed_rejected_request_sha256
    }
    const recovered = await Promise.all(['provider-payment-recovery.json', 'provider-explicit-retry.json', 'provider-afternoon-retry.json']
      .map(async name => JSON.parse(await readFile(`${root}/${name}`, 'utf8')).confirmed_rejected_request_sha256))
    const results: unknown[] = []
    for (const [index, body] of prepared.bodies.entries()) {
      // 直接用户确认只豁免这一条已收到403的权限拒绝；账本不删行，预算仍包含其正预留。
      // 其他缺用量/未知请求保持停止条件；本批再次失败后也不能用这个旧确认继续派发。
      const readyAttempts = ledger.attempts.filter((a: any) => !recovered403 || a.request_sha256 !== recovered403)
      if (!verificationAttemptsReady(readyAttempts, recovered)) throw new Error('Prior unknown result/usage blocks dispatch')
      if (ledger.attempts.filter((a: any) => ['glm', 'deepseek_probe'].includes(a.kind)).length >= 73) throw new Error('Model experiment limit')
      if (!verificationCostFits(20, ledger.carried_prior_estimate_and_reserve_cny, ledger.attempts, reserve)) throw new Error('Cumulative budget limit')
      const encoded = JSON.stringify(body)
      if (body.model !== model || body.max_tokens > 512 || Buffer.byteLength(encoded) > 64000) throw new Error('Probe request limit')
      const attempt: any = { kind: 'deepseek_probe', run_id: runId, purpose: index === 0 ? 'synthetic_vision_and_tool' : 'synthetic_retrieval_schema',
        model, status: 'dispatched', reserve_cny: reserve, estimated_cost_cny: null, billed_cost_cny: null,
        request_bytes: Buffer.byteLength(encoded), request_sha256: createHash('sha256').update(encoded).digest('hex'),
        dispatch_id: randomUUID(), dispatched_at: new Date().toISOString() }
      ledger.attempts.push(attempt)
      // 先原子保存派发和费用占用，进程中断后不能用同一批次重发。
      await saveVerificationLedger(ownsLock, `${root}/live-ledger.json`, ledger)
      const started = performance.now()
      let accepted = false
      try {
        const response = await fetch(chatCompletionsUrl(base), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: encoded, signal: AbortSignal.timeout(60000) })
        attempt.http_status = response.status
        const data = await response.json() as any
        attempt.status = response.status >= 500 ? 'outcome_unknown' : 'received'
        attempt.usage = data.usage ?? null
        attempt.response_model = typeof data.model === 'string' ? data.model.slice(0, 128) : null
        attempt.request_id = typeof data.id === 'string' ? data.id.slice(0, 160) : null
        attempt.finish_reason = data.choices?.[0]?.finish_reason ?? null
        if (!response.ok) {
          const message = `${data.error?.code ?? ''} ${data.error?.message ?? ''}`.toLowerCase()
          attempt.rejection_category = /image|vision|multimodal/.test(message) ? 'vision_or_image_rejected'
            : /model|channel/.test(message) ? 'model_or_channel_rejected' : 'http_error'
        } else {
          const parsed = chatResponse(data)
          const tool = parsed.content[0]
          if (index === 0) {
            const observation = observationSchema.parse(tool.input)
            accepted = tool.name === 'observe_probe' && observation.text.trim() === prepared.expected.text &&
              /blue/i.test(observation.left) && /square/i.test(observation.left) && /orange/i.test(observation.right) && /circle/i.test(observation.right)
            results.push({ purpose: attempt.purpose, observation, expected: prepared.expected, accepted })
          } else {
            const action = retrievalActionSchema.parse(tool.input)
            accepted = tool.name === 'next_retrieval_action' && ['get_segment_details', 'get_segment_details_batch'].includes(action.action) &&
              'gap' in action && !!action.gap && action.gap.condition_ids.includes('11111111-1111-4111-8111-111111111111') && action.gap.preserves_original_goal
            results.push({ purpose: attempt.purpose, action, schema_valid: true, accepted })
          }
        }
        attempt.probe_accepted = accepted
      } catch {
        if (attempt.status === 'dispatched') attempt.status = 'outcome_unknown'
        else attempt.protocol_validation_failed = true
      } finally {
        attempt.latency_ms = Math.round(performance.now() - started)
        await saveVerificationLedger(ownsLock, `${root}/live-ledger.json`, ledger)
        const held = ledger.carried_prior_estimate_and_reserve_cny + ledger.attempts.reduce((sum: number, a: any) => sum + (a.estimated_cost_cny ?? a.reserve_cny), 0)
        await writeFile(`${root}/deepseek-probe-result${suffix}.json`, JSON.stringify({ model, revision, results,
          attempts: ledger.attempts.filter((a: any) => a.run_id === runId), budget_held_cny: held,
          rightapi_rate_unknown: true, product_model_changed: false, personal_media_sent: false }, null, 2))
        console.log(JSON.stringify({ purpose: attempt.purpose, status: attempt.status, http_status: attempt.http_status, response_model: attempt.response_model,
          usage: attempt.usage, accepted, budget_held_cny: held, rejection_category: attempt.rejection_category }))
      }
      // 已知失败也不自动重试；用量缺失即停止，不将未知费用按零处理。
      if (!accepted || attempt.status !== 'received' || !Number.isInteger(attempt.usage?.total_tokens)) break
    }
  } finally { if (ownsLock) await rm(`${root}/live.lock`, { recursive: true }) }
}
