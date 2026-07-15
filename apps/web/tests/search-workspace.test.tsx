import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SearchWorkspace } from '../components/search-workspace'

describe('SearchWorkspace', () => {
  test('sends the selected query expansion mode and diagnostics option', async () => {
    const searchMedia = vi.fn().mockResolvedValue({ limit: 20, offset: 0, results: [], groups: [] })
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="旧查询"
        initialResults={{ limit: 20, offset: 0, results: [], groups: [] }}
        apiClient={{ searchMedia }}
      />,
    )

    expect(screen.queryByRole('dialog', { name: '搜索设置' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '搜索设置' }))
    const settings = screen.getByRole('dialog', { name: '搜索设置' })
    fireEvent.click(within(settings).getByRole('radio', { name: /忠实翻译/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '显示检索诊断' }))
    fireEvent.change(screen.getByLabelText('搜索关键词'), {
      target: { value: '一个人靠着石头' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() =>
      expect(searchMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          query: '一个人靠着石头',
          query_expansion_mode: 'translate',
          include_diagnostics: true,
        }),
      ),
    )
  })

  test('closes search settings with Escape', () => {
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery=""
        initialResults={{ limit: 20, offset: 0, results: [], groups: [] }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '搜索设置' }))
    expect(screen.getByRole('dialog', { name: '搜索设置' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '搜索设置' })).not.toBeInTheDocument()
  })

  test('renders caption and winning query variant diagnostics', () => {
    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="一个人靠着石头"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [],
          query_diagnostics: {
            query_expansion_mode: 'translate',
            query_variants: [
              { text: '一个人靠着石头', weight: 1, source: 'original' },
              { text: 'a person leaning against a rock', weight: 0.9, source: 'deepseek' },
            ],
          },
          groups: [
            {
              collection: 'caption_text_vectors',
              score_kind: 'cosine_similarity',
              results: [
                {
                  asset_id: 'caption-1',
                  file_id: 'file-1',
                  media_type: 'video',
                  path: '/media/scene.mp4',
                  start_time_seconds: 10,
                  end_time_seconds: 20,
                  scene_id: 'scene-1',
                  score: 0.63,
                  reason: 'caption_match',
                  diagnostics: {
                    source_rank: 1,
                    caption: {
                      text: '一个人背靠岩石站立。',
                      prompt_version: 'scene-caption-v2',
                    },
                    query_variant_hits: [
                      {
                        text: 'a person leaning against a rock',
                        source: 'deepseek',
                        weight: 0.9,
                        raw_score: 0.7,
                        weighted_score: 0.63,
                        winning: true,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }}
      />,
    )

    const region = screen.getByRole('region', { name: '检索诊断' })
    expect(within(region).getByText('基础查询版本')).toBeInTheDocument()
    expect(within(region).getByText(/视觉通道会提升到同等权重/)).toBeInTheDocument()
    expect(within(region).getByText('一个人背靠岩石站立。')).toBeInTheDocument()
    expect(within(region).getByText('scene-caption-v2')).toBeInTheDocument()
    expect(within(region).getByText(/胜出 · 加权 0.6300/)).toBeInTheDocument()
  })

  test('renders up to five best visual frames from different scenes in diagnostics', () => {
    const visualResults = [
      { sceneId: 'scene-1', assetId: 'frame-1-best', time: 12.4, score: 0.82 },
      // scene-1 的第二张帧分数更低，不能重复占用诊断卡片。
      { sceneId: 'scene-1', assetId: 'frame-1-lower', time: 14.1, score: 0.79 },
      { sceneId: 'scene-2', assetId: 'frame-2', time: 24, score: 0.75 },
      { sceneId: 'scene-3', assetId: 'frame-3', time: 36, score: 0.7 },
      { sceneId: 'scene-4', assetId: 'frame-4', time: 48, score: 0.65 },
      { sceneId: 'scene-5', assetId: 'frame-5', time: 60, score: 0.6 },
      // 默认只加载前五个不同场景，避免诊断页同时请求过多本地视频流。
      { sceneId: 'scene-6', assetId: 'frame-6', time: 72, score: 0.55 },
    ].map(({ sceneId, assetId, time, score }, index) => ({
      asset_id: assetId,
      file_id: `file-${sceneId}`,
      media_type: 'video' as const,
      path: `/media/${sceneId}.mp4`,
      start_time_seconds: time,
      end_time_seconds: time,
      scene_id: sceneId,
      score,
      reason: 'vector_match',
      diagnostics: {
        source_rank: index + 1,
        query_variant_hits: [
          {
            text: 'a person leaning against a rock',
            source: 'deepseek' as const,
            weight: 0.9,
            raw_score: score / 0.9,
            weighted_score: score,
            winning: true,
          },
        ],
      },
    }))

    render(
      <SearchWorkspace
        libraries={[]}
        initialQuery="一个人靠着石头"
        initialResults={{
          limit: 20,
          offset: 0,
          results: [],
          query_diagnostics: {
            query_expansion_mode: 'translate',
            query_variants: [
              { text: '一个人靠着石头', weight: 1, source: 'original' },
              { text: 'a person leaning against a rock', weight: 0.9, source: 'deepseek' },
            ],
          },
          groups: [
            {
              collection: 'video_frame_vectors',
              score_kind: 'cosine_similarity',
              results: [
                ...visualResults,
                {
                  asset_id: 'frame-without-scene',
                  file_id: 'file-incomplete',
                  media_type: 'video',
                  path: '/media/incomplete.mp4',
                  start_time_seconds: 80,
                  end_time_seconds: 80,
                  scene_id: null,
                  score: 0.5,
                  reason: 'vector_match',
                  diagnostics: { source_rank: 8, query_variant_hits: [] },
                },
              ],
            },
          ],
        }}
      />,
    )

    const visualRegion = screen.getByRole('region', { name: '视觉通道最佳命中帧' })
    expect(within(visualRegion).getAllByRole('button', { name: /预览视觉命中帧/ })).toHaveLength(5)
    expect(within(visualRegion).getByText('帧排名 #1')).toBeInTheDocument()
    expect(within(visualRegion).getByText('00:12.40')).toBeInTheDocument()
    expect(within(visualRegion).getByText('0.9111')).toBeInTheDocument()
    expect(within(visualRegion).getByText('查询加权分 0.8200')).toBeInTheDocument()
    expect(within(visualRegion).getByRole('status')).toHaveTextContent('1 条视觉帧缺少 scene_id')
    expect(within(visualRegion).getAllByText('a person leaning against a rock')).toHaveLength(5)
    expect(within(visualRegion).getByLabelText('scene-1 在 12.40 秒的命中帧')).toHaveAttribute(
      'src',
      'http://127.0.0.1:4000/media/file-scene-1/content#t=12.4',
    )
    expect(within(visualRegion).queryByLabelText('scene-1 在 14.10 秒的命中帧')).not.toBeInTheDocument()
    expect(within(visualRegion).queryByText('scene-6')).not.toBeInTheDocument()
  })

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
