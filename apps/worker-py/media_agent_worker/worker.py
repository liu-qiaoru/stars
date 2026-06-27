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
        embed_image_handler=None,
        embed_video_frame_handler=None,
        transcribe_handler=None,
        ocr_handler=None,
        export_handler=None,
    ):
        self.worker_id = worker_id
        self.job_repository = job_repository
        self.scan_handler = scan_handler
        self.probe_handler = probe_handler
        self.index_handler = index_handler
        self.embed_image_handler = embed_image_handler
        self.embed_video_frame_handler = embed_video_frame_handler
        self.transcribe_handler = transcribe_handler
        self.ocr_handler = ocr_handler
        self.export_handler = export_handler
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
            elif job["job_type"] == "embed_image" and self.embed_image_handler is not None:
                result = self.embed_image_handler.handle(job["input_json"])
            elif job["job_type"] == "embed_video_frame" and self.embed_video_frame_handler is not None:
                result = self.embed_video_frame_handler.handle(job["input_json"])
            elif job["job_type"] == "transcribe_audio" and self.transcribe_handler is not None:
                result = self.transcribe_handler.handle(job["input_json"])
            elif job["job_type"] == "run_ocr" and self.ocr_handler is not None:
                result = self.ocr_handler.handle(job["input_json"])
            elif job["job_type"] == "export_clip" and self.export_handler is not None:
                result = self.export_handler.handle(job["input_json"])
            else:
                raise ValueError(f"Unsupported job type: {job['job_type']}")
            self.job_repository.mark_succeeded(job["id"], result)
            return True
        except Exception as error:
            self.job_repository.mark_failed(job["id"], str(error))
            return False
