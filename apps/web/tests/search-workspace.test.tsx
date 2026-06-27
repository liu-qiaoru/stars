import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { SearchWorkspace } from '../components/search-workspace'

describe('SearchWorkspace', () => {
  test('renders hybrid results as the primary search list', () => {
    render(
      <SearchWorkspace
        libraries={[
          { id: 'lib-1', name: '主素材库', root_path: '/media', enabled: true, media_count: 4 },
        ]}
        initialQuery="launch"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [
            {
              asset_id: 'asset-2',
              merged_asset_ids: ['asset-2', 'asset-3'],
              file_id: 'file-2',
              media_type: 'video',
              path: '/media/launch.mp4',
              start_time_seconds: 120,
              end_time_seconds: 150,
              scene_id: null,
              score: 0.91,
              score_kind: 'hybrid_score',
              primary_reason: 'transcript_match',
              reasons: ['vector_match', 'transcript_match'],
              source_scores: {
                video_segment_vectors: 0.82,
                text_search: 0.5,
              },
            },
          ],
          groups: [
            {
              collection: 'image_vectors',
              score_kind: 'cosine_similarity',
              results: [
                {
                  asset_id: 'asset-1',
                  file_id: 'file-1',
                  media_type: 'image',
                  path: '/media/keynote.jpg',
                  start_time_seconds: null,
                  end_time_seconds: null,
                  score: 0.91,
                  reason: 'vector_match',
                },
              ],
            },
            {
              collection: 'video_segment_vectors',
              score_kind: 'cosine_similarity',
              results: [
                {
                  asset_id: 'asset-2',
                  file_id: 'file-2',
                  media_type: 'video',
                  path: '/media/launch.mp4',
                  start_time_seconds: 120,
                  end_time_seconds: 150,
                  score: 0.82,
                  reason: 'vector_match',
                },
              ],
            },
          ],
        }}
      />,
    )

    const hybridRegion = screen.getByRole('region', { name: /混合结果/i })
    expect(within(hybridRegion).getByText('/media/launch.mp4')).toBeInTheDocument()
    expect(within(hybridRegion).getByText('2:00 – 2:30')).toBeInTheDocument()
    expect(within(hybridRegion).getByText('转写命中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '音频' })).toBeInTheDocument()
    expect(screen.getByText('主素材库')).toBeInTheDocument()
  })
})
