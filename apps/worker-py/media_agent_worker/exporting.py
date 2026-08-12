import ctypes
import errno
import os
import sys
import subprocess
from pathlib import Path
from uuid import uuid4


def _format_time_for_path(value):
    return f"{value:g}".replace(".", "_")


def _atomic_rename_no_replace(source, target):
    """Atomically rename one file while refusing to replace an existing target.

    macOS exposes renamex_np(RENAME_EXCL); Linux exposes
    renameat2(RENAME_NOREPLACE). Both perform one filesystem rename operation, so
    success cannot leave the `.partial` name behind and a concurrent target wins
    with FileExistsError. Unknown platforms fail fast instead of falling back to
    os.rename(), which can silently overwrite user data on Unix.
    """

    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    target_bytes = os.fsencode(target)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = rename(source_bytes, target_bytes, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, source_bytes, -100, target_bytes, 1)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise RuntimeError(f"Atomic no-replace rename is unsupported on platform: {sys.platform}")
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number), str(target))
        raise OSError(error_number, os.strerror(error_number), str(target))


class ExportClipHandler:
    """Run FFmpeg for confirmed export_clip jobs without exposing partial output as complete."""

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
        output_path = self._output_path(
            file_id=file["id"],
            start=start,
            end=end,
            output_format=output_format,
            export_request_id=job_input.get("export_request_id"),
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            # 同一个幂等请求会由 Server 复用原 Job，不应再次到达 Worker。若磁盘上已有目标，
            # 无论来源是否可判断都快速失败，绝不覆盖用户已经拥有的文件。
            raise FileExistsError(f"Export target already exists: {output_path}")
        partial_path = output_path.with_name(f".{output_path.name}.{uuid4().hex}.partial")

        try:
            # FFmpeg 只写本次调用的唯一临时文件。-n 是 no-overwrite；显式 -f 是因为
            # .partial 后缀无法让 FFmpeg 自动推断容器格式。
            self.ffmpeg_runner(
                [
                    "ffmpeg",
                    "-n",
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
                    "-f",
                    output_format,
                    str(partial_path),
                ]
            )
            if not partial_path.is_file():
                raise RuntimeError("FFmpeg returned without creating the partial export file")

            # 平台原生的 no-replace rename 在一次文件系统操作中发布成品；并发目标存在时
            # 明确失败，既不会覆盖已有文件，也不会出现成品已发布但仍报告失败的中间态。
            _atomic_rename_no_replace(partial_path, output_path)
        finally:
            # FFmpeg 失败、原子发布冲突或进程内校验失败都不得遗留半成品。
            partial_path.unlink(missing_ok=True)

        return {
            "export_path": str(output_path),
            "duration_seconds": end - start,
        }

    def _output_path(self, *, file_id, start, end, output_format, export_request_id=None):
        filename = (
            f"{export_request_id}.{output_format}"
            if export_request_id
            else f"{file_id}-{_format_time_for_path(start)}-{_format_time_for_path(end)}.{output_format}"
        )
        return self.exports_root / filename

    @staticmethod
    def _run_ffmpeg(command):
        # 捕获 stderr 以便 FFmpeg 失败时将具体报错写入 job error_message（验收标准要求）。
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            stderr_tail = result.stderr.strip()[-500:] if result.stderr else "(no stderr)"
            raise RuntimeError(f"FFmpeg exited {result.returncode}: {stderr_tail}")
