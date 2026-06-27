import { exportClipInputSchema, indexMediaInputSchema } from '@local-media-agent/shared/schemas'
import { mediaTypes } from '@local-media-agent/shared/constants'
import { tool, zodSchema } from 'ai'
import { z } from 'zod'
import type { MediaService } from '../media/media.service.js'
import type { SearchService } from '../search/search.service.js'
import type { AgentToolDefinition } from './agent.types.js'

const searchMediaInputSchema = z.object({
  query: z.string().min(1),
  media_types: z.array(z.enum(mediaTypes)).optional().default(['image', 'video', 'audio']),
  library_ids: z.array(z.string().uuid()).optional().default([]),
  limit: z.number().int().min(1).max(20).optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
})

const getMediaDetailInputSchema = z.object({
  file_id: z.string().uuid(),
})

function sideEffectConfirmation(
  toolName: string,
  input: unknown,
  options?: { toolCallId?: string },
) {
  return {
    confirmation_required: true,
    tool_call_id: options?.toolCallId,
    tool_name: toolName,
    input,
  }
}

function sanitizeSearchOutput(output: Awaited<ReturnType<SearchService['search']>>) {
  // 不把本机绝对路径暴露给外部 LLM；前端/API 仍可看到 path，Agent tool 输出只保留候选语义字段。
  return {
    ...output,
    results: output.results.map(({ path: _path, ...result }) => result),
    groups: output.groups.map((group) => ({
      ...group,
      results: group.results.map(({ path: _path, ...result }) => result),
    })),
  }
}

function sanitizeMediaDetail(output: Awaited<ReturnType<MediaService['getMedia']>>) {
  // Media detail 可能包含 cache_path、OCR/transcript 全文等本地敏感信息，给模型前做最小化。
  const { path: _path, assets, ...media } = output
  return {
    ...media,
    assets: assets.map(({ cache_path: _cachePath, text_content: _textContent, ...asset }) => asset),
  }
}

export function createAgentTools({
  searchService,
  mediaService,
}: {
  searchService: SearchService
  mediaService: MediaService
}) {
  return {
    search_media: tool({
      description: 'Search indexed image, video, and audio candidates by text query.',
      inputSchema: zodSchema(searchMediaInputSchema),
      execute: async (input) =>
        sanitizeSearchOutput(await searchService.search(searchMediaInputSchema.parse(input))),
    }) as unknown as AgentToolDefinition,
    get_media_detail: tool({
      description: 'Fetch one media file with its metadata and indexed assets.',
      inputSchema: zodSchema(getMediaDetailInputSchema),
      execute: async (input) => {
        const parsed = getMediaDetailInputSchema.parse(input)
        return sanitizeMediaDetail(await mediaService.getMedia(parsed.file_id))
      },
    }) as unknown as AgentToolDefinition,
    create_index_job: tool({
      description: 'Request creating an index_media job. This requires user confirmation.',
      inputSchema: zodSchema(indexMediaInputSchema),
      execute: async (input, options) =>
        // 返回 confirmation payload，而不是直接创建 job；AgentService.confirmToolCall 才执行副作用。
        sideEffectConfirmation('create_index_job', indexMediaInputSchema.parse(input), options),
    }) as unknown as AgentToolDefinition,
    export_clip: tool({
      description: 'Request exporting a clip. This requires user confirmation.',
      inputSchema: zodSchema(exportClipInputSchema),
      execute: async (input, options) =>
        sideEffectConfirmation('export_clip', exportClipInputSchema.parse(input), options),
    }) as unknown as AgentToolDefinition,
  }
}
