import { describe, expect, it } from 'vitest'
import { jobInputSchemas, jobOutputSchemas } from '../schemas/index.js'

describe('job schemas', () => {
  it('records actual segment strategy and fallback on index_media output', () => {
    const output = jobOutputSchemas.index_media.parse({
      assets_created: 3,
      vector_refs_created: 3,
      collections: ['video_segment_vectors', 'video_frame_vectors'],
      segment_strategy: 'scene_detection',
      fallback: false,
      keyframe_density: 'dense',
    })

    expect(output.segment_strategy).toBe('scene_detection')
    expect(output.fallback).toBe(false)
    expect(output.keyframe_density).toBe('dense')
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

  it('validates run_ocr input and output', () => {
    const input = jobInputSchemas.run_ocr.parse({
      asset_ids: ['11111111-1111-4111-8111-111111111111'],
      engine: 'paddleocr',
      language: 'ch',
    })
    const output = jobOutputSchemas.run_ocr.parse({
      assets_processed: 1,
      text_written: 1,
      skipped_no_text: 0,
    })

    expect(input.asset_ids).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(output.text_written).toBe(1)
  })

  it('rejects unsupported run_ocr engines', () => {
    expect(() => jobInputSchemas.run_ocr.parse({
      asset_ids: ['11111111-1111-4111-8111-111111111111'],
      engine: 'easyocr',
      language: 'ch',
    })).toThrow()
  })
})
