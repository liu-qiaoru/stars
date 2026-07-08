import { SearchWorkspace } from '../../components/search-workspace'
import { createApiClient, type SearchResponse } from '../../lib/api-client'

export const dynamic = 'force-dynamic'

const emptySearchResponse = {
  limit: 20,
  offset: 0,
  results: [],
  groups: [],
} satisfies SearchResponse

export default async function SearchPage() {
  const { items } = await createApiClient().listLibraries()
  return (
    <SearchWorkspace
      libraries={items}
      initialQuery=""
      initialResults={emptySearchResponse}
    />
  )
}
