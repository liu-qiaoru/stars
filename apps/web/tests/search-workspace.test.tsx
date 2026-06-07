import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { SearchWorkspace } from '../components/search-workspace'

describe('SearchWorkspace', () => {
  test('renders grouped vector results without flattening collection scores', () => {
    render(
      <SearchWorkspace
        libraries={[
          { id: 'lib-1', name: '主素材库', root_path: '/media', enabled: true, media_count: 4 },
        ]}
        initialQuery="launch"
        initialResults={{
          limit: 20,
          offset: 0,
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

    const imageGroup = screen.getByRole('region', { name: /图片向量/i })
    const videoGroup = screen.getByRole('region', { name: /视频片段向量/i })
    expect(within(imageGroup).getByText('/media/keynote.jpg')).toBeInTheDocument()
    expect(within(videoGroup).getByText('2:00 – 2:30')).toBeInTheDocument()
    expect(screen.getByText('主素材库')).toBeInTheDocument()
  })
})
