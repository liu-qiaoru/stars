import { MediaDetailWorkspace } from '../../../components/media-detail-workspace'
import { createApiClient } from '../../../lib/api-client'
import { demoMediaDetail } from '../../../lib/demo-data'

export default async function MediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (id === 'demo') {
    return <MediaDetailWorkspace media={demoMediaDetail} />
  }

  try {
    const media = await createApiClient().getMedia(id)
    return <MediaDetailWorkspace media={media} />
  } catch {
    return <MediaDetailWorkspace media={{ ...demoMediaDetail, id }} />
  }
}
