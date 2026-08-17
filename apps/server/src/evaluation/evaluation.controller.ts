import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { EvaluationService } from './evaluation.service.js'
import { ShadowRerankService } from './shadow-rerank.service.js'
import { VlmBlindDatasetService } from './vlm-blind-dataset.service.js'
import { VlmBlindCapabilityService } from './vlm-blind-capability.service.js'
import { VlmBlindLabelingService } from './vlm-blind-labeling.service.js'

@Controller('evaluation')
export class EvaluationController {
  constructor(
    // tsx 开发运行时不会可靠保留 TypeScript 构造器类型元数据，因此与其他 Controller 一样
    // 显式声明注入 Token，避免真实 /evaluation/* 路由拿到 undefined service。
    @Inject(EvaluationService)
    private readonly service: EvaluationService,
    @Inject(ShadowRerankService)
    private readonly shadowRerank: ShadowRerankService,
    @Inject(VlmBlindDatasetService)
    private readonly vlmBlindDatasets: VlmBlindDatasetService,
    @Inject(VlmBlindLabelingService)
    private readonly vlmBlindLabeling: VlmBlindLabelingService,
    @Inject(VlmBlindCapabilityService)
    private readonly vlmBlindCapability: VlmBlindCapabilityService,
  ) {}

  @Get('sets') listSets() {
    return this.service.listSets()
  }
  @Get('runs') listRuns(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('version_id') versionId?: string,
  ) {
    return this.service.listRuns({
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
      versionId,
    })
  }
  @Post('sets') createSet(@Body() body: { name: string; description?: string }) {
    return this.service.createSet(body)
  }
  @Get('targets/random') randomTargets(
    @Query('library_id') libraryId?: string,
    @Query('limit') limit?: string,
    @Query('seed') seed?: string,
  ) {
    return this.service.randomTargets({
      libraryId,
      limit: Number(limit ?? 10),
      seed: seed ?? 'default',
    })
  }
  @Get('versions/:id') getVersion(@Param('id') id: string) {
    return this.service.getVersion(id)
  }
  @Post('versions/:id/queries') addQuery(@Param('id') id: string, @Body() body: unknown) {
    return this.service.addQuery(id, body)
  }
  @Post('versions/:id/freeze') freeze(@Param('id') id: string) {
    return this.service.freezeVersion(id)
  }
  @Post('versions/:id/runs') startRun(
    @Param('id') id: string,
    @Body() body: { library_ids?: string[] },
  ) {
    return this.service.startRun(id, body)
  }
  @Get('runs/:id') getRun(@Param('id') id: string, @Query('reveal_evidence') reveal?: string) {
    return this.service.getRun(id, reveal === 'true')
  }
  @Post('runs/:runId/candidates/:candidateId/judgment') judgment(
    @Param('runId') runId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: {
      relevance?: number
      unjudgeable?: boolean
      diagnosis?: unknown
      notes?: string
    },
  ) {
    return this.service.saveJudgment(runId, candidateId, body)
  }
  @Post('runs/:id/finalize') finalize(@Param('id') id: string) {
    return this.service.finalizeRun(id)
  }

