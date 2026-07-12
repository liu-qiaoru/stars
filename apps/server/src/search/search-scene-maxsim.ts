import type { HybridCandidateInput } from './search-hybrid.js'

export interface VideoFrameCandidate extends HybridCandidateInput {
  media_type: 'video'
}

export interface SceneBound {
  file_id: string
  scene_id: string
  start_time_seconds: number
  end_time_seconds: number
}

function sceneKey(fileId: string, sceneId: string) {
  return `${fileId}|${sceneId}`
}

export function collapseVideoFramesByScene(
  candidates: VideoFrameCandidate[],
  sceneBounds: SceneBound[],
): VideoFrameCandidate[] {
  const boundsByScene = new Map(
    sceneBounds.map((bound) => [sceneKey(bound.file_id, bound.scene_id), bound]),
  )
  const grouped = new Map<string, VideoFrameCandidate[]>()
  const outputOrder: Array<
    { type: 'scene'; key: string } | { type: 'frame'; candidate: VideoFrameCandidate }
  > = []

  for (const candidate of candidates) {
    if (!candidate.scene_id) {
      outputOrder.push({ type: 'frame', candidate })
      continue
    }
    const key = sceneKey(candidate.file_id, candidate.scene_id)
    const existing = grouped.get(key)
    if (existing) {
      existing.push(candidate)
    } else {
      grouped.set(key, [candidate])
      outputOrder.push({ type: 'scene', key })
    }
  }

  return outputOrder.map((entry) => {
    if (entry.type === 'frame') {
      return { ...entry.candidate, merged_asset_ids: [entry.candidate.asset_id] }
    }
    const frames = grouped.get(entry.key) ?? []
    const first = frames[0]
    if (!first?.scene_id) {
      throw new Error(`Scene group ${entry.key} has no candidates`)
    }
    const bound = boundsByScene.get(entry.key)
    if (!bound) {
      throw new Error(
        `Missing video segment boundary for file_id=${first.file_id} scene_id=${first.scene_id}`,
      )
    }
    const representative = frames.reduce((strongest, frame) =>
      (frame.source_scores.video_frame_vectors ?? 0) >
      (strongest.source_scores.video_frame_vectors ?? 0)
        ? frame
        : strongest,
    )
    return {
      ...representative,
      best_frame_time_seconds: representative.start_time_seconds,
      start_time_seconds: bound.start_time_seconds,
      end_time_seconds: bound.end_time_seconds,
      merged_asset_ids: frames.map((frame) => frame.asset_id),
    }
  })
}
