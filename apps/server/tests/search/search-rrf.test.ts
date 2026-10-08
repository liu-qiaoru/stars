import { describe, expect, test } from 'vitest'
import { buildRrfSearchResults, type RrfSourceCandidate } from '../../src/search/search-rrf.js'

function candidate(
  overrides: Partial<RrfSourceCandidate> & Pick<RrfSourceCandidate, 'asset_id' | 'source_signal'>,
): RrfSourceCandidate {
  const sourceKey =
    overrides.source_signal === 'visual'
      ? 'video_frame_vectors'
      : overrides.source_signal === 'caption'
        ? 'caption_text_vectors'
        : 'text_search'
  return {
    file_id: 'file-1',
    media_type: 'video',
    path: '/media/example.mp4',
    start_time_seconds: 10,
    end_time_seconds: 20,
    scene_id: 'scene-1',
    best_frame_time_seconds: null,
    reason:
      overrides.source_signal === 'visual'
        ? 'vector_match'
        : overrides.source_signal === 'caption'
          ? 'caption_match'
          : 'transcript_match',
    source_key: sourceKey,
    source_score: 0.8,
    ...overrides,
  }
}

describe('RRF production search adapter', () => {
  test('preserves the winning visual frame and actual caption asset separately after image identity folding', () => {
    const [result] = buildRrfSearchResults([
      candidate({ asset_id: 'source-image', source_signal: 'visual', media_type: 'image', scene_id: null }),
      candidate({ asset_id: 'source-image', evidence_asset_id: 'caption-evidence', source_signal: 'caption', media_type: 'image', scene_id: null }),
    ], { limit: 20, offset: 0, includeDiagnostics: false })
    expect(result?.source_matches).toEqual([
      { asset_id: 'source-image', source: 'vector_match', frame_time_seconds: null },
      { asset_id: 'caption-evidence', source: 'caption_match', frame_time_seconds: null },
    ])
  })
  test('merges visual and Caption evidence by stable video scene identity', () => {
    const results = buildRrfSearchResults(
      [
        candidate({
          asset_id: 'frame-asset',
          source_signal: 'visual',
          source_score: 0.72,
          best_frame_time_seconds: 15,
        }),
        candidate({
          asset_id: 'caption-asset',
          source_signal: 'caption',
          source_score: 0.93,
        }),
      ],
      { limit: 10, offset: 0, includeDiagnostics: true },
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      asset_id: 'frame-asset',
      merged_asset_ids: ['frame-asset', 'caption-asset'],
      scene_id: 'scene-1',
      best_frame_time_seconds: 15,
      reasons: ['vector_match', 'caption_match'],
      source_scores: {
        video_frame_vectors: 0.72,
        caption_text_vectors: 0.93,
      },
      score: 1 / 61 + 1 / 61,
      score_kind: 'rrf_score',
      ranking_diagnostics: {
        source_ranks: { visual: 1, caption: 1 },
        rrf_contributions: { visual: 1 / 61, caption: 1 / 61 },
        primary_signal: 'visual',
      },
    })
  })

  test('rebuilds continuous source ranks after hydration and uses semantic tie-breaking', () => {
    const results = buildRrfSearchResults(
      [
        candidate({
          asset_id: 'scene-b-frame',
          source_signal: 'visual',
          scene_id: 'scene-b',
          source_score: 0.8,
        }),
        candidate({
          asset_id: 'scene-a-frame',
          source_signal: 'visual',
          scene_id: 'scene-a',
          source_score: 0.8,
        }),
        candidate({
          asset_id: 'scene-b-caption',
          source_signal: 'caption',
          scene_id: 'scene-b',
          source_score: 0.4,
        }),
      ],
      { limit: 10, offset: 0, includeDiagnostics: true },
    )

    // visual 原始分数并列时按 scene UUID 稳定排序，因此 scene-a=1、scene-b=2。
    // scene-b 同时拥有 Caption 第 1 名，最终 RRF 应排在只命中 visual 的 scene-a 前面。
    expect(results.map((result) => result.scene_id)).toEqual(['scene-b', 'scene-a'])
    expect(results[0]?.ranking_diagnostics?.source_ranks).toEqual({ visual: 2, caption: 1 })
    expect(results[1]?.ranking_diagnostics?.source_ranks).toEqual({ visual: 1 })
  })

  test('ranks image and video collections as one continuous visual signal', () => {
    const results = buildRrfSearchResults(
      [
        candidate({
          asset_id: 'video-frame',
          source_signal: 'visual',
          source_key: 'video_frame_vectors',
          source_score: 0.7,
        }),
        candidate({
          asset_id: 'image-asset',
          file_id: 'image-file',
          media_type: 'image',
          path: 'image.jpg',
          scene_id: null,
          start_time_seconds: null,
          end_time_seconds: null,
          source_signal: 'visual',
          source_key: 'image_vectors',
          source_score: 0.9,
        }),
      ],
      { limit: 10, offset: 0, includeDiagnostics: true },
    )

    expect(results.map((result) => result.ranking_diagnostics?.source_ranks.visual)).toEqual([1, 2])
  })

  test('merges image visual and Caption evidence by the canonical image Asset ID', () => {
    const results = buildRrfSearchResults(
      [
        candidate({
          asset_id: 'image-asset',
          file_id: 'image-file',
          media_type: 'image',
          path: '/media/image.jpg',
          scene_id: null,
          start_time_seconds: null,
          end_time_seconds: null,
          source_signal: 'visual',
        }),
        candidate({
          // PostgreSQL 回表会把图片 Caption 的业务身份规范为源图片 Asset ID。
          // 这里复现规范化后的输入，防止同一张图片在融合结果中占据两个位置。
          asset_id: 'image-asset',
          file_id: 'image-file',
          media_type: 'image',
          path: '/media/image.jpg',
          scene_id: null,
          start_time_seconds: null,
          end_time_seconds: null,
          source_signal: 'caption',
        }),
      ],
      { limit: 10, offset: 0, includeDiagnostics: true },
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      asset_id: 'image-asset',
      reasons: ['vector_match', 'caption_match'],
      score: 1 / 61 + 1 / 61,
    })
  })

  test('uses image Asset ID and transcript Asset ID when no video scene exists', () => {
    const results = buildRrfSearchResults(
      [
        candidate({
          asset_id: 'image-asset',
          file_id: 'image-file',
          media_type: 'image',
          path: '/media/image.jpg',
          scene_id: null,
          start_time_seconds: null,
          end_time_seconds: null,
          source_signal: 'visual',
        }),
        candidate({
          asset_id: 'transcript-asset',
          file_id: 'audio-file',
          media_type: 'audio',
          path: '/media/interview.mp3',
          scene_id: null,
          source_signal: 'lexical',
        }),
      ],
      { limit: 10, offset: 0, includeDiagnostics: false },
    )

    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ranking_diagnostics === undefined)).toBe(true)
    expect(results.map((result) => result.asset_id).sort()).toEqual([
      'image-asset',
      'transcript-asset',
    ])
  })

  test('applies Top-K and offset only after RRF fusion with stable pagination', () => {
    const inputs = ['scene-c', 'scene-a', 'scene-b'].map((sceneId) =>
      candidate({
        asset_id: `${sceneId}-frame`,
        scene_id: sceneId,
        source_signal: 'visual',
        source_score: 0.7,
      }),
    )

    const firstPage = buildRrfSearchResults(inputs, {
      limit: 2,
      offset: 0,
      includeDiagnostics: false,
    })
    const secondPage = buildRrfSearchResults(inputs, {
      limit: 2,
      offset: 2,
      includeDiagnostics: false,
    })

    expect(firstPage.map((result) => result.scene_id)).toEqual(['scene-a', 'scene-b'])
    expect(secondPage.map((result) => result.scene_id)).toEqual(['scene-c'])
  })

  test('fails fast when one scene identity carries conflicting file or time facts', () => {
    expect(() =>
      buildRrfSearchResults(
        [
          candidate({
            asset_id: 'frame',
            source_signal: 'visual',
            file_id: 'file-a',
            start_time_seconds: 10,
            end_time_seconds: 20,
          }),
          candidate({
            asset_id: 'caption',
            source_signal: 'caption',
            file_id: 'file-b',
            start_time_seconds: 30,
            end_time_seconds: 40,
          }),
        ],
        { limit: 10, offset: 0, includeDiagnostics: false },
      ),
    ).toThrow('conflicting facts for RRF candidate video:scene-1')
  })

  test('fails fast when a required RRF candidate has no source channel', () => {
    expect(() =>
      buildRrfSearchResults(
        [
          candidate({
            asset_id: 'broken',
            source_signal: undefined as never,
          }),
        ],
        { limit: 10, offset: 0, includeDiagnostics: false },
      ),
    ).toThrow('unsupported RRF source signal')
  })
})
