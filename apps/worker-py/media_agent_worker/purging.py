"""阶段 3：单文件破坏性重索引的 purge_video_index 任务处理器。

流程（来自实施计划 3.1）：
1. 先从 Qdrant 删除该文件的全部向量点（按 collection 分组，幂等）。
2. 再在 PostgreSQL 一个事务里删除场景/帧/Caption/Vector Ref 等派生数据，条件递增
   index_generation（仅在文件仍为 purge_queued 时），并把 index_status 翻回 pending。
3. purge 成功后创建 index_media 任务，重建索引。

失败语义：Qdrant 已删但 PostgreSQL 清理失败时，事务回滚、异常向上传播，任务失败并可安全重试——
重试时 Qdrant/PG 清理都幂等，generation 递增受状态条件保护不会重复。
"""

import logging


logger = logging.getLogger(__name__)


class PurgeVideoIndexHandler:
    """删除某文件的全部索引派生数据，为重新索引腾出干净状态。"""

    def __init__(self, repository, qdrant_client, job_repository=None):
        self.repository = repository
        self.qdrant_client = qdrant_client
        self.job_repository = job_repository

    def handle(self, job_input):
        file_id = job_input["file_id"]

        # 1. 先删 Qdrant points：按 collection 分组，逐集合删除。删除不存在的点是 no-op，重试安全。
        refs = self.repository.list_vector_refs_for_file(file_id)
        points_by_collection = {}
        for ref in refs:
            points_by_collection.setdefault(ref["collection_name"], []).append(ref["point_id"])
        points_deleted = 0
        for collection_name, point_ids in points_by_collection.items():
            points_deleted += self.qdrant_client.delete_points(collection_name, point_ids)

        # 2. PostgreSQL 事务清理派生数据 + 条件递增 generation。Qdrant 已删但此处失败时抛异常，
        #    让任务失败并可安全重试（清理幂等、generation 受状态条件保护）。
        purged = self.repository.purge_file_index(file_id)

        # 3. purge 成功后创建 index_media，重建该文件的索引。
        reindex_job_created = False
        if self.job_repository is not None:
            self.job_repository.create_job(
                "index_media",
                {"file_id": file_id, "index_profile": "balanced"},
            )
            reindex_job_created = True

        logger.info(
            "purge_video_index file_id=%s qdrant_points=%s vector_refs=%s assets=%s scenes=%s generation=%s reindex_created=%s",
            file_id,
            points_deleted,
            purged["vector_refs_deleted"],
            purged["assets_deleted"],
            purged["scenes_deleted"],
            purged["index_generation"],
            reindex_job_created,
        )

        return {
            "points_deleted": points_deleted,
            "vector_refs_deleted": purged["vector_refs_deleted"],
            "assets_deleted": purged["assets_deleted"],
            "scenes_deleted": purged["scenes_deleted"],
            "index_generation": purged["index_generation"],
            "reindex_job_created": reindex_job_created,
        }
