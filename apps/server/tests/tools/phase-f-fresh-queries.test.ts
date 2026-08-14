import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

const freshQuerySchema = z
  .array(
    z.object({
      query_text: z.string().trim().min(1),
      query_type: z.literal('discovery'),
      search_scope: z.literal('visual'),
      intent_category: z.string().trim().min(1),
      must_have: z.array(z.string().trim().min(1)).min(1),
      optional: z.array(z.string().trim().min(1)),
      exclusions: z.array(z.string().trim().min(1)),
    }),
  )
  .length(30)

describe('Phase F fresh Evaluation queries', () => {
  test('contains 30 distinct new visual discovery queries instead of old review text', async () => {
    const raw = await readFile(
      new URL('../../../web/data/phase-f-fresh-queries.json', import.meta.url),
      'utf8',
    )
    const queries = freshQuerySchema.parse(JSON.parse(raw))
    const queryTexts = queries.map((query) => query.query_text)

    expect(new Set(queryTexts)).toHaveLength(30)
    // 这些是用户截图中指出的旧评测文本。固定负向断言可防止后续候选包生成器
    // 又把旧查询误当成“仅仅去重后的新查询”。
    expect(queryTexts).not.toContain('有人坐在电脑桌前')
    expect(queryTexts).not.toContain('室内有人面对镜头讲话')
    expect(queryTexts).not.toContain('戴冰晶王冠的人拿着麦克风')
  })

  test('keeps the 13 user-authored replacement queries verbatim and structurally complete', async () => {
    const raw = await readFile(
      new URL('../../../web/data/phase-f-fresh-queries-round2.json', import.meta.url),
      'utf8',
    )
    const queries = z.array(freshQuerySchema.element).length(13).parse(JSON.parse(raw))

    expect(new Set(queries.map((query) => query.query_text))).toHaveLength(13)
    expect(queries.map((query) => query.query_text)).toEqual([
      '一只小猫穿着衣服躺在地上',
      '有人在打高尔夫的场景',
      '人和小猫玩足球游戏，画面中有球网',
      '人站在舞台上，空中飘着很多彩带',
      '有人朝海里扔石头',
      '一个人抱着一只小猫，对视',
      '有人正在包饺子',
      '有人晚上面朝大海坐在海边',
      '一个人抱着一束花',
      '给小猫的耳朵滴药水',
      '一个人在给一只小猫洗澡',
      '一个红头发的人在做操',
      '一个人坐在桌前做手工',
    ])
  })
})
