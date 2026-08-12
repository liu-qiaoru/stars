import packetData from '../../../data/phase9a-c2-blind-packet.json'
import {
  Phase9aC2BlindWorkspace,
  type Phase9aC2BlindPacket,
} from '../../../components/phase9a-c2-blind-workspace'
import Link from 'next/link'

/**
 * 独立的 Phase 9A-C2 本地盲标入口。
 * 冻结 JSON 在构建时作为只读属性传给浏览器；页面不会请求模型或写评测数据库。
 */
export default function Phase9aC2BlindPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
  return (
    <section className="space-y-4">
      <nav aria-label="面包屑">
        <Link className="secondary-action" href="/evaluation">
          返回评测主页
        </Link>
      </nav>
      <Phase9aC2BlindWorkspace
        apiBaseUrl={apiBaseUrl.replace(/\/$/, '')}
        packet={packetData as Phase9aC2BlindPacket}
      />
    </section>
  )
}
