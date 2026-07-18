import { describe, expect, it } from 'vitest'
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
      model_name: 'google/siglip-base-patch16-224',
      model_version: 'siglip-base-patch16-224',
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
})
