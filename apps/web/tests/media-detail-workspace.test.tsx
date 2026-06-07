import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { MediaDetailWorkspace } from '../components/media-detail-workspace'
import type { MediaDetail } from '../lib/api-client'

const media: MediaDetail = {
  id: 'file-1',
  library_id: 'library-1',
  path: '/Volumes/Media/video.mp4',
  media_type: 'video',
  size_bytes: 1024 * 1024,
  duration_seconds: 120,
  width: 1920,
  height: 1080,
  codec: 'h264',
  index_status: 'indexed',
  assets_limit: 50,
  assets_offset: 0,
  assets_total: 1,
  assets: [
    {
      id: 'asset-1',
      asset_type: 'video_segment',
      start_time_seconds: 30,
      end_time_seconds: 60,
      cache_path: null,
      text_content: null,
    },
  ],
}

describe('MediaDetailWorkspace', () => {
  test('导出按钮调用 clip export API 并展示任务状态', async () => {
    const exportClip = vi.fn().mockResolvedValue({ job_id: 'job-1', status: 'queued' })

    render(<MediaDetailWorkspace media={media} apiClient={{ exportClip }} />)

    fireEvent.click(screen.getByRole('button', { name: /导出/i }))

    await waitFor(() => {
      expect(exportClip).toHaveBeenCalledWith({
        file_id: 'file-1',
        start_time_seconds: 30,
        end_time_seconds: 60,
        output_format: 'mp4',
      })
    })
    expect(await screen.findByText(/已创建导出任务 job-1/i)).toBeInTheDocument()
  })
})
