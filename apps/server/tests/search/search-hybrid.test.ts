import { describe, expect, test } from "vitest";
import { buildHybridResults, type HybridCandidateInput } from "../../src/search/search-hybrid.js";

const baseCandidate = {
  file_id: "file-1",
  media_type: "video",
  path: "/media/launch.mp4",
  scene_id: null,
} satisfies Pick<HybridCandidateInput, "file_id" | "media_type" | "path" | "scene_id">;

describe("hybrid search ranking", () => {
  test("merges adjacent video windows across assets and keeps max source score", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "segment-low",
          start_time_seconds: 10,
          end_time_seconds: 20,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.42 },
        },
        {
          ...baseCandidate,
          asset_id: "segment-high",
          start_time_seconds: 21,
          end_time_seconds: 30,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.84 },
        },
        {
          ...baseCandidate,
          asset_id: "transcript",
          start_time_seconds: 18,
          end_time_seconds: 28,
          reasons: ["transcript_match"],
          source_scores: { text_search: 0.5 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      asset_id: "segment-high",
      merged_asset_ids: ["segment-low", "segment-high", "transcript"],
      file_id: "file-1",
      start_time_seconds: 10,
      end_time_seconds: 30,
      reasons: ["vector_match", "transcript_match"],
      source_scores: {
        video_segment_vectors: 0.84,
        text_search: 0.5,
      },
      score_kind: "hybrid_score",
    });
  });

  test("uses weighted normalized contribution for primary_reason instead of raw score", () => {
    const [result] = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "weighted-vector",
          start_time_seconds: 40,
          end_time_seconds: 50,
          reasons: ["vector_match", "transcript_match"],
          source_scores: {
            video_segment_vectors: 0.82,
            text_search: 2,
          },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(result.primary_reason).toBe("vector_match");
    expect(result.score).toBeCloseTo(0.82 * 0.55 + (2 / 3) * 0.45 + 0.08, 5);
  });

  test("does not inflate a low single-source result to a full score", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "low-single-vector",
          start_time_seconds: 60,
          end_time_seconds: 70,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.3 },
        },
        {
          ...baseCandidate,
          asset_id: "multi-signal",
          start_time_seconds: 120,
          end_time_seconds: 130,
          reasons: ["vector_match", "transcript_match"],
          source_scores: {
            video_segment_vectors: 0.2,
            text_search: 0.1,
          },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results.map((result) => result.asset_id)).toEqual([
      "multi-signal",
      "low-single-vector",
    ]);
    expect(results[1].score).toBeCloseTo(0.3 * 0.55, 5);
  });

  test("keeps weak vector-only matches and marks them low confidence", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "weak-vector",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.04 },
        },
        {
          ...baseCandidate,
          asset_id: "text-match",
          start_time_seconds: 30,
          end_time_seconds: 40,
          reasons: ["transcript_match"],
          source_scores: { text_search: 0.1 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results.map((result) => result.asset_id)).toEqual(["text-match", "weak-vector"]);
    expect(results[0].confidence).toBe("high");
    expect(results[1].confidence).toBe("low");
  });

  test("applies offset and limit after adjacent windows are merged", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "merged-a",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.9 },
        },
        {
          ...baseCandidate,
          asset_id: "merged-b",
          start_time_seconds: 11,
          end_time_seconds: 20,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.85 },
        },
        {
          ...baseCandidate,
          asset_id: "next-result",
          start_time_seconds: 100,
          end_time_seconds: 110,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.8 },
        },
      ],
      { limit: 1, offset: 1 },
    );

    expect(results).toHaveLength(1);
    expect(results[0].asset_id).toBe("next-result");
  });
});
