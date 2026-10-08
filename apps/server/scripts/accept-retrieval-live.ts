/** 显式运行的付费验收：只发送下方合成转录，使用隔离数据库；不会扫描用户媒体。
 * 累计账本先记录 dispatch；保留历史失败及未知预留，不通过删除账本刷新预算。
 */
import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase } from '../tests/database/test-db.js'
import { createSettings } from '../src/config/settings.js'
import { libraries, mediaFiles, mediaAssets } from '../src/database/schema.js'
import { createDurableAgentRun, getDurableAgentRun } from '../src/agent/agent-run.repository.js'
import { QwenAgentIntentRunner } from '../src/agent/qwen-agent-intent.runner.js'
import { RightApiRetrievalDecisionRunner } from '../src/agent/retrieval-decision.runner.js'
import { RetrievalAgentHandler } from '../src/agent/retrieval-agent.handler.js'
import { AgentV1StepHandler } from '../src/agent/agent-v1-step.handler.js'
import { AgentExecutorService } from '../src/agent/agent-executor.service.js'
import { SegmentDetailsTool } from '../src/agent/segment-details.tool.js'
import { MediaController } from '../src/media/media.controller.js'
import { MediaService } from '../src/media/media.service.js'
import { MediaThumbnailService } from '../src/media/media-thumbnail.service.js'
import { Test } from '@nestjs/testing'
import { AgentController } from '../src/agent/agent.controller.js'
import { AgentService } from '../src/agent/agent.service.js'
import { AgentRuntimeConfigService } from '../src/agent/agent-runtime-config.service.js'
import { SearchService } from '../src/search/search.service.js'

loadEnvFile('../../.env')
const ledgerPath = '../../.scratch/retrieval-live-ledger.json'
type Attempt = {
  status: string
  request_bytes: number
  estimated_cost_cny?: number
  response_status?: number
  model?: string
  usage?: unknown
  shape?: unknown
  tool_arguments?: unknown
}
let ledger: { attempts: Attempt[]; runs: unknown[] } = { attempts: [], runs: [] }
try {
  ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
} catch {
  // 账本缺失不能解释为零消费；首次建账须由验收负责人显式完成。
  throw new Error('Acceptance ledger missing or unreadable; do not reset accumulated usage')
}
if (ledger.attempts.length >= 40)
  throw new Error('Acceptance request budget exhausted; no external request sent')
// 旧账本中的 received + 5xx 同样代表结果未知，不能因脚本重启获得新预算。
if (
  ledger.attempts.slice(2).some((a) => a.status === 'dispatched' || (a.response_status ?? 0) >= 500)
) {
  throw new Error(
    'Previous external result is unknown; reconcile provider usage before an explicitly authorized new run',
  )
}
// 用户 2026-10-02 明确授权新协议验收；前两次未知费用仍占预算，不重放旧 run。
const save = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
const settings = createSettings({
  ...process.env,
  ALLOW_EXTERNAL_LLM: 'true',
  AGENT_EXECUTOR_ENABLED: 'true',
  AGENT_TOOL_TIMEOUT_MS: '120000',
  AGENT_ACTIVITY_TIMEOUT_MS: '120000',
  AGENT_LEASE_DURATION_MS: '130000',
  AGENT_RETRIEVAL_TIMEOUT_MS: '600000',
  AGENT_MAX_STEPS: '6',
  AGENT_RETRIEVAL_MAX_RETRIES: '0',
})
if (!settings.rightCodeApiKey || !settings.rightCodeBaseUrl)
  throw new Error('Existing RightAPI configuration unavailable')
