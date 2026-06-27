import math
import os


DEFAULT_SIGLIP_MODEL_NAME = "google/siglip-base-patch16-224"
DEFAULT_SIGLIP_MODEL_VERSION = "siglip-base-patch16-224"
DEFAULT_SIGLIP_VECTOR_DIM = 768


def normalize_vector(vector):
    # Qdrant cosine distance expects normalized vectors for stable score semantics across image/text embeddings.
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        raise ValueError("Embedding vector has zero norm")
    return [value / norm for value in vector]


def select_torch_device(requested=None, torch_module=None):
    # Default auto uses GPU/MPS when available, but explicit SIGLIP_DEVICE must fail loudly if unavailable.
    requested = requested or os.environ.get("SIGLIP_DEVICE", "auto")
    if requested == "cpu":
        return "cpu"

    torch = torch_module
    if torch is None:
        try:
            import torch as imported_torch
        except ImportError:
            return "cpu"
        torch = imported_torch

    if requested in ("cuda", "mps"):
        if requested == "cuda" and torch.cuda.is_available():
            return "cuda"
        if requested == "mps" and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        raise RuntimeError(f"Requested torch device is unavailable: {requested}")

    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class SiglipEmbedder:
    """Local SigLIP wrapper shared by batch embedding jobs and the localhost model service."""

    def __init__(
        self,
        *,
        model_name=DEFAULT_SIGLIP_MODEL_NAME,
        model_version=DEFAULT_SIGLIP_MODEL_VERSION,
        expected_vector_dim=DEFAULT_SIGLIP_VECTOR_DIM,
        device=None,
    ):
        try:
            import torch
            from PIL import Image
            from transformers import AutoModel, AutoProcessor
        except ImportError as error:
            raise RuntimeError(
                "Install torch, transformers, and pillow to use SigLIP embeddings"
            ) from error

        self.torch = torch
        self.Image = Image
        self.model_name = model_name
        self.model_version = model_version
        self.expected_vector_dim = expected_vector_dim
        self.device = select_torch_device(device, torch_module=torch)
        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.to(self.device)
        self.model.eval()
        self.vector_dim = expected_vector_dim

    def embed_text(self, text):
        inputs = self.processor(text=[text], padding=True, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.no_grad():
            if hasattr(self.model, "get_text_features"):
                features = self.model.get_text_features(**inputs)
            else:
                features = self.model(**inputs).text_embeds
        return self._finalize(features[0])

    def embed_image_path(self, path):
        with self.Image.open(path) as image:
            image = image.convert("RGB")
            inputs = self.processor(images=image, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.no_grad():
            if hasattr(self.model, "get_image_features"):
                features = self.model.get_image_features(**inputs)
            else:
                features = self.model(**inputs).image_embeds
        return self._finalize(features[0])

    def _finalize(self, tensor):
        # Dimension mismatches usually mean TS/Python model registry drift; fail before writing a bad Qdrant point.
        vector = tensor.detach().float().cpu().tolist()
        actual_dim = len(vector)
        if self.expected_vector_dim is not None and actual_dim != self.expected_vector_dim:
            raise RuntimeError(
                f"SigLIP vector dimension mismatch: expected {self.expected_vector_dim}, got {actual_dim}"
            )
        self.vector_dim = actual_dim
        return normalize_vector(vector)
