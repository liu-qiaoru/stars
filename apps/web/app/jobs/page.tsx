import { JobsWorkspace } from '../../components/jobs-workspace'
import { createApiClient } from '../../lib/api-client'

export const dynamic = 'force-dynamic'

interface JobsPageProps {
  searchParams?: Promise<{
    limit?: string
    offset?: string
  }>
}

const DEFAULT_LIMIT = 500

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const params = await searchParams
  const limit = parseNonNegativeInteger(params?.limit) ?? DEFAULT_LIMIT
  const offset = parseNonNegativeInteger(params?.offset) ?? 0
  const { items, total } = await createApiClient().listJobs({ limit, offset })

  return <JobsWorkspace jobs={items} total={total} limit={limit} offset={offset} />
}

function parseNonNegativeInteger(value: string | undefined) {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : undefined
}
