import os
import subprocess
import tempfile

from .embeddings import SiglipEmbedder


def extract_video_frame(source_path, frame_time_seconds, runner=subprocess.run):
    # Video segment embeddings use a representative frame. The temp frame is deleted by the caller after embedding.
    output = tempfile.NamedTemporaryFile(prefix="media-agent-frame-", suffix=".jpg", delete=False)
    output.close()
    command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(frame_time_seconds),
        "-i",
        source_path,
        "-frames:v",
        "1",
        output.name,
    ]
    try:
        runner(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return output.name
    except Exception:
        try:
            os.unlink(output.name)
        except FileNotFoundError:
            pass
        raise


class BaseEmbeddingHandler:
    """Shared embedding write path for image and video-frame jobs."""

    def __init__(self, repository, qdrant_client, embedder=None):
        self.repository = repository
        self.qdrant_client = qdrant_client
        self.embedder = embedder or SiglipEmbedder()

    def _embed_and_write(self, *, job_input, image_path):
        # Re-read vector_ref at execution time so retries use the current model version, point id and payload fields.
        vector_ref = self.repository.get_vector_ref_for_embedding(
            asset_id=job_input["asset_id"],
            collection_name=job_input["collection"],
            model_name=job_input["model_name"],
            model_version=job_input["model_version"],
        )
        vector = self.embedder.embed_image_path(image_path)
        if len(vector) != vector_ref["vector_dim"]:
            raise ValueError(
                f"Embedding dimension mismatch for {vector_ref['point_id']}: "
                f"expected {vector_ref['vector_dim']}, got {len(vector)}"
            )

        self.qdrant_client.upsert_point(
            # Payload is intentionally redundant with PostgreSQL for cheap Qdrant filtering/debugging.
            # Search still hydrates from PostgreSQL before returning user-visible metadata.
            vector_ref["collection_name"],
            {
                "id": vector_ref["point_id"],
                "vector": vector,
                "payload": {
                    "asset_id": vector_ref["asset_id"],
                    "file_id": vector_ref["file_id"],
                    "library_id": vector_ref["library_id"],
                    "media_type": vector_ref["media_type"],
                    "asset_type": vector_ref["asset_type"],
                    "start_time_seconds": vector_ref.get("start_time_seconds"),
                    "end_time_seconds": vector_ref.get("end_time_seconds"),
                    "frame_time_seconds": vector_ref.get("frame_time_seconds"),
                    "scene_id": vector_ref.get("metadata_json", {}).get("scene_id"),
                    "segment_strategy": vector_ref.get("metadata_json", {}).get("segment_strategy"),
                    "keyframe_index": vector_ref.get("metadata_json", {}).get("keyframe_index"),
                    "model_name": vector_ref["model_name"],
                    "model_version": vector_ref["model_version"],
                    "vector_kind": vector_ref["vector_kind"],
                    "content_hash": vector_ref["content_hash"],
                    "index_profile": vector_ref["index_profile"],
                },
            },
        )
        self.repository.mark_vector_ref_indexed(vector_ref["point_id"])
        return {
            "point_id": vector_ref["point_id"],
            "collection": vector_ref["collection_name"],
            "vector_dim": len(vector),
            "model_name": vector_ref["model_name"],
            "model_version": vector_ref["model_version"],
        }


class EmbedImageHandler(BaseEmbeddingHandler):
    def handle(self, job_input):
        return self._embed_and_write(job_input=job_input, image_path=job_input["path"])


class EmbedVideoFrameHandler(BaseEmbeddingHandler):
    def __init__(self, repository, qdrant_client, embedder=None, frame_extractor=extract_video_frame):
        super().__init__(repository, qdrant_client, embedder=embedder)
        self.frame_extractor = frame_extractor

    def handle(self, job_input):
        extracted_path = None
        image_path = job_input["frame_path"]
        if job_input.get("frame_time_seconds") is not None:
            extracted_path = self.frame_extractor(image_path, job_input["frame_time_seconds"])
            image_path = extracted_path
        try:
            return self._embed_and_write(job_input=job_input, image_path=image_path)
        finally:
            if extracted_path is not None:
                try:
                    os.unlink(extracted_path)
                except FileNotFoundError:
                    pass