// 累计最多 40 次、已知费用加未知预留最多 ¥3；单次至多 24KB / 2000 token。
const request: typeof fetch = async (url, init) => {
  if (
    ledger.attempts.reduce((sum, a) => sum + (a.estimated_cost_cny ?? 0.25), 0) + 0.25 > 3 ||
    ledger.attempts.length >= 40 ||
    ledger.attempts.some((a) => a.status === 'dispatched')
  )
    throw new Error('Acceptance budget/unknown-result stop')
  const body = String(init?.body ?? '')
  const parsed = JSON.parse(body)
  if (parsed.model !== 'glm-5.3' || parsed.max_tokens > 2000 || Buffer.byteLength(body) > 24000)
    throw new Error('Acceptance request limit')
  const attempt: Attempt = { status: 'dispatched', request_bytes: Buffer.byteLength(body) }
  ledger.attempts.push(attempt)
  await save()
  const response = await fetch(url, init)
  const raw = (await response.clone().json()) as any
  attempt.status = 'received'
  attempt.response_status = response.status
  attempt.model = raw.model
  attempt.usage = raw.usage
  // 此验收只含合成数据；保留工具参数用于诊断校验失败，不保存 content/reasoning。
  attempt.tool_arguments = raw.choices?.[0]?.message?.tool_calls?.map(
    (call: any) => call.function?.arguments,
  )
  // 公开基础价输入 ¥8 / 百万 token、输出 ¥28；忽略折扣/缓存，保守估算而非账单。
  if (Number.isInteger(raw.usage?.prompt_tokens) && Number.isInteger(raw.usage?.completion_tokens))
    attempt.estimated_cost_cny =
      ((raw.usage.prompt_tokens ?? 0) * 8 +
        (raw.usage.completion_tokens ?? 0) * 28 +
        (raw.usage.cache_read_input_tokens ?? 0) * 8) /
      1_000_000
  attempt.shape = {
    stop_reason: raw.choices?.[0]?.finish_reason,
    blocks: raw.choices?.[0]?.message?.tool_calls?.map((b: any) => ({
      type: b.type,
      name: b.function?.name,
    })),
    error_type: raw.error?.type,
  }
  await save()
  console.log(
    JSON.stringify({ request: ledger.attempts.length, ...attempt, tool_arguments: undefined }),
  )
  return response
}
const database = await createTestDatabase()
let accepted = false
const directory = await mkdtemp(join(tmpdir(), 'stars-live-'))
try {
  const db = database.db
  const library = randomUUID()
  await db
    .insert(libraries)
    .values({ id: library, name: 'Synthetic acceptance only', rootPath: directory })
  // 可播放静音 WAV，仅用来校验文件有效性；文本为人工构造的索引样本，不冒称真实语音识别。
  for (const [name, transcript] of [
    [
      'orchid',
      process.argv.includes('--sufficient')
        ? 'orchid_intro: orchid watering frequency: water once per week.'
        : 'orchid_intro: orchid watering frequency is explained in the segment labeled moisture. This excerpt does not give a frequency.',
    ],
    [
      'moisture',
      process.argv.includes('--sufficient')
        ? 'moisture: soil humidity only.'
        : 'moisture watering frequency: water orchids once per week.',
    ],
  ] as const) {
    const file = randomUUID(),
      path = join(directory, `${name}.wav`)
    const wav = Buffer.alloc(44 + 16000 * 2 * 10)
    wav.write('RIFF')
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24)
    wav.writeUInt32LE(32000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(wav.length - 44, 40)
    await writeFile(path, wav)
    const info = await stat(path)
    await db.insert(mediaFiles).values({
      id: file,
      libraryId: library,
      path,
      relativePath: `${name}.wav`,
      mediaType: 'audio',
      sizeBytes: wav.length,
      mtimeMs: Math.floor(info.mtimeMs),
      durationSeconds: '10',
      indexStatus: 'indexed',
    })
    await db.insert(mediaAssets).values({
      id: randomUUID(),
      fileId: file,
      assetType: 'text_chunk',
      textContent: transcript,
      startTimeSeconds: '0',
      endTimeSeconds: '10',
    })
  }
  // spoken 路径使用真实全文检索；未使用的视觉依赖若被调用立即失败，避免悄悄降级。
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('Visual dependency not available in spoken acceptance')
      },
    },
  )
  const search = new SearchService(
    db,
    unavailable as any,
    unavailable as any,
    unavailable as any,
    settings,
  )
  const intent = new QwenAgentIntentRunner(settings, request)
  const legacy = new AgentV1StepHandler(db, settings, intent, search)
  const handler = new RetrievalAgentHandler(
    db,
    settings,
    legacy,
    search,
    new SegmentDetailsTool(db),
    new RightApiRetrievalDecisionRunner(settings, request),
  )
  const executor = new AgentExecutorService(db, settings, handler)
  if (process.argv.includes('--interactive')) {
    // 浏览器验收使用真实 Controller/Service 和执行器；仅基础设施为临时库。
    const service = new AgentService(
      db,
      settings,
      handler,
      undefined,
      undefined,
      new SegmentDetailsTool(db),
    )
    const module = await Test.createTestingModule({
      controllers: [AgentController, MediaController],
      providers: [
        { provide: MediaService, useValue: new MediaService(db) },
        {
          provide: MediaThumbnailService,
          useValue: new MediaThumbnailService(async () => {
            throw new Error('No video thumbnails in audio acceptance')
          }),
        },
        { provide: AgentService, useValue: service },
        { provide: AgentRuntimeConfigService, useValue: new AgentRuntimeConfigService(settings) },
      ],
    }).compile()
    const app = module.createNestApplication()
    app.enableCors()
    await app.listen(4000, '127.0.0.1')
    let tickActive = false
    const interval = setInterval(() => {
      if (tickActive) return
      tickActive = true
      void executor
        .runOnce()
        .then(async () => {
          const rows = await db.select().from((await import('../src/database/schema.js')).agentRuns)
          for (const row of rows) {
            const snapshot = await getDurableAgentRun(db, row.id)
            const previous = ledger.runs.findIndex((r: any) => r.run.id === row.id)
            if (previous < 0) ledger.runs.push(snapshot)
            else ledger.runs[previous] = snapshot
          }
          await save()
        })
        .finally(() => {
          tickActive = false
        })
    }, 1000)
    console.log('ISOLATED_ACCEPTANCE_API http://127.0.0.1:4000')
    await new Promise<void>((resolve) => process.once('SIGTERM', resolve))
    clearInterval(interval)
    await app.close()
    accepted = true
  } else {
    const run = await createDurableAgentRun(db, {
      prompt: 'Find an audio transcript stating how often to water an orchid.',
      allowExternalText: true,
      allowExternalVisual: false,
      allowExternalMediaText: true,
      retrievalAgent: true,
      libraryIds: [library],
      mediaTypes: ['audio'],
    })
    for (let tick = 0; tick < 25; tick++) {
      await executor.runOnce()
      const snapshot = (await getDurableAgentRun(db, run.id))!
      console.log(
        JSON.stringify({ tick, status: snapshot.run.status, steps: snapshot.steps.length }),
      )
      // 所有本地数据都是本脚本合成内容；完整原始工具结果留作验收证据。
      const previous = ledger.runs.findIndex((r: any) => r.run.id === snapshot.run.id)
      if (previous < 0) ledger.runs.push(snapshot)
      else ledger.runs[previous] = snapshot
      await save()
      if (!['queued', 'extracting_intent', 'searching'].includes(snapshot.run.status)) {
        const outputs = snapshot.steps.map((step) => step.outputJson as any)
        const final = outputs.at(-1)?.retrieval_state
        const searches = outputs.filter(
          (o) => o?.action?.action === 'search_media' && o?.tool_status === 'succeeded',
        )
        const details = outputs.filter(
          (o) => o?.action?.action === 'get_segment_details' && o?.tool_status === 'succeeded',
        )
        accepted =
          snapshot.run.status === 'succeeded' &&
          final?.stop_reason === 'found' &&
          final?.assessments?.length > 0 &&
          details.length > 0 &&
          (process.argv.includes('--sufficient') ? searches.length === 1 : searches.length >= 2)
        console.log(
          JSON.stringify({
            accepted,
            stop_reason: final?.stop_reason,
            searches: searches.length,
            details: details.length,
          }),
        )
        break
      }
    }
  }
} finally {
  await database.close()
  await rm(directory, { recursive: true, force: true })
}

if (!accepted)
  throw new Error('Live retrieval acceptance did not succeed; inspect the persisted ledger')
