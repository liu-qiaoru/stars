import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SearchWorkspace } from '../components/search-workspace'

describe('SearchWorkspace', () => {
  test('shows a visible loading state and preserves results when search fails', async () => {
    let rejectSearch!: (reason: Error) => void
    const searchMedia = vi.fn(
      () => new Promise<never>((_resolve, reject) => (rejectSearch = reject)),
    )
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="old"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [
            {
              asset_id: 'old-result',
              file_id: 'file-old',
              media_type: 'image',
              path: '/media/old.jpg',
              start_time_seconds: null,
              end_time_seconds: null,
              score: 0.8,
            },
          ],
          groups: [],
        }}
        apiClient={{ searchMedia }}
      />,
    )

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'new query' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByRole('status')).toHaveTextContent('正在检索')
    expect(screen.getByLabelText('搜索关键词')).toBeDisabled()
    rejectSearch(new Error('model service unavailable'))
    expect(await screen.findByRole('alert')).toHaveTextContent('搜索失败')
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText('/media/old.jpg')).toBeInTheDocument()
  })

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
            {
              asset_id: 'asset-4',
              file_id: 'file-4',
              media_type: 'audio',
              path: '/media/interview.wav',
              start_time_seconds: null,
              end_time_seconds: null,
              scene_id: null,
              score: 0.74,
              score_kind: 'hybrid_score',
              primary_reason: 'transcript_match',
              reasons: ['transcript_match'],
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
    expect(within(hybridRegion).getAllByText('转写命中')).toHaveLength(2)
    expect(within(hybridRegion).getByLabelText('/media/launch.mp4')).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-2/content#t=120,150',
    )
    expect(within(hybridRegion).getByLabelText('/media/interview.wav')).toHaveClass(
      'media-audio-thumb',
    )
    expect(screen.getByRole('button', { name: '音频' })).toBeInTheDocument()
    expect(screen.getByText('主素材库')).toBeInTheDocument()
  })

  test('renders image search results from the media content endpoint', () => {
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="poster"
        initialResults={{
          limit: 20,
          offset: 0,
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
          groups: [],
        }}
      />,
    )

    expect(screen.getByRole('img', { name: '/media/keynote.jpg' })).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-1/content',
    )
  })

  test('labels low-confidence hybrid results', () => {
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="用户输入的原始短语"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [
            {
              asset_id: 'asset-low',
              file_id: 'file-low',
              media_type: 'video',
              path: '/media/weak-match.mp4',
              start_time_seconds: 12,
              end_time_seconds: 12,
              score: 0.02,
              score_kind: 'hybrid_score',
              primary_reason: 'vector_match',
              confidence: 'low',
            },
          ],
          groups: [],
        }}
      />,
    )

    expect(screen.getByText('相关性较弱')).toBeInTheDocument()
    expect(screen.getByText('未找到高相关结果，以下是弱相关候选。')).toBeInTheDocument()
  })

  test('opens media preview dialogs from image, video, and audio result cards', () => {
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="preview"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [
            {
              asset_id: 'asset-image',
              file_id: 'file-image',
              media_type: 'image',
              path: '/media/keynote.jpg',
              start_time_seconds: null,
              end_time_seconds: null,
              score: 0.91,
              reason: 'vector_match',
            },
            {
              asset_id: 'asset-video',
              file_id: 'file-video',
              media_type: 'video',
              path: '/media/launch.mp4',
              start_time_seconds: 120,
              end_time_seconds: 150,
              score: 0.88,
              reason: 'vector_match',
            },
            {
              asset_id: 'asset-audio',
              file_id: 'file-audio',
              media_type: 'audio',
              path: '/media/interview.wav',
              start_time_seconds: 30,
              end_time_seconds: 55,
              score: 0.72,
              reason: 'transcript_match',
            },
          ],
          groups: [],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '预览 /media/keynote.jpg' }))
    let dialog = screen.getByRole('dialog', { name: '预览 /media/keynote.jpg' })
    expect(within(dialog).getByRole('img', { name: '/media/keynote.jpg' })).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-image/content',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭预览' }))
    fireEvent.click(screen.getByRole('button', { name: '预览 /media/launch.mp4' }))
    dialog = screen.getByRole('dialog', { name: '预览 /media/launch.mp4' })
    expect(within(dialog).getByLabelText('/media/launch.mp4')).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-video/content#t=120,150',
    )
    expect(within(dialog).getByLabelText('/media/launch.mp4')).toHaveAttribute('controls')

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '预览 /media/interview.wav' }))
    dialog = screen.getByRole('dialog', { name: '预览 /media/interview.wav' })
    expect(within(dialog).getByLabelText('/media/interview.wav')).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-audio/content#t=30,55',
    )
    expect(within(dialog).getByLabelText('/media/interview.wav')).toHaveAttribute('controls')
  })
})
