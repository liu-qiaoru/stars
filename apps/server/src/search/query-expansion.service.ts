import { BadGatewayException, Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'

export interface QueryVariant {
  text: string
  weight: number
  source: 'original' | 'deepseek'
}

export const queryExpansionModes = ['original', 'translate', 'expand'] as const
export type QueryExpansionMode = (typeof queryExpansionModes)[number]

const deepseekResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    }),
  ),
})

const expansionPayloadSchema = z.object({
  variants: z.array(
    z.object({
      text: z.string(),
      weight: z.number().optional(),
    }),
  ),
})

const translationValidationSchema = z.object({
  equivalent: z.boolean(),
  issues: z.array(z.string()).default([]),
})

@Injectable()
export class QueryExpansionService {
  private readonly logger = new Logger(QueryExpansionService.name)

  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  async expand(query: string, mode: QueryExpansionMode = 'expand'): Promise<QueryVariant[]> {
    const original = this.originalVariant(query)
    if (mode === 'original') {
      this.logger.log('query_expansion_mode=original provider=skipped variants=1')
      return [original]
    }
    if (this.settings.queryExpansionProvider === 'none') {
      this.logger.log(`query_expansion_mode=${mode} provider=none query_expansion=disabled`)
      return [original]
    }
    if (this.settings.queryExpansionProvider === 'deepseek') {
      this.logger.log(
        `query_expansion_mode=${mode} provider=deepseek api_key=${this.settings.deepseekApiKey ? 'set' : 'unset'} query_expansion=enabled model=${this.settings.deepseekModel}`,
      )
      return this.expandWithDeepSeek(original, mode)
    }
    this.logger.log(
      `provider=${this.settings.queryExpansionProvider} api_key=unset query_expansion=unsupported`,
    )
    return [original]
  }

  private async expandWithDeepSeek(
    original: QueryVariant,
    mode: Exclude<QueryExpansionMode, 'original'>,
  ) {
    if (!this.settings.deepseekApiKey) {
      throw new BadGatewayException('DEEPSEEK_API_KEY is required for query expansion')
    }

    const startedAt = performance.now()
    const payload = await this.requestDeepSeekJson({
      operation: 'query expansion',
      system:
        mode === 'translate'
          ? 'You faithfully translate short media-search queries. Return strict JSON only.'
          : 'You expand short user queries for image and video semantic search. Return strict JSON only.',
      user:
        mode === 'translate'
          ? this.translationPrompt(original.text)
          : this.expansionPrompt(original.text),
      temperature: 0.2,
    })

    const parsedPayload = expansionPayloadSchema.safeParse(payload)
    if (!parsedPayload.success) {
      throw new BadGatewayException(
        `DeepSeek query expansion returned invalid variants: ${parsedPayload.error.message}`,
      )
    }

    const maxVariants =
      mode === 'translate'
        ? Math.min(2, this.settings.queryExpansionMaxVariants)
        : this.settings.queryExpansionMaxVariants
    const normalized = this.normalizeVariants(original, parsedPayload.data.variants, maxVariants)
    if (mode === 'translate') {
      const translation = normalized.find((variant) => variant.source === 'deepseek')
      if (!translation) {
        throw new BadGatewayException('DeepSeek faithful translation returned no translation')
      }
      // “忠实翻译”是评测变量，不允许只靠生成 Prompt 自我约束：第二次独立判断会比较
      // 原文与译文是否保留相同人物、物体、动作和关系，失败时明确中止本次搜索。
      await this.validateFaithfulTranslation(original.text, translation.text)
    }
    this.logger.log(
      `query_expansion_mode=${mode} provider=deepseek max_variants=${maxVariants} duration_ms=${Math.round(performance.now() - startedAt)} variants=${normalized
        .map((variant) => `"${variant.text}"@${variant.weight.toFixed(2)} ${variant.source}`)
        .join(', ')}`,
    )
    return normalized
  }

