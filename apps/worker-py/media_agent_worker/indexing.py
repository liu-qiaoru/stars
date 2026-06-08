import hashlib
import uuid


POINT_NAMESPACE = uuid.UUID("f3f4e35a-688d-4f79-99e0-91f9480a5827")

VECTOR_CONFIGS = {
    "image_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "image_embedding",
        "distance": "Cosine",
    },
    "video_segment_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "representative_frame_embedding",
        "distance": "Cosine",
    },
    "video_frame_vectors": {
        "vector_dim": 768,
        "model_name": "google/siglip-base-patch16-224",
        "model_version": "siglip-base-patch16-224",
        "vector_kind": "frame_embedding",
        "distance": "Cosine",
    },
}


def deterministic_point_id(*, asset_id, collection_name, model_name, model_version, vector_kind, content_hash):
    joined = "|".join([asset_id, collection_name, model_name, model_version, vector_kind, content_hash])
    return str(uuid.uuid5(POINT_NAMESPACE, joined))


def fixed_30s_segments(duration_seconds):
    if duration_seconds is None:
        return []
    start = 0.0
    segments = []
    while start < duration_seconds:
        end = min(start + 30.0, duration_seconds)
        segments.append((start, end))
        start = end
    return segments


def file_content_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class IndexMediaHandler:
    def __init__(self, repository):
        self.repository = repository

    def handle(self, job_input):
        file = self.repository.get_media_file(job_input["file_id"])
        media_type = file["media_type"]
        index_profile = job_input["index_profile"]
        collections = []
        assets_created = 0
        vector_refs_created = 0

        if media_type == "image":
            asset_inputs = [
                {
                    "file_id": file["id"],
                    "asset_type": "image",
                    "path": file["path"],
                    "content_hash": file_content_hash(file["path"]),
                    "collection_name": "image_vectors",
                }
            ]
        elif media_type == "video":
            asset_inputs = []
            for start, end in fixed_30s_segments(file.get("duration_seconds")):
                asset_inputs.append(
                    {
                        "file_id": file["id"],
                        "asset_type": "video_segment",
                        "start_time_seconds": start,
                        "end_time_seconds": end,
                        "content_hash": f"{file['id']}:segment:{start:g}:{end:g}",
                        "collection_name": "video_segment_vectors",
                    }
                )
        else:
            raise ValueError(f"Unsupported index media type: {media_type}")

        for asset_input in asset_inputs:
            collection_name = asset_input.pop("collection_name")
            config = VECTOR_CONFIGS[collection_name]
            asset = self.repository.upsert_media_asset(**asset_input)
            content_hash = asset_input["content_hash"]
            point_id = deterministic_point_id(
                asset_id=asset["id"],
                collection_name=collection_name,
                model_name=config["model_name"],
                model_version=config["model_version"],
                vector_kind=config["vector_kind"],
                content_hash=content_hash,
            )
            outcome = self.repository.upsert_vector_ref(
                asset_id=asset["id"],
                file_id=file["id"],
                library_id=file["library_id"],
                collection_name=collection_name,
                point_id=point_id,
                model_name=config["model_name"],
                model_version=config["model_version"],
                vector_kind=config["vector_kind"],
                vector_dim=config["vector_dim"],
                distance=config["distance"],
                content_hash=content_hash,
                index_profile=index_profile,
            )
            if outcome == "created":
                assets_created += 1
                vector_refs_created += 1
            if collection_name not in collections:
                collections.append(collection_name)

        return {
            "assets_created": assets_created,
            "vector_refs_created": vector_refs_created,
            "collections": collections,
        }
