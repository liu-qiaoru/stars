import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ShadowRerankPanel } from '../../../../components/shadow-rerank-panel'
import { createApiClient } from '../../../../lib/api-client'

export const dynamic = 'force-dynamic'

/** 运行详情只读 PostgreSQL 快照；打开页面不会重新搜索，也不会调用任何 Provider。 */
export default async function EvaluationRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const client = createApiClient()
  let run
  try {
    run = await client.getEvaluationRun(id)
  } catch {
    notFound()
  }
  return (
    <section className="space-y-6">
      <nav aria-label="面包屑" className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          className="text-blue-700 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-blue-600"
          href="/evaluation"
        >
          评测主页
        </Link>
        <span aria-hidden="true">/</span>
        <Link
          className="text-blue-700 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-blue-600"
          href="/evaluation/reports"
        >
          历史报告
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">运行详情</span>
      </nav>
      <header>
        <p className="eyebrow">Evaluation 运行详情</p>
        <h1 className="page-title">运行 {run.id}</h1>
        <p className="muted mt-2">
          状态：{run.status} · 候选 {run.candidates.length} 条
        </p>
      </header>
      {run.error_message ? (
        <p role="alert">
          {run.error_code}：{run.error_message}
        </p>
      ) : null}
      <ShadowRerankPanel evaluationRunId={run.id} canStart={run.status === 'reported'} />
    </section>
  )
}