  private async validateFaithfulTranslation(original: string, translation: string) {
    const payload = await this.requestDeepSeekJson({
      operation: 'faithful translation validation',
      system:
        'You verify semantic equivalence between a source media-search query and its translation. Return strict JSON only.',
      user: [
        'Check whether the English translation preserves every object, action, relationship, and constraint.',
        'Reject additions such as a new location, activity, object property, or changed spatial relationship.',
        'Return JSON with shape: {"equivalent":true,"issues":[]}',
        `Source query: ${original}`,
        `English translation: ${translation}`,
      ].join('\n'),
      temperature: 0,
    })
    const parsed = translationValidationSchema.safeParse(payload)
    if (!parsed.success) {
      throw new BadGatewayException(
        `DeepSeek faithful translation validation returned invalid payload: ${parsed.error.message}`,
      )
    }
    if (!parsed.data.equivalent) {
      // 不把模型返回的 issues 拼进异常，避免日志再次记录用户查询内容；失败类型已经足够排查。
      throw new BadGatewayException(
        'DeepSeek faithful translation validation rejected the translation',
      )
    }
  }

  private async requestDeepSeekJson(input: {
    operation: string
    system: string
    user: string
    temperature: number
  }): Promise<unknown> {
    const response = await fetch(
      `${this.settings.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.settings.deepseekApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.settings.deepseekModel,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          response_format: { type: 'json_object' },
          stream: false,
          temperature: input.temperature,
        }),
        signal: AbortSignal.timeout(this.settings.queryExpansionTimeoutMs),
      },
    )
    if (!response.ok) {
      throw new BadGatewayException(`DeepSeek ${input.operation} failed with ${response.status}`)
    }
    const parsedResponse = deepseekResponseSchema.safeParse(await response.json())
    if (!parsedResponse.success) {
      throw new BadGatewayException(
        `DeepSeek ${input.operation} returned invalid response: ${parsedResponse.error.message}`,
      )
    }
    const content = parsedResponse.data.choices[0]?.message.content
    if (!content) {
      throw new BadGatewayException(`DeepSeek ${input.operation} returned empty content`)
    }
    try {
      return JSON.parse(content)
    } catch {
      throw new BadGatewayException(`DeepSeek ${input.operation} returned non-JSON content`)
    }
  }

  private originalVariant(query: string): QueryVariant {
    return { text: query.trim(), weight: 1, source: 'original' }
  }

  private normalizeVariants(
    original: QueryVariant,
    variants: Array<{ text: string; weight?: number }>,
    maxVariants: number,
  ): QueryVariant[] {
    const normalized = new Map<string, QueryVariant>()
    normalized.set(original.text, original)

    for (const variant of variants) {
      const text = variant.text.trim()
      if (!text) {
        continue
      }
      const weight = clamp(variant.weight ?? 0.85, 0.1, 1)
      const existing = normalized.get(text)
      const next: QueryVariant = {
        text,
        weight: text === original.text ? 1 : weight,
        source: text === original.text ? 'original' : 'deepseek',
      }
      if (!existing || next.weight > existing.weight) {
        normalized.set(text, next)
      }
    }

    return [...normalized.values()]
      .sort((left, right) => right.weight - left.weight)
      .slice(0, maxVariants)
  }

  private translationPrompt(query: string) {
    return [
      'Translate the user query into natural English for image/video semantic search.',
      'Preserve every object, action, and relationship from the original query.',
      'Do not add a location, intent, object property, or inferred activity.',
      'For example, do not change leaning against into resting on or standing near.',
      'Return exactly one translated variant.',
      'Return JSON with shape: {"variants":[{"text":"...","weight":0.9}]}',
      `User query: ${query}`,
    ].join('\n')
  }

  private expansionPrompt(query: string) {
    return [
      'Expand the user query into phrases suitable for image/video semantic search.',
      'Keep the original query.',
      'Include Chinese, English translation, and visual scene phrasing when useful.',
      `Return at most ${this.settings.queryExpansionMaxVariants} variants in total, including the original query.`,
      'Avoid overly broad phrases such as person, object, image, video.',
      'Return JSON with shape: {"variants":[{"text":"...","weight":1.0}]}',
      `User query: ${query}`,
    ].join('\n')
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