  @Post('runs/:id/shadow-rerank') startShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.startAndSchedule(id)
  }

  /** 显式创建新的执行身份；旧 attempt 保持只读，避免第二次 smoke 覆盖第一次审计。 */
  @Post('runs/:id/shadow-rerank/retry')
  retryShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.retryAndSchedule(id)
  }

  @Get('runs/:id/shadow-rerank') getShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.findByEvaluationRun(id)
  }

  @Get('runs/:id/shadow-rerank/preflight') previewShadowRerank(@Param('id') id: string) {
    return this.shadowRerank.preview(id)
  }

  /**
   * 记录维护者从阿里云模型监控核对到的用量。API 使用 snake_case，Service 再转换为
   * 领域字段；该接口只补充预算审计，不修改 Provider 响应、排名或 Evaluation 标签。
   */
  @Post('shadow-rerank/attempts/:id/usage-reconciliation')
  reconcileShadowUsage(
    @Param('id') id: string,
    @Body()
    body: {
      source: 'aliyun_model_monitor'
      provider_request_id: string
      total_tokens: number
      text_input_tokens: number
      image_input_tokens: number
    },
  ) {
    return this.shadowRerank.reconcileUsage(id, {
      source: body.source,
      providerRequestId: body.provider_request_id,
      totalTokens: body.total_tokens,
      textInputTokens: body.text_input_tokens,
      imageInputTokens: body.image_input_tokens,
    })
  }

  /** Phase F 当前只暴露本地候选审核数据；这些路由不会调用 VLM Provider。 */
  @Get('vlm-blind/datasets') listVlmBlindDatasets() {
    return this.vlmBlindDatasets.list()
  }

  @Get('vlm-blind/datasets/:datasetId') getVlmBlindDataset(@Param('datasetId') datasetId: string) {
    return this.vlmBlindDatasets.get(datasetId)
  }

  @Post('vlm-blind/datasets') importVlmBlindDataset(
    @Body() body: { name: string; packet: unknown },
  ) {
    return this.vlmBlindDatasets.importCandidateReviewPacket(body)
  }

  @Post('vlm-blind/datasets/:datasetId/cases/:caseId/review')
  reviewVlmBlindCandidate(
    @Param('datasetId') datasetId: string,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ) {
    return this.vlmBlindDatasets.reviewCandidate(datasetId, caseId, body)
  }

  /**
   * 从已有批次和一次显式指定的新冻结 run 生成查询替代。source run 只扩展候选读取范围，
   * 不在此路由内触发 Search、Qdrant 写入或 VLM 调用。
   */
  @Post('vlm-blind/datasets/:datasetId/replacements')
  generateVlmBlindReplacements(
    @Param('datasetId') datasetId: string,
    @Body() body: { source_evaluation_run_id?: string },
  ) {
    return this.vlmBlindDatasets.generateRejectedReplacements(
      datasetId,
      body.source_evaluation_run_id,
    )
  }

  /** 五组人工分布失衡时追加 pending 后继；accepted 前代保持只读审计。 */
  @Post('vlm-blind/datasets/:datasetId/rebalance')
  rebalanceVlmBlindDataset(@Param('datasetId') datasetId: string) {
    return this.vlmBlindDatasets.rebalanceAcceptedGroups(datasetId)
  }

  /** 最终候选完整性校验通过后冻结本地事实；不构建或派发任何 VLM 请求。 */
  @Post('vlm-blind/datasets/:datasetId/freeze')
  freezeVlmBlindDataset(@Param('datasetId') datasetId: string) {
    return this.vlmBlindDatasets.freezeCandidateReview(datasetId)
  }

  /** 读取独立人工标签进度；不会在 GET 中创建 Job 或执行 Provider。 */
  @Get('vlm-blind/datasets/:datasetId/labeling')
  getVlmBlindLabeling(@Param('datasetId') datasetId: string) {
    return this.vlmBlindLabeling.get(datasetId)
  }

  /** 仅复用冻结 Evaluation candidate 创建 all_indexed_frames_v1 后台 Job。 */
  @Post('vlm-blind/datasets/:datasetId/evidence')
  prepareVlmBlindEvidence(@Param('datasetId') datasetId: string) {
    return this.vlmBlindLabeling.prepareEvidence(datasetId)
  }

  @Post('vlm-blind/datasets/:datasetId/cases/:caseId/conditions/:conditionId/labels/:stage')
  saveVlmBlindConditionLabel(
    @Param('datasetId') datasetId: string,
    @Param('caseId') caseId: string,
    @Param('conditionId') conditionId: string,
    @Param('stage') stage: string,
    @Body() body: unknown,
  ) {
    return this.vlmBlindLabeling.saveConditionLabel(datasetId, caseId, conditionId, stage, body)
  }

  @Post('vlm-blind/datasets/:datasetId/labels/freeze')
  freezeVlmBlindLabels(@Param('datasetId') datasetId: string) {
    return this.vlmBlindLabeling.freezeLabels(datasetId)
  }

  /** 标签冻结后只运行本地 fake 协议演练；真实 Provider 适配器仍不存在。 */
  @Post('vlm-blind/datasets/:datasetId/fake-run')
  runVlmBlindFake(@Param('datasetId') datasetId: string) {
    return this.vlmBlindLabeling.runFake(datasetId)
  }

  /** 只读构造真实请求摘要；不会创建 run、写授权或调用 Provider。 */
  @Get('vlm-blind/datasets/:datasetId/real-preflight')
  preflightVlmBlindReal(@Param('datasetId') datasetId: string) {
    return this.vlmBlindCapability.preflight(datasetId)
  }

  /** 五个冻结候选类型各选一条；只返回真实请求摘要，不发送任何媒体。 */
  @Get('vlm-blind/datasets/:datasetId/real-smoke-preflight')
  preflightVlmBlindSmoke(@Param('datasetId') datasetId: string) {
    return this.vlmBlindCapability.smokePreflight(datasetId)
  }

  /** 独立视觉授权绑定当前 preflight 指纹，不能由文本 AgentIntent 授权替代。 */
  @Post('vlm-blind/datasets/:datasetId/visual-authorizations')
  authorizeVlmBlindReal(@Param('datasetId') datasetId: string, @Body() body: unknown) {
    return this.vlmBlindCapability.authorize(datasetId, body)
  }

  /** Smoke 授权只绑定五条已展示的请求，不能启动 84 次正式运行。 */
  @Post('vlm-blind/datasets/:datasetId/smoke-visual-authorizations')
  authorizeVlmBlindSmoke(@Param('datasetId') datasetId: string, @Body() body: unknown) {
    return this.vlmBlindCapability.authorizeSmoke(datasetId, body)
  }

  @Post('vlm-blind/datasets/:datasetId/real-runs')
  startVlmBlindReal(@Param('datasetId') datasetId: string) {
    return this.vlmBlindCapability.startAndSchedule(datasetId)
  }

  @Post('vlm-blind/datasets/:datasetId/real-smoke-runs')
  startVlmBlindSmoke(@Param('datasetId') datasetId: string) {
    return this.vlmBlindCapability.startSmokeAndSchedule(datasetId)
  }

  /** 历史报告只读取 PostgreSQL，不重新构造图片请求。 */
  @Get('vlm-blind/datasets/:datasetId/real-runs')
  listVlmBlindReal(@Param('datasetId') datasetId: string) {
    return this.vlmBlindCapability.listRuns(datasetId)
  }

  @Get('vlm-blind/real-runs/:runId')
  getVlmBlindReal(@Param('runId') runId: string) {
    return this.vlmBlindCapability.getRun(runId)
  }

  @Post('vlm-blind/real-runs/:runId/retry-unknown')
  retryUnknownVlmBlindReal(@Param('runId') runId: string, @Body() body: unknown) {
    return this.vlmBlindCapability.retryUnknownAndSchedule(runId, body)
  }
}
