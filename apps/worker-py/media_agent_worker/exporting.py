import subprocess
from pathlib import Path


def _format_time_for_path(value):
    return f"{value:g}".replace(".", "_")


class ExportClipHandler:
    def __init__(self, repository, *, ffmpeg_runner=None, exports_root=None):
        self.repository = repository
        self.ffmpeg_runner = ffmpeg_runner or self._run_ffmpeg
        self.exports_root = Path(exports_root or ".media-agent/exports/clips")

    def handle(self, job_input):
        file = self.repository.get_media_file(job_input["file_id"])
        if file["media_type"] != "video":
            raise ValueError(f"Clip export only supports video files, got: {file['media_type']}")

        start = float(job_input["start_time_seconds"])
        end = float(job_input["end_time_seconds"])
        if end <= start:
            raise ValueError("end_time_seconds must be greater than start_time_seconds")

        output_format = job_input.get("output_format", "mp4")
        output_path = self._output_path(file_id=file["id"], start=start, end=end, output_format=output_format)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # FFmpeg 是 Phase8 唯一真正接触源媒体文件的边界。这里用 argv list 而不是 shell 字符串，
        # 并用 stream copy 做 MVP 快速导出；后续需要转码/字幕时再扩展参数，不提前扩大职责。
        self.ffmpeg_runner(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:g}",
                "-i",
                file["path"],
                "-t",
                f"{end - start:g}",
                "-map",
                "0",
                "-c",
                "copy",
                str(output_path),
            ]
        )

        return {
            "export_path": str(output_path),
            "duration_seconds": end - start,
        }

    def _output_path(self, *, file_id, start, end, output_format):
        filename = f"{file_id}-{_format_time_for_path(start)}-{_format_time_for_path(end)}.{output_format}"
        return self.exports_root / filename

    @staticmethod
    def _run_ffmpeg(command):
        # 捕获 stderr 以便 FFmpeg 失败时将具体报错写入 job error_message（验收标准要求）。
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            stderr_tail = result.stderr.strip()[-500:] if result.stderr else "(no stderr)"
            raise RuntimeError(f"FFmpeg exited {result.returncode}: {stderr_tail}")
