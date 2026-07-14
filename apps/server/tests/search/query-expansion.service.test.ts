import { describe, expect, test, vi } from 'vitest'
import type { Settings } from '../../src/config/settings.js'
import { QueryExpansionService } from '../../src/search/query-expansion.service.js'

const baseSettings = {
  queryExpansionProvider: 'deepseek',
  queryExpansionTimeoutMs: 10000,
  queryExpansionMaxVariants: 3,
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: 'test-key',
  deepseekModel: 'deepseek-v4-flash',
} as Settings

describe('QueryExpansionService modes', () => {
  test('original mode never calls the configured external provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const service = new QueryExpansionService(baseSettings)

    await expect(service.expand('一个人靠着石头', 'original')).resolves.toEqual([
      { text: '一个人靠着石头', weight: 1, source: 'original' },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('translate mode keeps the original and one faithful translation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  variants: [
                    { text: 'a person leaning against a rock', weight: 0.9 },
                    { text: 'person resting on a roadside stone', weight: 0.8 },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const service = new QueryExpansionService(baseSettings)

    await expect(service.expand('一个人靠着石头', 'translate')).resolves.toEqual([
      { text: '一个人靠着石头', weight: 1, source: 'original' },
      { text: 'a person leaning against a rock', weight: 0.9, source: 'deepseek' },
    ])

    const request = fetchSpy.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[1]?.content).toContain('Preserve every object, action, and relationship')
    expect(body.messages[1]?.content).toContain('Return exactly one translated variant')
  })
})
