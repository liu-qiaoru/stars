import { BadGatewayException, Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'

export interface QueryVariant {
  text: string
  weight: number
  source: 'original' | 'deepseek'
}

export type QueryExpansionMode = 'original' | 'translate' | 'expand'

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
            {
              role: 'system',
              content:
                mode === 'translate'
                  ? 'You faithfully translate short media-search queries. Return strict JSON only.'
                  : 'You expand short user queries for image and video semantic search. Return strict JSON only.',
            },
            {
              role: 'user',
              content:
                mode === 'translate'
                  ? this.translationPrompt(original.text)
                  : this.expansionPrompt(original.text),
            },
          ],
          response_format: { type: 'json_object' },
          stream: false,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(this.settings.queryExpansionTimeoutMs),
      },
    )
    if (!response.ok) {
      throw new BadGatewayException(`DeepSeek query expansion failed with ${response.status}`)
    }

    const parsedResponse = deepseekResponseSchema.safeParse(await response.json())
    if (!parsedResponse.success) {
      throw new BadGatewayException(
        `DeepSeek query expansion returned invalid response: ${parsedResponse.error.message}`,
      )
    }

    const content = parsedResponse.data.choices[0]?.message.content
    if (!content) {
      return [original]
    }

    let payload: unknown
    try {
      payload = JSON.parse(content)
    } catch {
      throw new BadGatewayException('DeepSeek query expansion returned non-JSON content')
    }

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
    this.logger.log(
      `query_expansion_mode=${mode} provider=deepseek max_variants=${maxVariants} duration_ms=${Math.round(performance.now() - startedAt)} variants=${normalized
        .map((variant) => `"${variant.text}"@${variant.weight.toFixed(2)} ${variant.source}`)
        .join(', ')}`,
    )
    return normalized
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
