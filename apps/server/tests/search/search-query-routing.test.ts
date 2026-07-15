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
  test('gives a faithful translation equal weight only in SigLIP visual collections', () => {
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'translate')).toEqual([
      variants[0],
      { ...variants[1], weight: 1 },
    ])
    expect(routeQueryVariantsForCollection(variants, 'image_vectors', 'translate')).toEqual([
      variants[0],
      { ...variants[1], weight: 1 },
    ])
    expect(routeQueryVariantsForCollection(variants, 'video_segment_vectors', 'translate')).toEqual([
      variants[0],
      { ...variants[1], weight: 1 },
    ])
  })

  test('keeps Caption translation weights and full expansion weights unchanged', () => {
    expect(routeQueryVariantsForCollection(variants, 'caption_text_vectors', 'translate')).toEqual(
      variants,
    )
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'expand')).toEqual(
      variants,
    )
    expect(routeQueryVariantsForCollection(variants, 'video_frame_vectors', 'original')).toEqual(
      variants,
    )
  })
})
