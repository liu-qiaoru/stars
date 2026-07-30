import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { JobsWorkspace } from '../components/jobs-workspace'

const refresh = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

const job = {
  id: 'job-1',
  job_type: 'scan_library',
  status: 'queued',
  progress: 0,
  file_paths: ['/media'],
  error_message: null,
  created_at: '2026-07-07T00:00:00Z',
  updated_at: '2026-07-07T00:00:00Z',
}

beforeEach(() => {
  refresh.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('jobs workspace', () => {
  test('shows how many jobs are visible out of the backend total', () => {
    render(<JobsWorkspace jobs={[job]} total={160} limit={500} offset={0} />)

    expect(screen.getByText('1 / 160 个任务')).toBeInTheDocument()
    expect(screen.getByText('job-1')).toBeInTheDocument()
  })

  test('renders pagination links when there are more jobs than the current page', () => {
    render(<JobsWorkspace jobs={[job]} total={700} limit={500} offset={0} />)

    expect(screen.getByRole('link', { name: '下一页' })).toHaveAttribute(
      'href',
      '/jobs?limit=500&offset=500',
    )
  })

  test('refreshes the current server-rendered jobs list', () => {
    render(<JobsWorkspace jobs={[job]} total={160} limit={500} offset={0} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新任务' }))

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('automatically refreshes the current page every five seconds while visible', () => {
    vi.useFakeTimers()
    render(<JobsWorkspace jobs={[job]} total={160} limit={25} offset={25} />)

    vi.advanceTimersByTime(10_000)

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(screen.getByText('第 2 / 7 页')).toBeInTheDocument()
  })

  test('shows structured failure details and retries as a new queued job', async () => {
    const retryJob = vi.fn().mockResolvedValue({ job_id: 'retry-1', status: 'queued' })
    render(
      <JobsWorkspace
        jobs={[
          {
            ...job,
            id: 'failed-job',
            status: 'failed',
            error_message: 'ffprobe exited with code 1',
            error_code: 'SCENE_DETECTION_FAILED',
            error_details: { stage: 'scene_detection', stderr: 'invalid stream' },
          },
        ]}
        total={1}
        limit={500}
        offset={0}
        apiClient={{ retryJob }}
      />,
    )

    expect(screen.getByText('失败原因：ffprobe exited with code 1')).toBeInTheDocument()
    expect(screen.getByText('错误码：SCENE_DETECTION_FAILED')).toBeInTheDocument()
    fireEvent.click(screen.getByText('查看技术详情'))
    expect(screen.getByText(/invalid stream/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '修复后重试' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已创建重试任务 retry-1')
    expect(retryJob).toHaveBeenCalledWith('failed-job')
  })

  test('shows the file path associated with each job', () => {
    render(
      <JobsWorkspace
        jobs={[
          {
            ...job,
            id: 'path-job',
            file_paths: ['/media/clip.mp4'],
          },
          {
            ...job,
            id: 'batch-job',
            job_type: 'run_ocr',
            file_paths: ['/media/a.png', '/media/b.png'],
          },
        ]}
        total={2}
        limit={500}
        offset={0}
      />,
    )

    expect(screen.getByText('/media/clip.mp4')).toBeInTheDocument()
    expect(screen.getByText('/media/a.png 等 2 个文件')).toBeInTheDocument()
  })

  test('uses a processing progress style for running jobs', () => {
    render(
      <JobsWorkspace
        jobs={[
          {
            ...job,
            id: 'running-job',
            status: 'running',
            progress: 12,
          },
        ]}
        total={1}
        limit={500}
        offset={0}
      />,
    )

    expect(screen.getByLabelText('12% 进度')).toHaveClass('processing')
  })
})
