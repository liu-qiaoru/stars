import { describe, expect, test } from 'vitest'
import { routeQueryVariantsForCollection } from '../../src/search/search-query-routing.js'

const variants = [
  { text: '人物站在海边，单手比耶', source: 'original' as const, weight: 1 },
  {
    text: 'a person standing by the sea and making a V sign with one hand',
    source: 'deepseek' as const,
    weight: 0.9,
  },
]

describe('collection-specific query routing', () => {
  test('uses only the faithful English translation in SigLIP visual collections', () => {
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'translate')).toEqual([
      { ...variants[1], weight: 1 },
    ])
    expect(routeQueryVariantsForCollection(variants, 'image_vectors', 'translate')).toEqual([
      { ...variants[1], weight: 1 },
    ])
    expect(routeQueryVariantsForCollection(variants, 'video_segment_vectors', 'translate')).toEqual([
      { ...variants[1], weight: 1 },
    ])
  })

  test('uses only the original Chinese query in the Caption collection', () => {
    expect(routeQueryVariantsForCollection(variants, 'caption_text_vectors', 'translate')).toEqual(
      [variants[0]],
    )
  })

  test('keeps full expansion and original-only experiments unchanged', () => {
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'expand')).toEqual(
      variants,
    )
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'original')).toEqual(
      variants,
    )
  })
})
