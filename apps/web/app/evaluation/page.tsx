import { EvaluationWorkspace } from '../../components/evaluation-workspace'
import { createApiClient } from '../../lib/api-client'

export const dynamic = 'force-dynamic'

export default async function EvaluationPage() {
  const client = createApiClient()
  const [{ items: sets }, { items: libraries }] = await Promise.all([
    client.listEvaluationSets(),
    client.listLibraries(),
  ])
  return <EvaluationWorkspace initialSets={sets} libraries={libraries} />
}
