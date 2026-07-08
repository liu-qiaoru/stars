import { notFound } from 'next/navigation'
import { MediaDetailWorkspace } from '../../../components/media-detail-workspace'
import { createApiClient } from '../../../lib/api-client'

export const dynamic = 'force-dynamic'

export default async function MediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const media = await createApiClient().getMedia(id)
    return <MediaDetailWorkspace media={media} />
  } catch {
    notFound()
  }
}
