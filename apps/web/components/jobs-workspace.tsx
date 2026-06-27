import type { JobSummary } from '../lib/api-client'
import { formatJobType, formatStatus } from '../lib/display-labels'

export function JobsWorkspace({ jobs }: { jobs: JobSummary[] }) {
  // Jobs 页面是 PostgreSQL-backed 队列的只读窗口；worker 进度、失败原因和完成状态都来自后端。
  return (
    <section className="panel">
      <p className="eyebrow">任务</p>
      <h1 className="page-title">后台活动</h1>
      <div className="mt-5 overflow-hidden rounded-[16px] border border-[var(--hairline)]">
        {jobs.map((job) => (
          <article key={job.id} className="job-row">
            <div>
              <h2 className="card-title">{formatJobType(job.job_type)}</h2>
              <p className="muted">{job.id}</p>
            </div>
            <div className="progress-track" aria-label={`${job.progress}% 进度`}>
              <span style={{ width: `${job.progress}%` }} />
            </div>
            <span className={job.status === 'failed' ? 'status-chip error' : 'status-chip'}>
              {formatStatus(job.status)}
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}
