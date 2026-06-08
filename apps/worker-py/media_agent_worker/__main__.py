import os
import signal
import time

from .exporting import ExportClipHandler
from .embedding_worker import EmbedImageHandler, EmbedVideoFrameHandler
from .embeddings import SiglipEmbedder
from .indexing import IndexMediaHandler
from .probe import ProbeHandler
from .qdrant import QdrantHttpClient
from .repository import PostgresJobRepository, PostgresMediaRepository, connect_from_env
from .scan import ScanHandler
from .worker import WorkerRunner


def build_runner(*, worker_id, job_repository, media_repository, qdrant_client, embedder=None):
    shared_embedder = embedder or SiglipEmbedder()
    return WorkerRunner(
        worker_id=worker_id,
        job_repository=job_repository,
        scan_handler=ScanHandler(media_repository, job_repository=job_repository),
        probe_handler=ProbeHandler(media_repository, job_repository=job_repository),
        index_handler=IndexMediaHandler(media_repository),
        embed_image_handler=EmbedImageHandler(media_repository, qdrant_client, shared_embedder),
        embed_video_frame_handler=EmbedVideoFrameHandler(media_repository, qdrant_client, shared_embedder),
        export_handler=ExportClipHandler(media_repository),
    )


def main():
    worker_id = os.environ.get("WORKER_ID", f"worker-{os.getpid()}")
    poll_interval_seconds = float(os.environ.get("WORKER_POLL_INTERVAL_SECONDS", "2"))
    connection = connect_from_env()
    job_repository = PostgresJobRepository(connection)
    media_repository = PostgresMediaRepository(connection)
    qdrant_client = QdrantHttpClient()
    runner = build_runner(
        worker_id=worker_id,
        job_repository=job_repository,
        media_repository=media_repository,
        qdrant_client=qdrant_client,
    )

    def request_shutdown(_signum, _frame):
        runner.request_shutdown()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)

    while True:
        did_work = runner.run_once()
        if not did_work and runner._shutdown_requested:
            break
        if not did_work:
            time.sleep(poll_interval_seconds)


if __name__ == "__main__":
    main()
