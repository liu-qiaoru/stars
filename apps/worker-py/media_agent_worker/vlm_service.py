import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urllib_error
from urllib import request as urllib_request

from .embeddings import select_torch_device
from .env import load_project_env


DEFAULT_VLM_MODEL_NAME = "Qwen/Qwen2.5-VL-7B-Instruct"
DEFAULT_VLM_MODEL_VERSION = "qwen2.5-vl-7b-instruct"
DEFAULT_LOCAL_VLM_BACKEND = "ollama"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_VLM_MODEL = "qwen2.5vl:7b"
DEFAULT_CAPTION_PROMPT = (
    "请用中文简洁描述画面中的主体、动作、场景、可见文字和风格。"
    "只输出描述，不要输出列表或解释。"
)


class OllamaVlCaptioner:
    def __init__(
        self,
        *,
        ollama_model=DEFAULT_OLLAMA_VLM_MODEL,
        base_url=DEFAULT_OLLAMA_BASE_URL,
        model_name=DEFAULT_VLM_MODEL_NAME,
        model_version=DEFAULT_VLM_MODEL_VERSION,
        timeout_seconds=120,
        urlopen=urllib_request.urlopen,
    ):
        self.ollama_model = ollama_model
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.model_version = model_version
        self.timeout_seconds = int(timeout_seconds)
        self.urlopen = urlopen

    def caption_image_path(self, image_path, prompt=DEFAULT_CAPTION_PROMPT):
        with open(image_path, "rb") as image_file:
            encoded_image = base64.b64encode(image_file.read()).decode("ascii")
        payload = {
            "model": self.ollama_model,
            "prompt": prompt,
            "images": [encoded_image],
            "stream": False,
        }
        request = urllib_request.Request(
            f"{self.base_url}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with self.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
        except urllib_error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Ollama /api/generate failed with HTTP {error.code}: {body}"
            ) from error
        except urllib_error.URLError as error:
            raise RuntimeError(f"Cannot reach Ollama at {self.base_url}: {error.reason}") from error

        response_payload = json.loads(body.decode("utf-8") or "{}")
        if isinstance(response_payload.get("error"), str) and response_payload["error"]:
            raise RuntimeError(f"Ollama returned error: {response_payload['error']}")
        caption = response_payload.get("response")
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError("Ollama returned empty caption")
        return caption.strip()


class TransformersQwenVlCaptioner:
    def __init__(
        self,
        *,
        model_name=DEFAULT_VLM_MODEL_NAME,
        model_version=DEFAULT_VLM_MODEL_VERSION,
        device=None,
        max_new_tokens=128,
    ):
        try:
            import torch
            import torchvision  # noqa: F401
            import accelerate  # noqa: F401
            from PIL import Image
            from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
        except ImportError as error:
            raise RuntimeError(
                "Install torch, torchvision, accelerate, pillow and a transformers version with Qwen2.5-VL support to use local VLM captioning"
            ) from error

        self.torch = torch
        self.Image = Image
        self.model_name = model_name
        self.model_version = model_version
        self.device = select_torch_device(device, torch_module=torch)
        self.max_new_tokens = int(max_new_tokens)
        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype="auto",
            device_map="auto" if self.device != "cpu" else None,
        )
        if self.device == "cpu":
            self.model.to(self.device)
        self.model.eval()

    def caption_image_path(self, image_path, prompt=DEFAULT_CAPTION_PROMPT):
        with self.Image.open(image_path) as image:
            image = image.convert("RGB")
            messages = [{
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt},
                ],
            }]
            text = self.processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            inputs = self.processor(text=[text], images=[image], return_tensors="pt")
        target_device = next(self.model.parameters()).device
        inputs = {key: value.to(target_device) for key, value in inputs.items()}
        with self.torch.no_grad():
            generated_ids = self.model.generate(**inputs, max_new_tokens=self.max_new_tokens)
        trimmed_ids = [
            output_ids[len(input_ids):]
            for input_ids, output_ids in zip(inputs["input_ids"], generated_ids)
        ]
        caption = self.processor.batch_decode(
            trimmed_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0].strip()
        if not caption:
            raise ValueError("Qwen2.5-VL returned empty caption")
        return caption


QwenVlCaptioner = TransformersQwenVlCaptioner


def build_captioner_from_env():
    backend = os.environ.get("LOCAL_VLM_BACKEND", DEFAULT_LOCAL_VLM_BACKEND).strip().lower()
    model_name = os.environ.get("LOCAL_VLM_MODEL_NAME", DEFAULT_VLM_MODEL_NAME)
    model_version = os.environ.get("LOCAL_VLM_MODEL_VERSION", DEFAULT_VLM_MODEL_VERSION)
    if backend == "ollama":
        return OllamaVlCaptioner(
            ollama_model=os.environ.get("OLLAMA_VLM_MODEL", DEFAULT_OLLAMA_VLM_MODEL),
            base_url=os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL),
            model_name=model_name,
            model_version=model_version,
            timeout_seconds=os.environ.get("LOCAL_VLM_TIMEOUT_SECONDS", "120"),
        )
    if backend in ("transformers", "huggingface", "hf"):
        return TransformersQwenVlCaptioner(
            model_name=model_name,
            model_version=model_version,
            max_new_tokens=os.environ.get("LOCAL_VLM_MAX_NEW_TOKENS", "128"),
        )
    raise ValueError(f"Unsupported LOCAL_VLM_BACKEND: {backend}")


def handle_caption_request(captioner, payload):
    image_path = payload.get("image_path")
    if not isinstance(image_path, str) or not image_path:
        raise ValueError("image_path is required")
    prompt_version = payload.get("prompt_version", "caption-v1")
    if prompt_version != "caption-v1":
        raise ValueError(f"Unsupported prompt_version: {prompt_version}")
    requested_model_name = payload.get("model_name")
    requested_model_version = payload.get("model_version")
    if requested_model_name not in (None, captioner.model_name):
        raise ValueError(f"Unsupported model_name: {requested_model_name}")
    if requested_model_version not in (None, captioner.model_version):
        raise ValueError(f"Unsupported model_version: {requested_model_version}")
    caption = captioner.caption_image_path(image_path, prompt=DEFAULT_CAPTION_PROMPT)
    return {
        "model_name": captioner.model_name,
        "model_version": captioner.model_version,
        "prompt_version": prompt_version,
        "caption": caption,
    }


class VlmServiceHandler(BaseHTTPRequestHandler):
    captioner = None

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404, "Unknown endpoint")
            return
        self._write_json(200, {"status": "ok"})

    def do_POST(self):
        try:
            payload = self._read_json()
            if self.path == "/caption":
                result = handle_caption_request(self.captioner, payload)
            else:
                self.send_error(404, "Unknown endpoint")
                return
            self._write_json(200, result)
        except ValueError as error:
            self._write_json(400, {"error": str(error)})
        except Exception as error:
            self._write_json(500, {"error": str(error)})

    def _read_json(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}")

    def _write_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_vlm_service(host="127.0.0.1", port=4030, captioner=None):
    handler_class = type("ConfiguredVlmServiceHandler", (VlmServiceHandler,), {})
    handler_class.captioner = captioner or build_captioner_from_env()
    server = ThreadingHTTPServer((host, port), handler_class)
    server.serve_forever()


def main():
    load_project_env()
    run_vlm_service(
        host=os.environ.get("LOCAL_VLM_SERVICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("LOCAL_VLM_SERVICE_PORT", "4030")),
    )


if __name__ == "__main__":
    main()
