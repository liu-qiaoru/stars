import { describe, expect, test } from 'vitest'
import {
  collapseVideoFramesByScene,
  type SceneBound,
  type VideoFrameCandidate,
} from '../../src/search/search-scene-maxsim.js'

const frame = (
  assetId: string,
  fileId: string,
  sceneId: string | null,
  frameTime: number,
  score: number,
): VideoFrameCandidate => ({
  asset_id: assetId,
  file_id: fileId,
  media_type: 'video',
  path: `/media/${fileId}.mp4`,
  start_time_seconds: frameTime,
  end_time_seconds: frameTime,
  scene_id: sceneId,
  reasons: ['vector_match'],
  source_scores: { video_frame_vectors: score },
})

const bound = (fileId: string, sceneId: string, start: number, end: number): SceneBound => ({
  file_id: fileId,
  scene_id: sceneId,
  start_time_seconds: start,
  end_time_seconds: end,
})

describe('collapseVideoFramesByScene', () => {
  test('uses the strongest frame as scene representative and preserves all evidence assets', () => {
    const result = collapseVideoFramesByScene(
      [
        frame('frame-5', 'file-1', 'scene-1', 5, 0.82),
        frame('frame-15', 'file-1', 'scene-1', 15, 0.91),
        frame('frame-25', 'file-1', 'scene-1', 25, 0.76),
      ],
      [bound('file-1', 'scene-1', 0, 30)],
    )

    expect(result).toEqual([
      expect.objectContaining({
        asset_id: 'frame-15',
        file_id: 'file-1',
        scene_id: 'scene-1',
        start_time_seconds: 0,
        end_time_seconds: 30,
        best_frame_time_seconds: 15,
        source_scores: { video_frame_vectors: 0.91 },
        merged_asset_ids: ['frame-5', 'frame-15', 'frame-25'],
      }),
    ])
  })

  test('does not merge identical scene ids across different files', () => {
    const result = collapseVideoFramesByScene(
      [
        frame('frame-a', 'file-a', 'scene-1', 5, 0.8),
        frame('frame-b', 'file-b', 'scene-1', 5, 0.9),
      ],
      [bound('file-a', 'scene-1', 0, 10), bound('file-b', 'scene-1', 0, 10)],
    )

    expect(result.map((candidate) => candidate.asset_id)).toEqual(['frame-a', 'frame-b'])
  })

  test('keeps frames without scene identity as independent candidates', () => {
    const result = collapseVideoFramesByScene(
      [frame('frame-a', 'file-1', null, 5, 0.8), frame('frame-b', 'file-1', null, 6, 0.9)],
      [],
    )

    expect(result.map((candidate) => candidate.merged_asset_ids)).toEqual([
      ['frame-a'],
      ['frame-b'],
    ])
  })

  test('fails when an identified scene has no PostgreSQL boundary', () => {
    expect(() =>
      collapseVideoFramesByScene([frame('frame-a', 'file-1', 'scene-missing', 5, 0.8)], []),
    ).toThrow('Missing video segment boundary for file_id=file-1 scene_id=scene-missing')
  })
})
