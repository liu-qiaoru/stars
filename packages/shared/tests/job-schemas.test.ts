import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { jobInputSchemas, jobOutputSchemas } from '../schemas/index.js'

describe('job schemas', () => {
  it('records scene and frame counts on index_media output without legacy segment/fallback fields', () => {
    // 阶段 2 后 index_media 输出不再有 segment_strategy / fallback / keyframe_density：
    // 场景检测要么成功写出 video_scenes 与 video_frame，要么结构化失败。
    const output = jobOutputSchemas.index_media.parse({
      assets_created: 12,
      vector_refs_created: 12,
      collections: ['video_frame_vectors'],
      scenes_detected: 1,
      frames_created: 12,
    })

    expect(output.collections).toEqual(['video_frame_vectors'])
    expect(output.scenes_detected).toBe(1)
    expect(output.frames_created).toBe(12)
    expect(output).not.toHaveProperty('segment_strategy')
    expect(output).not.toHaveProperty('fallback')
    expect(output).not.toHaveProperty('keyframe_density')
  })

  it('validates transcribe_audio input and output', () => {
    const input = jobInputSchemas.transcribe_audio.parse({
      file_id: '11111111-1111-4111-8111-111111111111',
      path: '/media/interview.mp3',
      media_type: 'audio',
      model: 'base',
      language: 'auto',
    })
    const output = jobOutputSchemas.transcribe_audio.parse({
      chunks_created: 2,
      language: 'zh',
      duration_seconds: 31.5,
    })

    expect(input.media_type).toBe('audio')
    expect(output.chunks_created).toBe(2)
  })

  it('no longer defines a run_ocr job after OCR removal', () => {
    // OCR 能力（PaddleOCR）已在阶段 2 整体删除；run_ocr 不应再出现在 job schema 注册表。
    expect(jobInputSchemas).not.toHaveProperty('run_ocr')
    expect(jobOutputSchemas).not.toHaveProperty('run_ocr')
  })

  it('defines a purge_video_index job for destructive per-file reindex', () => {
    // 阶段 3：purge_video_index 接收 file_id，输出清理计数与递增后的 index_generation。
    const input = jobInputSchemas.purge_video_index.parse({
      file_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(input.file_id).toBe('11111111-1111-4111-8111-111111111111')

    const output = jobOutputSchemas.purge_video_index.parse({
      points_deleted: 12,
      vector_refs_deleted: 12,
      assets_deleted: 13,
      scenes_deleted: 1,
      index_generation: 2,
      reindex_job_created: true,
    })
    expect(output.index_generation).toBe(2)
    expect(output.reindex_job_created).toBe(true)
  })

  it('embed_video_frame only targets video_frame_vectors after segment vector removal', () => {
    const input = jobInputSchemas.embed_video_frame.parse({
      asset_id: '11111111-1111-4111-8111-111111111111',
      frame_path: '/cache/frame.jpg',
      frame_time_seconds: 5.0,
      collection: 'video_frame_vectors',
      model_name: 'google/siglip2-base-patch16-224',
      model_version: 'siglip2-base-patch16-224',
    })

    expect(input.collection).toBe('video_frame_vectors')
    // video_segment_vectors 已不再是合法集合。
    expect(() =>
      jobInputSchemas.embed_video_frame.parse({
        ...input,
        collection: 'video_segment_vectors',
      }),
    ).toThrow()
  })

  it('accepts caption-v1 image sources and scene-caption-v2 scene_id sources', () => {
    const file_id = '11111111-1111-4111-8111-111111111111'

    // 图片 caption（caption-v1）继续用 source_asset_ids 给出图片 asset。
    const imageCaption = jobInputSchemas.generate_caption.parse({
      file_id,
      prompt_version: 'caption-v1',
      source_asset_ids: ['22222222-2222-4222-8222-222222222222'],
    })
    expect(imageCaption.prompt_version).toBe('caption-v1')

    // 视频场景 caption（scene-caption-v2）改用正式 video_scenes.id，不再传 source_asset_ids。
    const sceneCaption = jobInputSchemas.generate_caption.parse({
      file_id,
      prompt_version: 'scene-caption-v2',
      scene_id: '33333333-3333-4333-8333-333333333333',
    })
    expect(sceneCaption.prompt_version).toBe('scene-caption-v2')
    expect(sceneCaption.scene_id).toBe('33333333-3333-4333-8333-333333333333')

    expect(() =>
      jobInputSchemas.generate_caption.parse({ file_id, prompt_version: 'caption-v3' }),
    ).toThrow()
  })

  it('allows Agent exports to carry a stable request identity without changing legacy clip requests', () => {
    const legacy = jobInputSchemas.export_clip.parse({
      file_id: '11111111-1111-4111-8111-111111111111',
      start_time_seconds: 10,
      end_time_seconds: 20,
      output_format: 'mp4',
    })
    const agent = jobInputSchemas.export_clip.parse({
      ...legacy,
      export_request_id: '22222222-2222-4222-8222-222222222222',
    })

    expect(legacy).not.toHaveProperty('export_request_id')
    expect(agent.export_request_id).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('validates the local candidate evidence job without accepting unknown strategies or invalid frames', () => {
    const input = jobInputSchemas.build_candidate_evidence.parse({
      candidate_key: 'video:scene-1',
      file_id: '11111111-1111-4111-8111-111111111111',
      file_generation: 3,
      asset_id: '22222222-2222-4222-8222-222222222222',
      scene_id: '33333333-3333-4333-8333-333333333333',
      strategies: ['contact_sheet_v1', 'all_indexed_frames_v1'],
    })
    const output = jobOutputSchemas.build_candidate_evidence.parse({
      evidence_ids: ['44444444-4444-4444-8444-444444444444'],
      manifests: [
        {
          candidate_key: input.candidate_key,
          file_id: input.file_id,
          file_generation: input.file_generation,
          asset_id: input.asset_id,
          scene_id: input.scene_id,
          frame_asset_ids: ['55555555-5555-4555-8555-555555555555'],
          frame_time_seconds: [12.5],
          strategy: 'contact_sheet_v1',
          protocol_version: 'candidate-evidence-v1',
          frame_count: 1,
          input_sha256: 'a'.repeat(64),
          artifact_sha256: 'b'.repeat(64),
          artifact_id: 'candidate-evidence/44444444-4444-4444-8444-444444444444/artifact',
          protocol_parameters: {
            canvas_width: 1600,
            canvas_height: 900,
            resize_mode: 'contain_with_padding',
          },
          format: 'png',
          width: 1600,
          height: 900,
          byte_size: 1234,
        },
      ],
    })

    expect(output.manifests[0].frame_count).toBe(1)
    expect(() =>
      jobInputSchemas.build_candidate_evidence.parse({
        ...input,
        strategies: ['neighbor_frames_v1'],
      }),
    ).toThrow()
    for (const invalidInput of [
      { ...input, file_id: 'not-a-uuid' },
      { ...input, asset_id: 'not-a-uuid' },
      { ...input, scene_id: 'not-a-uuid' },
      { ...input, file_generation: -1 },
    ]) {
      expect(() => jobInputSchemas.build_candidate_evidence.parse(invalidInput)).toThrow()
    }
    expect(() =>
      jobOutputSchemas.build_candidate_evidence.parse({
        ...output,
        manifests: [{ ...output.manifests[0], frame_count: 0, frame_time_seconds: [-1] }],
      }),
    ).toThrow()
  })

  it('keeps the generated Python candidate evidence JSON Schema identical to current Zod', async () => {
    const generated = JSON.parse(await readFile(resolve('generated/job-schemas.json'), 'utf8')) as {
      jobs: Record<string, { input: unknown; output: unknown }>
    }

    expect(generated.jobs.build_candidate_evidence).toEqual({
      input: zodToJsonSchema(jobInputSchemas.build_candidate_evidence, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }),
      output: zodToJsonSchema(jobOutputSchemas.build_candidate_evidence, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }),
    })
  })
})
