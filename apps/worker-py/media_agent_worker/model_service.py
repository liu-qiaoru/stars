import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .embeddings import SiglipEmbedder


def handle_embed_text_request(embedder, payload):
    text = payload.get("text")
    if not isinstance(text, str) or not text:
        raise ValueError("text is required")
    vector = embedder.embed_text(text)
    return {
        "model_name": embedder.model_name,
        "model_version": embedder.model_version,
        "vector": vector,
        "vector_dim": len(vector),
    }


def handle_embed_image_request(embedder, payload):
    path = payload.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("path is required")
    vector = embedder.embed_image_path(path)
    return {
        "model_name": embedder.model_name,
        "model_version": embedder.model_version,
        "vector": vector,
        "vector_dim": len(vector),
    }


class ModelServiceHandler(BaseHTTPRequestHandler):
    embedder = None

    def do_POST(self):
        try:
            payload = self._read_json()
            if self.path == "/embed/text":
                result = handle_embed_text_request(self.embedder, payload)
            elif self.path == "/embed/image":
                result = handle_embed_image_request(self.embedder, payload)
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
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_model_service(host="127.0.0.1", port=4020, embedder=None):
    # Model service 是搜索链路的同步 localhost RPC 边界；worker job 仍可在独立进程中批量加载同一 embedder。
    handler_class = type("ConfiguredModelServiceHandler", (ModelServiceHandler,), {})
    handler_class.embedder = embedder or SiglipEmbedder()
    server = ThreadingHTTPServer((host, port), handler_class)
    server.serve_forever()


def main():
    run_model_service(
        host=os.environ.get("MODEL_SERVICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("MODEL_SERVICE_PORT", "4020")),
    )


if __name__ == "__main__":
    main()
