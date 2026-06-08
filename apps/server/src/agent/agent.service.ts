import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { exportClipInputSchema, indexMediaInputSchema } from '@local-media-agent/shared/schemas'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'
import { DATABASE } from '../database/database.module.js'
import {
  createAgentRun,
  createAgentRunEvent,
  createAgentToolCall,
  createJob,
  getAgentRunWithEventsAndTools,
  getAgentToolCall,
  getMediaFile,
  updateAgentRun,
  updateAgentToolCall,
  type Database,
} from '../database/repositories.js'
import { MediaService } from '../media/media.service.js'
import { SearchService } from '../search/search.service.js'
import { createAgentTools } from './agent.tools.js'
import { AGENT_MODEL_RUNNER, type AgentModelRunner } from './agent.types.js'

const createRunSchema = z.object({
  prompt: z.string().min(1),
  allow_external_vlm: z.boolean().optional().default(false),
})

const confirmSchema = z.object({
  tool_call_id: z.string().min(1),
})

@Injectable()
export class AgentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(AGENT_MODEL_RUNNER) private readonly runner: AgentModelRunner,
    @Inject(SearchService) private readonly searchService: SearchService,
    @Inject(MediaService) private readonly mediaService: MediaService,
  ) {}

  async createRun(input: z.input<typeof createRunSchema>) {
    const parsed = createRunSchema.parse(input)
    const run = await createAgentRun(this.db, { prompt: parsed.prompt })
    await this.addEvent(run.id, 'run_started', { prompt: parsed.prompt })

    if (!this.settings.allowExternalLlm) {
      const summary = '外部大模型未启用；已记录任务，但不会调用云端模型。'
      await updateAgentRun(this.db, run.id, {
        status: 'succeeded',
        summary,
        finishedAt: new Date(),
      })
      await this.addEvent(run.id, 'run_succeeded', { summary })
      return { run_id: run.id, status: 'succeeded', message: summary }
    }

    try {
      const result = await this.runner.run({
        prompt: parsed.prompt,
        model: this.settings.agentModel,
        maxSteps: this.settings.agentMaxSteps,
        toolTimeoutMs: this.settings.agentToolTimeoutMs,
        tools: createAgentTools({
          searchService: this.searchService,
          mediaService: this.mediaService,
        }),
      })
      if (result.toolCalls.length > this.settings.agentMaxSteps) {
        throw new Error(`Agent returned too many tool calls: ${result.toolCalls.length}`)
      }
      const hasPendingConfirmation = await this.persistToolCalls(run.id, result.toolCalls)
      const status = hasPendingConfirmation ? 'waiting_for_confirmation' : 'succeeded'
      await updateAgentRun(this.db, run.id, {
        status,
        summary: result.summary,
        finishedAt: status === 'succeeded' ? new Date() : null,
      })
      await this.addEvent(run.id, status === 'succeeded' ? 'run_succeeded' : 'user_confirmation_pending', {
        summary: result.summary,
      })
      return { run_id: run.id, status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateAgentRun(this.db, run.id, {
        status: 'failed',
        summary: message,
        finishedAt: new Date(),
      })
      await this.addEvent(run.id, 'run_failed', { message })
      return { run_id: run.id, status: 'failed', message }
    }
  }

  async getRun(id: string) {
    const run = await getAgentRunWithEventsAndTools(this.db, id)
    if (!run) {
      throw new NotFoundException('Agent run not found')
    }

    return {
      id: run.id,
      status: run.status,
      prompt: run.prompt,
      summary: run.summary,
      tool_calls: run.toolCalls.map((call) => ({
        tool_call_id: call.toolCallId,
        name: call.toolName,
        status: call.status,
        summary: this.toolSummary(call.toolName, call.status),
        requires_confirmation: call.requiresConfirmation,
      })),
      events: run.events.map((event) => ({
        event_id: event.id,
        type: event.eventType,
        tool_call_id: event.toolCallId,
        created_at: event.createdAt.toISOString(),
        payload: event.payloadJson,
      })),
      results: run.toolCalls.flatMap((call) =>
        call.toolName === 'search_media' && call.outputJson
          ? this.searchResultsFromOutput(call.outputJson)
          : [],
      ),
    }
  }

  async confirmToolCall(runId: string, input: z.input<typeof confirmSchema>) {
    const parsed = confirmSchema.parse(input)
    const call = await getAgentToolCall(this.db, runId, parsed.tool_call_id)
    if (!call) {
      throw new NotFoundException('Agent tool call not found')
    }
    if (!call.requiresConfirmation) {
      throw new BadRequestException('Tool call does not require confirmation')
    }

    const job = await this.createConfirmedJob(call.toolName, call.inputJson)
    await updateAgentToolCall(this.db, runId, parsed.tool_call_id, {
      status: 'succeeded',
      requiresConfirmation: false,
      confirmedAt: new Date(),
      outputJson: { job_id: job.id, status: job.status },
    })
    await updateAgentRun(this.db, runId, {
      status: 'succeeded',
      finishedAt: new Date(),
    })
    await this.addEvent(runId, 'tool_call_finished', {
      tool_name: call.toolName,
      job_id: job.id,
      status: job.status,
    }, parsed.tool_call_id)
    await this.addEvent(runId, 'run_succeeded', { summary: '用户已确认副作用操作。' })

    return { job_id: job.id, status: job.status }
  }

  private async persistToolCalls(
    runId: string,
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>,
  ) {
    let hasPendingConfirmation = false
    for (const call of toolCalls) {
      await this.addEvent(runId, 'tool_call_started', { tool_name: call.toolName }, call.toolCallId)
      const confirmationRequired =
        call.toolName === 'export_clip' || call.toolName === 'create_index_job'
      const status = confirmationRequired ? 'waiting_for_confirmation' : 'succeeded'
      if (confirmationRequired) {
        hasPendingConfirmation = true
      }
      await createAgentToolCall(this.db, {
        runId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status,
        inputJson: call.input,
        outputJson: call.output,
        requiresConfirmation: confirmationRequired,
      })
      await this.addEvent(
        runId,
        confirmationRequired ? 'user_confirmation_required' : 'tool_call_finished',
        { tool_name: call.toolName, output: call.output },
        call.toolCallId,
      )
    }
    return hasPendingConfirmation
  }

  private async createConfirmedJob(toolName: string, input: unknown) {
    if (toolName === 'export_clip') {
      const parsed = exportClipInputSchema.parse(input)
      const file = await getMediaFile(this.db, parsed.file_id)
      if (!file || file.mediaType !== 'video') {
        throw new BadRequestException('export_clip requires an existing video file')
      }
      return createJob(this.db, { jobType: 'export_clip', inputJson: parsed })
    }
    if (toolName === 'create_index_job') {
      const parsed = indexMediaInputSchema.parse(input)
      return createJob(this.db, { jobType: 'index_media', inputJson: parsed })
    }
    throw new BadRequestException(`Unsupported confirmation tool: ${toolName}`)
  }

  private addEvent(runId: string, eventType: string, payloadJson: unknown, toolCallId?: string) {
    return createAgentRunEvent(this.db, {
      runId,
      eventType,
      toolCallId,
      payloadJson,
    })
  }

  private toolSummary(toolName: string, status: string) {
    return status === 'succeeded' ? `${toolName} completed` : `${toolName} waiting for confirmation`
  }

  private searchResultsFromOutput(output: unknown) {
    const value = output as {
      groups?: Array<{
        results?: Array<{
          file_id: string
          asset_id: string
          start_time_seconds: number | null
          end_time_seconds: number | null
          score: number
        }>
      }>
    }
    return (value.groups ?? []).flatMap((group) =>
      (group.results ?? []).map((result) => ({
        file_id: result.file_id,
        asset_id: result.asset_id,
        start_time_seconds: result.start_time_seconds,
        end_time_seconds: result.end_time_seconds,
        score: result.score,
        summary: 'Candidate from search_media',
      })),
    )
  }
}
