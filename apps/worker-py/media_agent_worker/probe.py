import json
import struct
import subprocess
from pathlib import Path


def run_ffprobe(path):
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    streams = payload.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    primary_stream = video_stream or audio_stream or {}
    duration = payload.get("format", {}).get("duration") or primary_stream.get("duration")
    return {
        "duration_seconds": float(duration) if duration is not None else None,
        "width": primary_stream.get("width"),
        "height": primary_stream.get("height"),
        "codec": primary_stream.get("codec_name"),
        "streams": len(streams),
    }


def parse_image_dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return {"width": width, "height": height}

    if data.startswith(b"\xff\xd8"):
        offset = 2
        while offset < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            offset += 2
            if marker in (0xC0, 0xC2):
                length = struct.unpack(">H", data[offset : offset + 2])[0]
                segment = data[offset + 2 : offset + length]
                height, width = struct.unpack(">HH", segment[1:5])
                return {"width": width, "height": height}
            if marker == 0xDA:
                break
            length = struct.unpack(">H", data[offset : offset + 2])[0]
            offset += length

    raise ValueError("Unsupported image format")


class ProbeHandler:
    def __init__(self, repository, job_repository=None, ffprobe_runner=run_ffprobe):
        self.repository = repository
        self.job_repository = job_repository
        self.ffprobe_runner = ffprobe_runner

    def handle(self, job_input):
        file_id = job_input["file_id"]
        media_type = job_input["media_type"]
        path = job_input["path"]

        if media_type in ("video", "audio"):
            metadata = self.ffprobe_runner(path)
        elif media_type == "image":
            metadata = parse_image_dimensions(Path(path).read_bytes())
            metadata = {**metadata, "duration_seconds": None, "codec": None, "streams": 1}
        else:
            raise ValueError(f"Unsupported probe media type: {media_type}")

        self.repository.update_probe_metadata(file_id, metadata)

        if self.job_repository is not None:
            self.job_repository.create_job("index_media", {
                "file_id": file_id,
                "index_profile": "balanced",
                "segment_strategy": "scene_detection" if media_type == "video" else "fixed_30s",
            })

        return metadata
