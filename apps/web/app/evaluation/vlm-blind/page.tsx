import packetData from '../../../data/phase-f-vlm-candidate-review.json'
import { VlmBlindCandidateReviewWorkspace } from '../../../components/vlm-blind-candidate-review-workspace'
import { createApiClient, type VlmBlindCandidateReviewPacket } from '../../../lib/api-client'

export const dynamic = 'force-dynamic'

/**
 * Server Component 只读取已持久化的审核批次。打开页面不会自动导入、抽帧或
 * 调用 VLM；首次导入必须由用户点击明确按钮。
 */
export default async function VlmBlindCandidateReviewPage() {
  const client = createApiClient()
  const datasets = await client.listVlmBlindDatasets()
  const latest = datasets.at(-1)
  const initialDataset = latest ? await client.getVlmBlindDataset(latest.id) : null
  const initialLabeling =
    latest && initialDataset?.status === 'frozen'
      ? await client.getVlmBlindLabeling(latest.id)
      : null
  return (
    <VlmBlindCandidateReviewWorkspace
      initialDataset={initialDataset}
      initialLabeling={initialLabeling}
      packet={packetData as VlmBlindCandidateReviewPacket}
    />
  )
}
