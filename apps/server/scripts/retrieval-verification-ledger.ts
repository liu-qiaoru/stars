/** 真实验收账本文件读写；调用者必须先取得排他目录锁，不产生模型或数据库调用。 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { z } from 'zod'

/** 新聊天授权的审计约束；历史授权文件不覆盖，金额仅允许本次位置查询一次追加。
 * 调用者必须在持锁重读最新账本后核对次数，禁止同版本或已外发未知请求重放。
 */
export function matchedPositionSupplementCostLimit(approval: unknown, scope: {
  caseId: string; revision: number; fingerprint: string; deepseekAgentCalls: number
}): number {
  if (approval === null) return 10
  const parsed = z.object({ protocol: z.literal('matched-position-budget12-v1'), source: z.literal('direct_user_approval'),
    authorized_on: z.literal('2026-10-07'), user_answer: z.literal('金额上限调整，继续验收'),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), case_id: z.literal('position'), revision: z.literal(47),
    maximum_new_calls: z.literal(1), prior_deepseek_agent_calls: z.literal(68), maximum_deepseek_total_cost_cny: z.literal(12),
    maximum_historical_total_cost_cny: z.literal(20), maximum_product_rerank_calls: z.literal(19), unknown_requests_replay: z.literal(false),
  }).strict().parse(approval)
  if (scope.caseId !== parsed.case_id || scope.revision !== parsed.revision || scope.fingerprint !== parsed.fingerprint ||
    scope.deepseekAgentCalls !== parsed.prior_deepseek_agent_calls) throw new Error('Position supplemental authorization scope or count exceeded')
  return parsed.maximum_deepseek_total_cost_cny
}

/** 未获锁的进程不得清理/写回旧快照；临时文件改名使完整账本一次替换。 */
export async function saveVerificationLedger(ownsLock: boolean, path: string, ledger: unknown) {
  if (!ownsLock) throw new Error('Verification ledger write requires owned lock')
  await writeFile(`${path}.tmp`, JSON.stringify(ledger, null, 2))
  await rename(`${path}.tmp`, path)
}

/** 取得锁后重新读取：锁外初始快照可能遗漏刚完成的收费请求，不能直接写回。 */
export async function reloadVerificationLedger<T>(ownsLock: boolean, path: string, fallback: T): Promise<T> {
  if (!ownsLock) throw new Error('Verification ledger reload requires owned lock')
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}

/** 默认缺用量就停止；平台恢复的明确402可由直接用户确认例外，但费用必须保留正预留。 */
export function verificationAttemptsReady(attempts: Array<{ kind: string; status: string; usage?: unknown;
  http_status?: number; request_sha256?: string; reserve_cny: number; estimated_cost_cny: number | null }>,
  recoveredPaymentRequest?: string | readonly string[]): boolean {
  const confirmed = typeof recoveredPaymentRequest === 'string' ? [recoveredPaymentRequest] : recoveredPaymentRequest ?? []
  return attempts.every(row => {
    if (row.status !== 'received') return false
    const usage = row.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
    const known = row.kind === 'glm'
      ? Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens)
      : Number.isInteger(usage?.total_tokens)
    return known || (row.kind === 'glm' && row.http_status === 402 &&
      typeof row.request_sha256 === 'string' && confirmed.includes(row.request_sha256) &&
      row.estimated_cost_cny === null && Number.isFinite(row.reserve_cny) && row.reserve_cny > 0)
  })
}

/** 验收纯文字边界：字符串或标准text块，任何图片、音频或陌生字段都拒绝。 */
export function textOnlyMessages(messages: unknown): boolean {
  return Array.isArray(messages) && messages.every(message => typeof message?.content === 'string' ||
    (Array.isArray(message?.content) && message.content.every((block: any) => block?.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => key === 'type' || key === 'text'))))
}

/** 验收搜索的素材授权边界。调用者在返回模型上下文前检查，越界不静默改成空结果。 */
export function mediaResultsAuthorized(results: Array<{ scene_id?: string | null; asset_id: string }>, approvedKeys: ReadonlySet<string>): boolean {
  return results.every(result => approvedKeys.has(result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`))
}
