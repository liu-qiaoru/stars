from .errors import JobCancelled, JobError


class WorkerRunner:
    """Small PostgreSQL-backed worker loop.

    TypeScript owns job creation and schema definitions; Python owns expensive media/model work.
    Each handler receives the job input JSON defined in packages/shared and returns result_json.
    """

    def __init__(
        self,
        *,
        worker_id,
        job_repository,
        scan_handler=None,
        probe_handler=None,
        index_handler=None,
        purge_handler=None,
        generate_caption_handler=None,
        embed_image_handler=None,
        embed_video_frame_handler=None,
        embed_text_asset_handler=None,
        transcribe_handler=None,
        export_handler=None,
        candidate_evidence_handler=None,
    ):
        self.worker_id = worker_id
        self.job_repository = job_repository
        self.scan_handler = scan_handler
        self.probe_handler = probe_handler
        self.index_handler = index_handler
        self.purge_handler = purge_handler
        self.generate_caption_handler = generate_caption_handler
        self.embed_image_handler = embed_image_handler
        self.embed_video_frame_handler = embed_video_frame_handler
        self.embed_text_asset_handler = embed_text_asset_handler
        self.transcribe_handler = transcribe_handler
        self.export_handler = export_handler
        self.candidate_evidence_handler = candidate_evidence_handler
        self._shutdown_requested = False

    def request_shutdown(self):
        self._shutdown_requested = True

    def run_once(self):
        if self._shutdown_requested:
            return False

        job = self.job_repository.claim_next_job(self.worker_id)
        if job is None:
            return False

        try:
            # One heartbeat before work starts is enough for short jobs; long handlers can be split later if needed.
            self.job_repository.heartbeat(job["id"])
            if job["job_type"] == "scan_library" and self.scan_handler is not None:
                result = self.scan_handler.handle(job["input_json"])
            elif job["job_type"] == "probe_media" and self.probe_handler is not None:
                result = self.probe_handler.handle(job["input_json"])
            elif job["job_type"] == "index_media" and self.index_handler is not None:
                result = self.index_handler.handle(job["input_json"])
            elif job["job_type"] == "purge_video_index" and self.purge_handler is not None:
                result = self.purge_handler.handle(job["input_json"])
            elif job["job_type"] == "generate_caption" and self.generate_caption_handler is not None:
                result = self.generate_caption_handler.handle(job["input_json"])
            elif job["job_type"] == "embed_image" and self.embed_image_handler is not None:
                result = self.embed_image_handler.handle(job["input_json"])
            elif job["job_type"] == "embed_video_frame" and self.embed_video_frame_handler is not None:
                result = self.embed_video_frame_handler.handle(job["input_json"])
            elif job["job_type"] == "embed_text_asset" and self.embed_text_asset_handler is not None:
                result = self.embed_text_asset_handler.handle(job["input_json"])
            elif job["job_type"] == "transcribe_audio" and self.transcribe_handler is not None:
                result = self.transcribe_handler.handle(job["input_json"])
            elif job["job_type"] == "export_clip" and self.export_handler is not None:
                result = self.export_handler.handle(job["input_json"])
            elif (
                job["job_type"] == "build_candidate_evidence"
                and self.candidate_evidence_handler is not None
            ):
                # 候选证据需要把 evidence 事实与 Job 成功状态放在同一 PostgreSQL
                # 事务提交，因此 handler 自己完成终态更新，不能再调用 mark_succeeded。
                self.candidate_evidence_handler.handle(job["input_json"], job_id=job["id"])
                return True
            else:
                raise ValueError(f"Unsupported job type: {job['job_type']}")
            self.job_repository.mark_succeeded(job["id"], result)
            return True
        except JobCancelled as error:
            self.job_repository.mark_cancelled(job["id"], str(error))
            return False
        except JobError as error:
            # 确定性失败（场景检测不可用等）带稳定 error_code，写入结构化错误字段供 Jobs 页面展示。
            # run_ocr 路由已在阶段 2 删除。
            self.job_repository.mark_failed(
                job["id"],
                error.message,
                error_code=error.error_code,
                error_details=error.details,
            )
            return False
        except Exception as error:
            # 模型与媒体任务即使抛出第三方库的普通异常，也要留下稳定分类；详情只记录
            # job_type/异常类，不复制本地路径、Caption 或模型返回内容。
            structured = {
                "index_media": ("MEDIA_INDEX_FAILED", "scene_or_frame_indexing", "媒体索引任务失败"),
                "embed_image": ("EMBEDDING_FAILED", "image_embedding", "图片 Embedding 任务失败"),
                "embed_video_frame": (
                    "EMBEDDING_FAILED",
                    "video_frame_embedding",
                    "视频帧 Embedding 任务失败",
                ),
                "embed_text_asset": (
                    "EMBEDDING_FAILED",
                    "caption_text_embedding",
                    "Caption 文本 Embedding 任务失败",
                ),
                "generate_caption": ("CAPTION_FAILED", "caption_generation", "Caption 生成任务失败"),
                "build_candidate_evidence": (
                    "CANDIDATE_EVIDENCE_FAILED",
                    "candidate_evidence",
                    "候选证据构建失败",
                ),
            }.get(job["job_type"])
            if structured:
                error_code, stage, safe_message = structured
                self.job_repository.mark_failed(
                    job["id"],
                    safe_message,
                    error_code=error_code,
                    error_details={
                        "stage": stage,
                        "job_type": job["job_type"],
                        "exception_type": type(error).__name__,
                    },
                )
            else:
                self.job_repository.mark_failed(job["id"], str(error))
            return False
