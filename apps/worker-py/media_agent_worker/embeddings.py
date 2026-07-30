import math
import os


# Phase 4 统一图片、视频帧和同步查询文本所用的 checkpoint。SigLIP 与
# SigLIP2 即使投影维度相同也属于不同向量空间，旧向量必须重新生成。
DEFAULT_SIGLIP_MODEL_NAME = "google/siglip2-base-patch16-224"
DEFAULT_SIGLIP_MODEL_VERSION = "siglip2-base-patch16-224"
DEFAULT_SIGLIP_VECTOR_DIM = 768
DEFAULT_CAPTION_TEXT_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_CAPTION_TEXT_MODEL_VERSION = "paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_CAPTION_TEXT_VECTOR_DIM = 384


def mean_pool_hidden_state(hidden_state, attention_mask):
    """按有效 token 做平均池化，把一段 Caption 压缩为一个文本向量。

    Token 是模型处理文字后的最小编号单元；attention_mask 中的 1 表示真实文字，
    0 表示补齐长度用的空位。忽略空位可保证索引 Caption 与同步查询使用相同公式。
    """
    expanded_mask = attention_mask.unsqueeze(-1).expand(hidden_state.size()).float()
    return (hidden_state * expanded_mask).sum(dim=1) / expanded_mask.sum(dim=1).clamp(min=1e-9)


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
    """Local SigLIP2 wrapper shared by batch jobs and the synchronous model service.

    图片/视频帧由 Worker 批量调用，查询文本由 Server 通过模型服务同步调用；
    两条路径共享同一 checkpoint、预处理器和投影维度，避免跨模型比较无意义的向量。
    """

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
                "Install torch, transformers, and pillow to use SigLIP2 embeddings"
            ) from error

        self.torch = torch
        self.Image = Image
        self.model_name = model_name
        self.model_version = model_version
        self.expected_vector_dim = expected_vector_dim
        self.device = select_torch_device(device, torch_module=torch)
        # 显式固定 fast processor。Transformers 已提示后续版本会把它改成默认值；
        # 提前固定可以让图片与文本预处理不随依赖库默认值漂移。不能传 use_fast=False：
        # 它还会切换文本 Tokenizer，导致 SigLIP2 丢失固定长度配置并改变查询向量。
        self.processor = AutoProcessor.from_pretrained(model_name, use_fast=True)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.to(self.device)
        self.model.eval()
        self.vector_dim = expected_vector_dim

    def embed_text(self, text):
        # SigLIP2 的文本塔按固定序列长度训练。查询时使用相同的 max_length 填充，
        # 避免单条短查询因动态长度预处理而偏离图片向量所对应的训练分布。
        # 这里只改变同步查询向量；已经写入 Qdrant 的图片/视频帧向量无需重建。
        inputs = self.processor(text=[text], padding="max_length", return_tensors="pt")
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
                f"SigLIP2 vector dimension mismatch: expected {self.expected_vector_dim}, got {actual_dim}"
            )
        self.vector_dim = actual_dim
        return normalize_vector(vector)


class TransformerTextEmbedder:
    """Local text embedding wrapper for generated VLM captions."""

    def __init__(
        self,
        *,
        model_name=DEFAULT_CAPTION_TEXT_MODEL_NAME,
        model_version=DEFAULT_CAPTION_TEXT_MODEL_VERSION,
        expected_vector_dim=DEFAULT_CAPTION_TEXT_VECTOR_DIM,
        device=None,
    ):
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except ImportError as error:
            raise RuntimeError(
                "Install torch and transformers to use caption text embeddings"
            ) from error

        self.torch = torch
        self.model_name = model_name
        self.model_version = model_version
        self.expected_vector_dim = expected_vector_dim
        self.device = select_torch_device(device, torch_module=torch)
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.to(self.device)
        self.model.eval()
        self.vector_dim = expected_vector_dim

    def embed_text(self, text):
        inputs = self.tokenizer(
            [text],
            padding=True,
            truncation=True,
            return_tensors="pt",
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.no_grad():
            outputs = self.model(**inputs)
            pooled = mean_pool_hidden_state(
                outputs.last_hidden_state,
                inputs["attention_mask"],
            )
        vector = pooled[0].detach().float().cpu().tolist()
        actual_dim = len(vector)
        if self.expected_vector_dim is not None and actual_dim != self.expected_vector_dim:
            raise RuntimeError(
                f"Caption text vector dimension mismatch: expected {self.expected_vector_dim}, got {actual_dim}"
            )
        self.vector_dim = actual_dim
        return normalize_vector(vector)
