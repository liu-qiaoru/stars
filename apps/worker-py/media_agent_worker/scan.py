from pathlib import Path


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"}
DOCUMENT_EXTENSIONS = {".txt", ".md", ".pdf", ".srt", ".vtt"}


def detect_media_type(path):
    suffix = Path(path).suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    if suffix in DOCUMENT_EXTENSIONS:
        return "document"
    return None


class ScanHandler:
    def __init__(self, repository, job_repository=None):
        self.repository = repository
        self.job_repository = job_repository

    def handle(self, job_input):
        root_path = Path(job_input["root_path"]).expanduser()
        library_id = job_input["library_id"]
        result = {"discovered": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}
        files_to_probe = []

        for path in sorted(root_path.rglob("*")):
            if not path.is_file():
                continue

            media_type = detect_media_type(path)
            if media_type is None:
                continue

            result["discovered"] += 1
            try:
                stat = path.stat()
                outcome, file_id = self.repository.upsert_media_file(
                    library_id=library_id,
                    root_path=str(root_path),
                    path=str(path),
                    media_type=media_type,
                    size_bytes=stat.st_size,
                    mtime_ms=int(stat.st_mtime * 1000),
                )
                result[outcome] += 1
                if outcome in ("created", "updated"):
                    files_to_probe.append({
                        "file_id": file_id,
                        "path": str(path),
                        "media_type": media_type,
                    })
            except Exception:
                result["failed"] += 1

        if self.job_repository is not None:
            for probe_input in files_to_probe:
                self.job_repository.create_job("probe_media", probe_input)

        return result
