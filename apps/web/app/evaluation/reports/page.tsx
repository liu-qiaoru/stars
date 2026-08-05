import { EvaluationReportsWorkspace } from '../../../components/evaluation-reports-workspace'
import { createApiClient } from '../../../lib/api-client'

export const dynamic = 'force-dynamic'

/** 服务端先取最近 25 次轻量历史，具体候选证据由浏览器在用户选择报告后按需读取。 */
export default async function EvaluationReportsPage() {
  const client = createApiClient()
  const response = await client.listEvaluationRuns({ limit: 25, offset: 0 })
  return <EvaluationReportsWorkspace initialRuns={response.items} total={response.total} />
}
