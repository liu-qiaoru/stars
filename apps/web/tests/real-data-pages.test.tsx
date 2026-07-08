import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as JobsPageModule from '../app/jobs/page'
import * as LibrariesPageModule from '../app/libraries/page'
import * as MediaPageModule from '../app/media/[id]/page'
import * as SearchPageModule from '../app/search/page'

const JobsPage = JobsPageModule.default
const LibrariesPage = LibrariesPageModule.default
const MediaPage = MediaPageModule.default
const SearchPage = SearchPageModule.default

const apiClient = vi.hoisted(() => ({
  getMedia: vi.fn(),
  listJobs: vi.fn(),
  listLibraries: vi.fn(),
}))

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  refresh: vi.fn(),
  useRouter: vi.fn(() => ({ refresh: navigation.refresh })),
}))

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return {
    ...actual,
    createApiClient: () => apiClient,
  }
})

vi.mock('next/navigation', () => navigation)

beforeEach(() => {
  apiClient.getMedia.mockReset()
  apiClient.listJobs.mockReset()
  apiClient.listLibraries.mockReset()
  navigation.notFound.mockClear()
  navigation.refresh.mockClear()
})

describe('real data pages', () => {
  test('API-backed pages render dynamically instead of prerendering demo or stale data', () => {
    expect(LibrariesPageModule.dynamic).toBe('force-dynamic')
    expect(SearchPageModule.dynamic).toBe('force-dynamic')
    expect(JobsPageModule.dynamic).toBe('force-dynamic')
    expect(MediaPageModule.dynamic).toBe('force-dynamic')
  })

  test('libraries page renders libraries from the API', async () => {
    apiClient.listLibraries.mockResolvedValueOnce({
      items: [
        {
          id: 'real-library',
          name: '真实素材库',
          root_path: '/Users/qiao/Movies',
          enabled: true,
          media_count: 3,
          indexed_count: 2,
          failed_count: 0,
        },
      ],
    })

    render(await LibrariesPage())

    expect(apiClient.listLibraries).toHaveBeenCalledTimes(1)
    expect(screen.getByText('真实素材库')).toBeInTheDocument()
    expect(screen.getByText('/Users/qiao/Movies')).toBeInTheDocument()
    expect(screen.queryByText('/本地媒体')).not.toBeInTheDocument()
  })

  test('search page starts empty and uses real libraries as filters', async () => {
    apiClient.listLibraries.mockResolvedValueOnce({
      items: [
        {
          id: 'real-library',
          name: '真实素材库',
          root_path: '/Users/qiao/Movies',
          enabled: true,
          media_count: 3,
        },
      ],
    })

    render(await SearchPage())

    expect(apiClient.listLibraries).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('搜索关键词')).toHaveValue('')
    expect(screen.getByText('真实素材库')).toBeInTheDocument()
    expect(screen.getAllByText('0 条结果')).toHaveLength(2)
    expect(screen.queryByText('/本地媒体/发布会/主视觉.jpg')).not.toBeInTheDocument()
  })

  test('jobs page renders jobs from the API', async () => {
    apiClient.listJobs.mockResolvedValueOnce({
      total: 1,
      limit: 500,
      offset: 0,
      items: [
        {
          id: 'real-job',
          job_type: 'scan_library',
          status: 'running',
          progress: 35,
          file_paths: ['/Users/qiao/Movies'],
          error_message: null,
          created_at: '2026-07-07T00:00:00Z',
          updated_at: '2026-07-07T00:01:00Z',
        },
      ],
    })

    render(await JobsPage({ searchParams: Promise.resolve({}) }))

    expect(apiClient.listJobs).toHaveBeenCalledWith({ limit: 500, offset: 0 })
    expect(screen.getByText('real-job')).toBeInTheDocument()
    expect(screen.getByText('/Users/qiao/Movies')).toBeInTheDocument()
    expect(screen.queryByText('扫描任务示例')).not.toBeInTheDocument()
  })

  test('media page returns not found instead of rendering demo fallback', async () => {
    apiClient.getMedia.mockRejectedValueOnce(new Error('missing'))

    await expect(MediaPage({ params: Promise.resolve({ id: 'missing' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    )

    expect(apiClient.getMedia).toHaveBeenCalledWith('missing')
    expect(navigation.notFound).toHaveBeenCalledTimes(1)
  })
})
