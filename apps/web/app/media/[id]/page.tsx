import Link from 'next/link'
import { notFound } from 'next/navigation'
import { MediaDetailWorkspace } from '../../../components/media-detail-workspace'
import { createApiClient } from '../../../lib/api-client'

export const dynamic = 'force-dynamic'

export default async function MediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const media = await createApiClient().getMedia(id)
    return (
      <section className="space-y-4">
        <nav aria-label="返回媒体来源" className="flex flex-wrap gap-3 text-sm">
          <Link className="secondary-action" href="/search">
            返回搜索
          </Link>
          <Link className="secondary-action" href="/libraries">
            返回素材库
          </Link>
        </nav>
        <MediaDetailWorkspace media={media} />
      </section>
    )
  } catch {
    notFound()
  }
}
