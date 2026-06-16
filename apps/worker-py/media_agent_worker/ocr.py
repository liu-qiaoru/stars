import os
import tempfile
from statistics import mean

from .embedding_worker import extract_video_frame


OCR_TIMEOUT_SECONDS = 7200


def _normalize_block(block):
    if isinstance(block, dict):
        return {
            "text": str(block.get("text", "")).strip(),
            "confidence": float(block.get("confidence", 0.0)),
            "bbox": block.get("bbox"),
        }
    if isinstance(block, (list, tuple)) and len(block) >= 2:
        text_and_score = block[1]
        if isinstance(text_and_score, (list, tuple)) and len(text_and_score) >= 2:
            return {
                "text": str(text_and_score[0]).strip(),
                "confidence": float(text_and_score[1]),
                "bbox": block[0],
            }
    return {"text": "", "confidence": 0.0, "bbox": None}


def _normalize_paddle_result(result):
    if not result:
        return []
    if len(result) == 1 and isinstance(result[0], dict) and "rec_texts" in result[0]:
        page = result[0]
        texts = page.get("rec_texts") or []
        scores = page.get("rec_scores") or []
        boxes = page.get("rec_polys") or page.get("rec_boxes") or []
        return [
            {
                "text": str(text).strip(),
                "confidence": float(scores[index]) if index < len(scores) else 0.0,
                "bbox": boxes[index] if index < len(boxes) else None,
            }
            for index, text in enumerate(texts)
        ]
    first_page = result[0] if len(result) == 1 and isinstance(result[0], list) else result
    return [_normalize_block(block) for block in first_page]


class PaddleOcrReader:
    def __init__(self, *, language=None):
        self.language = language or os.environ.get("OCR_LANGUAGE", "ch")
        self._ocr = None

    def _load(self):
        if self._ocr is not None:
            return self._ocr
        os.environ.setdefault(
            "PADDLE_PDX_CACHE_HOME",
            os.path.join(tempfile.gettempdir(), "media-agent-paddlex-cache"),
        )
        try:
            from paddleocr import PaddleOCR
        except ImportError as error:
            raise RuntimeError("PaddleOCR is not installed. Install paddleocr to run OCR jobs.") from error
        # PaddleOCR 加载较重，worker 进程内懒加载并复用；CI 测试通过 fake ocrer 覆盖协议边界。
        self._ocr = PaddleOCR(lang=self.language)
        return self._ocr

    def read_text(self, image_path):
        ocr = self._load()
        if hasattr(ocr, "predict"):
            result = ocr.predict(image_path, use_textline_orientation=False)
        else:
            result = ocr.ocr(image_path, cls=False)
        return _normalize_paddle_result(result)


class OcrHandler:
    def __init__(
        self,
        repository,
        *,
        ocrer=None,
        frame_extractor=extract_video_frame,
        min_confidence=None,
    ):
        self.repository = repository
        self.ocrer = ocrer or PaddleOcrReader()
        self.frame_extractor = frame_extractor
        self.min_confidence = float(min_confidence or os.environ.get("OCR_MIN_CONFIDENCE", "0.5"))

    def handle(self, job_input):
        engine = job_input.get("engine", os.environ.get("OCR_ENGINE", "paddleocr"))
        if engine != "paddleocr":
            raise ValueError(f"Unsupported OCR engine: {engine}")
        language = job_input.get("language", os.environ.get("OCR_LANGUAGE", "ch"))
        assets_processed = 0
        text_written = 0
        skipped_no_text = 0

        for asset_id in job_input["asset_ids"]:
            asset = self.repository.get_media_asset_for_ocr(asset_id)
            image_path, extracted_path = self._image_path_for_asset(asset)
            try:
                raw_blocks = self.ocrer.read_text(image_path)
            finally:
                if extracted_path is not None:
                    try:
                        os.unlink(extracted_path)
                    except FileNotFoundError:
                        pass

            blocks = raw_blocks
            kept_blocks = [
                block for block in blocks if block["text"] and block["confidence"] >= self.min_confidence
            ]
            assets_processed += 1
            if not kept_blocks:
                skipped_no_text += 1
                continue

            text_content = " ".join(block["text"] for block in kept_blocks)
            self.repository.update_asset_ocr_text(
                asset_id,
                text_content=text_content,
                ocr_metadata={
                    "engine": engine,
                    "language": language,
                    "confidence": round(mean(block["confidence"] for block in kept_blocks), 4),
                    "block_count": len(kept_blocks),
                },
            )
            text_written += 1

        return {
            "assets_processed": assets_processed,
            "text_written": text_written,
            "skipped_no_text": skipped_no_text,
        }

    def _image_path_for_asset(self, asset):
        asset_type = asset["asset_type"]
        if asset_type == "image":
            return asset["path"], None
        if asset_type == "video_frame":
            if asset.get("frame_time_seconds") is None:
                raise ValueError(f"video_frame asset is missing frame_time_seconds: {asset['id']}")
            extracted_path = self.frame_extractor(asset["path"], asset["frame_time_seconds"])
            return extracted_path, extracted_path
        raise ValueError(f"OCR only supports image/video_frame assets, got: {asset_type}")
