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

  test("keeps a single-source vector score on the original normalized scale", () => {
    const [result] = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "strong-single-vector",
          start_time_seconds: 60,
          end_time_seconds: 70,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.82 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(result.score).toBeCloseTo(0.82, 5);
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
      "low-single-vector",
      "multi-signal",
    ]);
    expect(results[0].score).toBeCloseTo(0.3, 5);
  });

  test("filters weak vector matches before hybrid ranking but keeps text rank", () => {
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

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      asset_id: "text-match",
      reasons: ["transcript_match"],
      source_scores: { text_search: 0.1 },
    });
  });

  test("filters negative vector scores before hybrid ranking", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "negative-vector",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: -0.2 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toEqual([]);
  });

  test("ignores weak merged signals so a strong caption match is not diluted", () => {
    const [result] = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "caption",
          start_time_seconds: 30,
          end_time_seconds: 40,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.86 },
        },
        {
          ...baseCandidate,
          asset_id: "weak-vector",
          start_time_seconds: 31,
          end_time_seconds: 39,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.02 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(result).toMatchObject({
      asset_id: "caption",
      reasons: ["caption_match"],
      source_scores: { caption_text_vectors: 0.86 },
      score: 0.86,
      primary_reason: "caption_match",
    });
  });

  test("does not merge adjacent caption-only video windows into a full-video result", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "caption-a",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.42 },
        },
        {
          ...baseCandidate,
          asset_id: "caption-b",
          start_time_seconds: 10,
          end_time_seconds: 20,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.86 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      asset_id: "caption-b",
      start_time_seconds: 10,
      end_time_seconds: 20,
      score: 0.86,
      merged_asset_ids: ["caption-b"],
    });
    expect(results[1]).toMatchObject({
      asset_id: "caption-a",
      start_time_seconds: 0,
      end_time_seconds: 10,
      score: 0.42,
      merged_asset_ids: ["caption-a"],
    });
  });

  test("merges Caption and visual evidence only inside the same video scene", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "scene-1-caption",
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.8 },
        },
        {
          ...baseCandidate,
          asset_id: "scene-1-frame",
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_frame_vectors: 0.2 },
        },
        // 这个场景与前一个场景首尾相接。旧逻辑会在 scene-0001 已经混入视觉信号后
        // 继续链式合并，最终产生跨越多个场景的超长结果。
        {
          ...baseCandidate,
          asset_id: "scene-2-caption",
          scene_id: "scene-0002",
          start_time_seconds: 10,
          end_time_seconds: 20,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.75 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 10,
          merged_asset_ids: ["scene-1-caption", "scene-1-frame"],
        }),
        expect.objectContaining({
          scene_id: "scene-0002",
          start_time_seconds: 10,
          end_time_seconds: 20,
          merged_asset_ids: ["scene-2-caption"],
        }),
      ]),
    );
  });

  test("does not let a weak visual signal lower a strong Caption score", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "strong-caption",
          scene_id: "scene-0046",
          start_time_seconds: 468.5,
          end_time_seconds: 473.466667,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.80291784 },
        },
        {
          ...baseCandidate,
          asset_id: "weak-frame",
          scene_id: "scene-0046",
          start_time_seconds: 468.5,
          end_time_seconds: 473.466667,
          reasons: ["vector_match"],
          source_scores: { video_frame_vectors: 0.14920491 },
        },
        {
          ...baseCandidate,
          asset_id: "caption-rank-6",
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 9.533333,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.7354491 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    // 回归真实查询：旧公式会得到 0.556061375，使 Caption 第一名跌到最终第三名。
    expect(results.map((result) => result.asset_id)).toEqual([
      "strong-caption",
      "caption-rank-6",
    ]);
    expect(results[0].score).toBeCloseTo(0.80291784, 8);
    expect(results[0].primary_reason).toBe("caption_match");
  });

  test("still rewards two strong independent signals", () => {
    const [result] = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "strong-caption",
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["caption_match"],
          source_scores: { caption_text_vectors: 0.8 },
        },
        {
          ...baseCandidate,
          asset_id: "strong-frame",
          scene_id: "scene-0001",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_frame_vectors: 0.7 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(result.score).toBeCloseTo(0.83, 8);
  });

  test("does not merge scene-less windows that only touch at the boundary", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "window-a",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.8 },
        },
        {
          ...baseCandidate,
          asset_id: "window-b",
          start_time_seconds: 10,
          end_time_seconds: 20,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.7 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.asset_id)).toEqual(["window-a", "window-b"]);
  });

  test("does not treat a scene-less time point as a positive-duration overlap", () => {
    const results = buildHybridResults(
      [
        {
          ...baseCandidate,
          asset_id: "window",
          start_time_seconds: 0,
          end_time_seconds: 10,
          reasons: ["vector_match"],
          source_scores: { video_segment_vectors: 0.8 },
        },
        {
          ...baseCandidate,
          asset_id: "time-point",
          start_time_seconds: 5,
          end_time_seconds: 5,
          reasons: ["ocr_match"],
          source_scores: { text_search: 0.7 },
        },
      ],
      { limit: 10, offset: 0 },
    );

    expect(results).toHaveLength(2);
  });

  test("fails on a reversed video time range", () => {
    expect(() =>
      buildHybridResults(
        [
          {
            ...baseCandidate,
            asset_id: "invalid-window",
            start_time_seconds: 10,
            end_time_seconds: 5,
            reasons: ["vector_match"],
            source_scores: { video_segment_vectors: 0.8 },
          },
        ],
        { limit: 10, offset: 0 },
      ),
    ).toThrow("Invalid video time range for asset_id=invalid-window");
  });

  test("validates reversed ranges before weak-source filtering", () => {
    expect(() =>
      buildHybridResults(
        [
          {
            ...baseCandidate,
            asset_id: "weak-invalid-window",
            start_time_seconds: 10,
            end_time_seconds: 5,
            reasons: ["vector_match"],
            source_scores: { video_segment_vectors: 0.02 },
          },
        ],
        { limit: 10, offset: 0 },
      ),
    ).toThrow("Invalid video time range for asset_id=weak-invalid-window");
  });

  test("validates reversed ranges before same-asset merging can hide them", () => {
    expect(() =>
      buildHybridResults(
        [
          {
            ...baseCandidate,
            asset_id: "shared-asset",
            start_time_seconds: 10,
            end_time_seconds: 5,
            reasons: ["vector_match"],
            source_scores: { video_segment_vectors: 0.8 },
          },
          {
            ...baseCandidate,
            asset_id: "shared-asset",
            start_time_seconds: 0,
            end_time_seconds: 20,
            reasons: ["caption_match"],
            source_scores: { caption_text_vectors: 0.7 },
          },
        ],
        { limit: 10, offset: 0 },
      ),
    ).toThrow("Invalid video time range for asset_id=shared-asset");
  });

  test("fails when the same scene carries conflicting canonical boundaries", () => {
    expect(() =>
      buildHybridResults(
        [
          {
            ...baseCandidate,
            asset_id: "scene-caption",
            scene_id: "scene-0001",
            start_time_seconds: 0,
            end_time_seconds: 10,
            reasons: ["caption_match"],
            source_scores: { caption_text_vectors: 0.8 },
          },
          {
            ...baseCandidate,
            asset_id: "scene-frame",
            scene_id: "scene-0001",
            start_time_seconds: 0,
            end_time_seconds: 12,
            reasons: ["vector_match"],
            source_scores: { video_frame_vectors: 0.7 },
          },
        ],
        { limit: 10, offset: 0 },
      ),
    ).toThrow("Conflicting boundaries for file_id=file-1 scene_id=scene-0001");
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
          // 无 scene_id 的历史窗口必须有正数时长的真实重叠，首尾相接也不能合并。
          start_time_seconds: 9,
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
