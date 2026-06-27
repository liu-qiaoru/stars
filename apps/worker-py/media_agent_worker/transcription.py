import os
import subprocess
import tempfile
from pathlib import Path


TRANSCRIBE_TIMEOUT_SECONDS = 14400
CHUNK_MIN_SECONDS = 15.0
CHUNK_MAX_SECONDS = 30.0


def _normalize_segment(segment):
    if isinstance(segment, dict):
        return {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": str(segment.get("text", "")).strip(),
        }
    return {
        "start": float(segment.start),
        "end": float(segment.end),
        "text": str(getattr(segment, "text", "")).strip(),
    }


def chunk_transcript_segments(segments, *, min_seconds=CHUNK_MIN_SECONDS, max_seconds=CHUNK_MAX_SECONDS):
    # Store transcript as searchable 15-30s text_chunk assets. That granularity is short enough for jumping
    # to media time ranges, but long enough to keep PostgreSQL rows and FTS ranking manageable.
    normalized = [_normalize_segment(segment) for segment in segments]
    normalized = [segment for segment in normalized if segment["end"] > segment["start"] and segment["text"]]
    if not normalized:
        return []

    chunks = []
    current = []
    current_start = None
    for index, segment in enumerate(normalized):
        if current_start is None:
            current_start = segment["start"]
        current.append(segment)
        current_end = segment["end"]
        current_duration = current_end - current_start
        next_segment = normalized[index + 1] if index + 1 < len(normalized) else None
        next_would_exceed_max = (
            next_segment is not None and next_segment["end"] - current_start > max_seconds
        )
        if current_duration >= min_seconds and (next_would_exceed_max or next_segment is None):
            chunks.append({
                "start_time_seconds": current_start,
                "end_time_seconds": current_end,
                "text_content": " ".join(item["text"] for item in current).strip(),
            })
            current = []
            current_start = None

    if current and current_start is not None:
        chunks.append({
            "start_time_seconds": current_start,
            "end_time_seconds": current[-1]["end"],
            "text_content": " ".join(item["text"] for item in current).strip(),
        })
    return chunks


def extract_audio_to_wav(source_path):
    # faster-whisper expects audio input; FFmpeg normalizes any video/audio file into mono 16k WAV.
    fd, audio_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        source_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        audio_path,
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        stderr_tail = result.stderr.strip()[-500:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"FFmpeg audio extraction exited {result.returncode}: {stderr_tail}")
    return audio_path


class FasterWhisperTranscriber:
    """Lazy faster-whisper wrapper so importing the worker does not load model weights."""

    def __init__(self, model_name=None, device=None):
        self.model_name = model_name or os.environ.get("WHISPER_MODEL", "base")
        self.device = device or os.environ.get("WHISPER_DEVICE", "cpu")
        self._model = None

    def _load_model(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise RuntimeError("faster-whisper is not installed. Install faster-whisper to run transcribe_audio jobs.") from error
        # CPU/INT8 keeps Whisper separate from SigLIP's optional MPS/CUDA path and is the Phase 12 default.
        self._model = WhisperModel(self.model_name, device=self.device, compute_type="int8")
        return self._model

    def transcribe(self, audio_path, language="auto"):
        model = self._load_model()
        selected_language = None if language == "auto" else language
        segments, info = model.transcribe(audio_path, language=selected_language)
        return {
            "segments": list(segments),
            "language": getattr(info, "language", selected_language or "auto"),
        }


class TranscribeHandler:
    """Turn a video/audio file into text_chunk media_assets for PostgreSQL FTS."""

    def __init__(self, repository, *, transcriber=None, audio_extractor=None):
        self.repository = repository
        self.transcriber = transcriber or FasterWhisperTranscriber()
        self.audio_extractor = audio_extractor or extract_audio_to_wav
        self._owns_extracted_audio = audio_extractor is None

    def handle(self, job_input):
        file = self.repository.get_media_file(job_input["file_id"])
        if file["media_type"] not in ("video", "audio"):
            raise ValueError(f"Transcription only supports video/audio files, got: {file['media_type']}")

        source_path = job_input.get("path") or file["path"]
        language = job_input.get("language", os.environ.get("WHISPER_LANGUAGE", "auto"))
        audio_path = self.audio_extractor(source_path)
        try:
            transcript = self.transcriber.transcribe(audio_path, language=language)
        finally:
            if self._owns_extracted_audio:
                Path(audio_path).unlink(missing_ok=True)

        chunks = chunk_transcript_segments(transcript["segments"])
        chunks_created = 0
        for chunk in chunks:
            # text_chunk identity is file + time window; reruns overwrite the same chunk rather than duplicating transcript.
            asset_result = self.repository.upsert_media_asset(
                file_id=file["id"],
                asset_type="text_chunk",
                start_time_seconds=chunk["start_time_seconds"],
                end_time_seconds=chunk["end_time_seconds"],
                text_content=chunk["text_content"],
                content_hash=f"{file['id']}:text:{chunk['start_time_seconds']:g}:{chunk['end_time_seconds']:g}",
                metadata_json={
                    "language": transcript["language"],
                    "transcriber": "faster-whisper",
                    "model": job_input.get("model", os.environ.get("WHISPER_MODEL", "base")),
                },
            )
            if isinstance(asset_result, tuple):
                _asset, created = asset_result
            else:
                created = asset_result.get("_created", True)
            if created:
                chunks_created += 1

        return {
            "chunks_created": chunks_created,
            "language": transcript["language"],
            "duration_seconds": file.get("duration_seconds"),
        }
