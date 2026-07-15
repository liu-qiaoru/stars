-- 旧版视频 caption-v1 没有稳定的 scene_id，会与新版 scene-caption-v2
-- 对同一段视频产生两个无法合并的检索候选。本迁移保留旧行用于审计，
-- 但把确认已完成 v2 覆盖的视频旧 Caption 及其向量引用标记为 stale。
WITH ready_video_files AS (
  SELECT media_file.id
  FROM media_files AS media_file
  WHERE media_file.media_type = 'video'
    -- 至少存在一条活跃 v2 Caption，避免对尚未开始迁移的视频执行清理。
    AND EXISTS (
      SELECT 1
      FROM media_assets AS scene_caption
      WHERE scene_caption.file_id = media_file.id
        AND scene_caption.asset_type = 'caption'
        AND scene_caption.metadata_json->>'prompt_version' = 'scene-caption-v2'
        AND COALESCE(scene_caption.metadata_json->>'stale', 'false') <> 'true'
    )
    -- 只有每个活跃 video_segment 都有同 scene_id 的 v2 Caption 时，
    -- 才认为整个视频迁移完成，防止在 v2 只生成一部分时提前移除 v1 兜底数据。
    AND NOT EXISTS (
      SELECT 1
      FROM media_assets AS segment
      WHERE segment.file_id = media_file.id
        AND segment.asset_type = 'video_segment'
        AND COALESCE(segment.metadata_json->>'stale', 'false') <> 'true'
        AND NOT EXISTS (
          SELECT 1
          FROM media_assets AS scene_caption
          WHERE scene_caption.file_id = segment.file_id
            AND scene_caption.asset_type = 'caption'
            AND scene_caption.metadata_json->>'prompt_version' = 'scene-caption-v2'
            AND scene_caption.metadata_json->>'scene_id' = segment.metadata_json->>'scene_id'
            AND COALESCE(scene_caption.metadata_json->>'stale', 'false') <> 'true'
        )
    )
), legacy_captions AS (
  -- 清理范围只包含已就绪视频的 caption-v1；图片 caption-v1 仍是当前合法格式。
  SELECT caption.id
  FROM media_assets AS caption
  WHERE caption.file_id IN (SELECT id FROM ready_video_files)
    AND caption.asset_type = 'caption'
    AND caption.metadata_json->>'prompt_version' = 'caption-v1'
    AND COALESCE(caption.metadata_json->>'stale', 'false') <> 'true'
), stale_refs AS (
  -- 先停止向量引用参与回表检索，再标记 asset；两步位于同一条 SQL 语句中，
  -- 任意一步失败都会整体回滚，不会留下 ref 与 asset 状态不一致的部分结果。
  UPDATE vector_refs
  SET status = 'stale',
      updated_at = now()
  WHERE asset_id IN (SELECT id FROM legacy_captions)
    AND status <> 'stale'
  RETURNING asset_id
)
UPDATE media_assets
SET metadata_json = metadata_json || '{"stale":true,"stale_reason":"superseded_by_scene_caption_v2"}'::jsonb
WHERE id IN (SELECT id FROM legacy_captions);
