import { LibraryWorkspace } from '../../components/library-workspace'
import { createApiClient } from '../../lib/api-client'

export const dynamic = 'force-dynamic'

export default async function LibrariesPage() {
  const { items } = await createApiClient().listLibraries()
  return <LibraryWorkspace libraries={items} />
}
