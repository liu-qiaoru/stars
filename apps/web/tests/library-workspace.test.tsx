import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryWorkspace } from '../components/library-workspace'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const library = {
  id: 'lib-1',
  name: '主素材库',
  root_path: '/media',
  enabled: true,
  media_count: 30,
  indexed_count: 20,
  failed_count: 1,
}

beforeEach(() => push.mockReset())

describe('LibraryWorkspace', () => {
  test('uses file icons without a table header or type column', async () => {
    const listLibraryMedia = vi.fn().mockResolvedValue({
      items: [
        { id: 'image-1', relative_path: 'a.jpg', media_type: 'image', index_status: 'indexed' },
        { id: 'video-1', relative_path: 'b.mp4', media_type: 'video', index_status: 'probed' },
      ],
      total: 2,
      limit: 25,
      offset: 0,
    })
    render(
      <LibraryWorkspace
        libraries={[library]}
        apiClient={{ listLibraryMedia, scanLibrary: vi.fn(), createLibrary: vi.fn() }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '查看文件 30' }))
    await screen.findByRole('link', { name: /a.jpg/ })

    expect(screen.queryByText('文件名')).not.toBeInTheDocument()
    expect(screen.queryByText('类型')).not.toBeInTheDocument()
    expect(screen.queryByText('图片')).not.toBeInTheDocument()
    expect(screen.queryByText('视频')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-type-icon-image')).toBeInTheDocument()
    expect(screen.getByTestId('file-type-icon-video')).toBeInTheDocument()
  })

  test('loads files only after expansion and appends the next page', async () => {
    const listLibraryMedia = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'file-1', relative_path: 'a.jpg', media_type: 'image', index_status: 'indexed' },
        ],
        total: 2,
        limit: 25,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'file-2', relative_path: 'b.mp4', media_type: 'video', index_status: 'probed' },
        ],
        total: 2,
        limit: 25,
        offset: 1,
      })
    render(
      <LibraryWorkspace
        libraries={[library]}
        apiClient={{ listLibraryMedia, scanLibrary: vi.fn(), createLibrary: vi.fn() }}
      />,
    )

    expect(listLibraryMedia).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看文件 30' }))
    expect(await screen.findByRole('link', { name: /a.jpg/ })).toHaveAttribute(
      'href',
      '/media/file-1',
    )
    expect(listLibraryMedia).toHaveBeenNthCalledWith(1, 'lib-1', { limit: 25, offset: 0 })

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByRole('link', { name: /b.mp4/ })).toBeInTheDocument()
    expect(screen.getByText('已探测')).toBeInTheDocument()
    expect(screen.getByText('已显示 2 / 2')).toBeInTheDocument()
    expect(listLibraryMedia).toHaveBeenNthCalledWith(2, 'lib-1', { limit: 25, offset: 1 })

    fireEvent.click(screen.getByRole('button', { name: '收起文件' }))
    fireEvent.click(screen.getByRole('button', { name: '查看文件 30' }))
    expect(listLibraryMedia).toHaveBeenCalledTimes(2)
  })

  test('preserves loaded rows and offers retry when loading fails', async () => {
    const listLibraryMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error('API request failed: 500'))
      .mockResolvedValueOnce({ items: [], total: 0, limit: 25, offset: 0 })
    render(
      <LibraryWorkspace
        libraries={[library]}
        apiClient={{ listLibraryMedia, scanLibrary: vi.fn(), createLibrary: vi.fn() }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '查看文件 30' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('加载文件失败')
    fireEvent.click(screen.getByRole('button', { name: '重试加载文件' }))
    await waitFor(() => expect(listLibraryMedia).toHaveBeenCalledTimes(2))
  })

  test('disables scan while creating the job, redirects on success, and reports failure', async () => {
    let resolveScan!: (value: { job_id: string; status: string }) => void
    const scanLibrary = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ job_id: string; status: string }>((resolve) => (resolveScan = resolve)),
      )
      .mockRejectedValueOnce(new Error('API request failed: 500'))
    render(
      <LibraryWorkspace
        libraries={[library]}
        apiClient={{ listLibraryMedia: vi.fn(), scanLibrary, createLibrary: vi.fn() }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '扫描' }))
    expect(screen.getByRole('button', { name: '正在创建任务' })).toBeDisabled()
    resolveScan({ job_id: 'job-1', status: 'queued' })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/jobs'))

    fireEvent.click(screen.getByRole('button', { name: '扫描' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('创建扫描任务失败')
    expect(push).toHaveBeenCalledTimes(1)
  })
})
