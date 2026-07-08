"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { JobSummary } from "../lib/api-client";
import { formatJobType, formatStatus } from "../lib/display-labels";

export function JobsWorkspace({
  jobs,
  total,
  limit,
  offset,
}: {
  jobs: JobSummary[];
  total: number;
  limit: number;
  offset: number;
}) {
  // Jobs 页面是 PostgreSQL-backed 队列的只读窗口；worker 进度、失败原因和完成状态都来自后端。
  const router = useRouter();
  const previousOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrevious = offset > 0;
  const hasNext = nextOffset < total;

  return (
    <section className="panel">
      <p className="eyebrow">任务</p>
      <h1 className="page-title">后台活动</h1>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="muted">
          {jobs.length} / {total} 个任务
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="secondary-action"
            type="button"
            aria-label="刷新任务"
            onClick={() => router.refresh()}
          >
            <RefreshCw aria-hidden="true" size={16} />
            <span>刷新</span>
          </button>
          {hasPrevious || hasNext ? (
            <nav className="flex gap-2" aria-label="任务分页">
              {hasPrevious ? (
                <Link
                  className="secondary-action"
                  href={`/jobs?limit=${limit}&offset=${previousOffset}`}
                >
                  上一页
                </Link>
              ) : null}
              {hasNext ? (
                <Link
                  className="secondary-action"
                  href={`/jobs?limit=${limit}&offset=${nextOffset}`}
                >
                  下一页
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
      <div className="mt-5 overflow-hidden rounded-lg border border-[var(--hairline)]">
        {jobs.length > 0 ? (
          jobs.map((job) => (
            <article key={job.id} className="job-row">
              <div>
                <h2 className="card-title">{formatJobType(job.job_type)}</h2>
                <p className="muted">{job.id}</p>
                {job.file_paths.length > 0 ? (
                  <p className="muted mt-1 truncate">{formatJobFilePaths(job.file_paths)}</p>
                ) : null}
                {job.status === "failed" && job.error_message ? (
                  <p className="muted mt-2">失败原因：{job.error_message}</p>
                ) : null}
              </div>
              <div
                className={
                  job.status === "running"
                    ? "progress-track processing"
                    : "progress-track"
                }
                aria-label={`${job.progress}% 进度`}
              >
                <span style={{ width: `${job.progress}%` }} />
              </div>
              <span
                className={
                  job.status === "failed" ? "status-chip error" : "status-chip"
                }
              >
                {formatStatus(job.status)}
              </span>
            </article>
          ))
        ) : (
          <div className="empty-panel">暂无任务。</div>
        )}
      </div>
    </section>
  );
}

function formatJobFilePaths(filePaths: string[]) {
  if (filePaths.length <= 1) {
    return filePaths[0] ?? "";
  }
  return `${filePaths[0]} 等 ${filePaths.length} 个文件`;
}
