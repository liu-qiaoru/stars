import base64
import json
import tempfile
import unittest
from unittest.mock import patch

from media_agent_worker.vlm_service import (
    OllamaVlCaptioner,
    build_captioner_from_env,
    handle_caption_request,
)


class FakeCaptioner:
    model_name = "Qwen/Qwen2.5-VL-7B-Instruct"
    model_version = "qwen2.5-vl-7b-instruct"

    def __init__(self):
        self.calls = []

    def caption_image_paths(self, image_paths, prompt):
        self.calls.append((image_paths, prompt))
        return "一只猫坐在窗边"


class VlmServiceTest(unittest.TestCase):
    def test_caption_request_returns_model_metadata_and_caption(self):
        captioner = FakeCaptioner()

        response = handle_caption_request(captioner, {
            "image_path": "/tmp/frame.jpg",
            "prompt_version": "caption-v1",
            "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
            "model_version": "qwen2.5-vl-7b-instruct",
        })

        self.assertEqual(response, {
            "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
            "model_version": "qwen2.5-vl-7b-instruct",
            "prompt_version": "caption-v1",
            "caption": "一只猫坐在窗边",
        })
        self.assertEqual(captioner.calls[0][0], ["/tmp/frame.jpg"])

    def test_scene_caption_request_passes_multiple_images_in_order(self):
        captioner = FakeCaptioner()

        response = handle_caption_request(captioner, {
            "image_paths": ["/tmp/frame-1.jpg", "/tmp/frame-2.jpg", "/tmp/frame-3.jpg"],
            "frame_times_seconds": [5.0, 15.0, 25.0],
            "prompt_version": "scene-caption-v2",
            "model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
            "model_version": "qwen2.5-vl-7b-instruct",
        })

        self.assertEqual(response["prompt_version"], "scene-caption-v2")
        self.assertEqual(captioner.calls[0][0], ["/tmp/frame-1.jpg", "/tmp/frame-2.jpg", "/tmp/frame-3.jpg"])
        self.assertIn("按时间", captioner.calls[0][1])

    def test_caption_request_rejects_wrong_model(self):
        with self.assertRaisesRegex(ValueError, "Unsupported model_name"):
            handle_caption_request(FakeCaptioner(), {
                "image_path": "/tmp/frame.jpg",
                "model_name": "other/model",
                "model_version": "qwen2.5-vl-7b-instruct",
            })

    def test_ollama_captioner_posts_image_to_generate_endpoint(self):
        calls = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return json.dumps({"response": "一只猫坐在窗边"}).encode("utf-8")

        def fake_urlopen(request, timeout):
            calls.append((request, timeout))
            return FakeResponse()

        with tempfile.NamedTemporaryFile() as image_file:
            image_file.write(b"fake image bytes")
            image_file.flush()

            captioner = OllamaVlCaptioner(
                ollama_model="qwen2.5vl:7b",
                base_url="http://ollama.local",
                timeout_seconds=12,
                urlopen=fake_urlopen,
            )

            caption = captioner.caption_image_paths([image_file.name], prompt="describe")

        self.assertEqual(caption, "一只猫坐在窗边")
        self.assertEqual(calls[0][0].full_url, "http://ollama.local/api/generate")
        self.assertEqual(calls[0][1], 12)
        payload = json.loads(calls[0][0].data.decode("utf-8"))
        self.assertEqual(payload["model"], "qwen2.5vl:7b")
        self.assertEqual(payload["prompt"], "describe")
        self.assertFalse(payload["stream"])
        self.assertEqual(base64.b64decode(payload["images"][0]), b"fake image bytes")

    def test_ollama_captioner_surfaces_ollama_error(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return json.dumps({"error": "model not found"}).encode("utf-8")

        def fake_urlopen(request, timeout):
            return FakeResponse()

        with tempfile.NamedTemporaryFile() as image_file:
            image_file.write(b"fake image bytes")
            image_file.flush()
            captioner = OllamaVlCaptioner(urlopen=fake_urlopen)

            with self.assertRaisesRegex(RuntimeError, "model not found"):
                captioner.caption_image_paths([image_file.name], prompt="describe")

    def test_ollama_captioner_posts_multiple_images_to_generate_endpoint(self):
        calls = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return json.dumps({"response": "连续场景描述"}).encode("utf-8")

        def fake_urlopen(request, timeout):
            calls.append(request)
            return FakeResponse()

        with tempfile.NamedTemporaryFile() as first, tempfile.NamedTemporaryFile() as second:
            first.write(b"first")
            second.write(b"second")
            first.flush()
            second.flush()
            captioner = OllamaVlCaptioner(urlopen=fake_urlopen)

            captioner.caption_image_paths([first.name, second.name], prompt="describe scene")

        payload = json.loads(calls[0].data.decode("utf-8"))
        self.assertEqual([base64.b64decode(value) for value in payload["images"]], [b"first", b"second"])

    def test_build_captioner_defaults_to_ollama_backend(self):
        with patch.dict("os.environ", {}, clear=True):
            captioner = build_captioner_from_env()

        self.assertIsInstance(captioner, OllamaVlCaptioner)


if __name__ == "__main__":
    unittest.main()
