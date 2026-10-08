import { z } from 'zod'

/** 本地附加冻结清单的TypeScript权威定义；保留查询与来源，模型相关分不属于这个结构。 */
export const retrievalReviewExtensionSchema = z.object({ fingerprint: z.string().min(1), cases: z.array(z.object({
  id: z.string().min(1), original_query: z.string().min(1), candidates: z.array(z.object({
    candidate_key: z.string().min(1), file_id: z.string().min(1), file_generation: z.number().int().nonnegative(),
    library_id: z.string().min(1), media_type: z.enum(['image', 'video', 'audio']),
    source_step_id: z.string().min(1), source_query: z.string().trim().min(1).max(8000), rank: z.number().int().min(1).max(20),
    origin: z.enum(['local_search_preflight', 'agent_tool']),
    asset_id: z.string().optional(), scene_id: z.string().nullable().optional(),
  }).strict()).max(20),
}).strict()).max(32) }).strict()
export type RetrievalReviewExtension = z.infer<typeof retrievalReviewExtensionSchema>
export interface FrozenReviewCase {
  id: string; query: string; scope: string; media_types: string[]; library_ids: string[]; candidate_keys: string[]
}

/**
 * 只扩充共同人工候选池，不改原20条或现有标签。调用脚本须先将来源与真实工具结果逐身份核对，
 * 并提供只读数据库中的当前generation；此函数验证范围/版本，不验证标签语义。
 * 本地预检与真实Agent工具来源分开，前者不得作为GLM自主补搜的验收证据。
 */
export function extendRetrievalReviewPool(cases: FrozenReviewCase[], extension: unknown, fingerprint: string,
  generations: Map<string, number>) {
  const parsed = retrievalReviewExtensionSchema.parse(extension)
  if (parsed.fingerprint !== fingerprint) throw new Error('Review pool fingerprint mismatch')
  const allowed = new Map(cases.map(row => [row.id, row]))
  const additions = new Map<string, string[]>()
  for (const row of parsed.cases) {
    const original = allowed.get(row.id)
    if (!original || row.original_query !== original.query || additions.has(row.id)) throw new Error('Review pool query mismatch')
    const keys = new Set<string>()
    for (const candidate of row.candidates) {
      if (keys.has(candidate.candidate_key) || generations.get(candidate.file_id) !== candidate.file_generation ||
        !original.media_types.includes(candidate.media_type) ||
        (original.library_ids.length && !original.library_ids.includes(candidate.library_id)) ||
        (original.scope === 'visual' && candidate.media_type === 'audio') ||
        (original.scope === 'spoken' && candidate.media_type === 'image')) throw new Error('Review candidate version/scope mismatch')
      keys.add(candidate.candidate_key)
    }
    additions.set(row.id, [...keys])
  }
  return cases.map(row => ({ id: row.id, candidate_keys: [...new Set([...row.candidate_keys, ...(additions.get(row.id) ?? [])])] }))
}
