UPDATE media_files AS media_file
SET index_status = 'indexed',
    updated_at = now()
WHERE media_file.deleted_at IS NULL
  AND media_file.index_status <> 'indexed'
  AND EXISTS (
    SELECT 1
    FROM vector_refs AS vector_ref
    WHERE vector_ref.file_id = media_file.id
      AND vector_ref.status = 'indexed'
  );
