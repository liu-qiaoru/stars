import { notFound } from 'next/navigation'
import { ShadowRerankPanel } from '../../../../components/shadow-rerank-panel'
import { EvaluationBreadcrumbs } from '../../../../components/evaluation-breadcrumbs'
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
      <EvaluationBreadcrumbs
        items={[
          { label: '评测主页', href: '/evaluation' },
          { label: '历史报告', href: '/evaluation/reports' },
          { label: '运行详情' },
        ]}
      />
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
