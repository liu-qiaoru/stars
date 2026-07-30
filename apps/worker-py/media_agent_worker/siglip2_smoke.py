"""Phase 4 的 SigLIP2 真实模型冒烟测试。

该脚本不读写 PostgreSQL 或 Qdrant，只加载正式 checkpoint，并对一张本地图片分别执行
图片、英文查询和中文查询嵌入。输出 JSON 记录模型加载/首次/热推理耗时、进程内存和
图文余弦相似度，供 Phase 4 报告留档。它不是质量评测：单张图片只能证明模型可运行，
真正的中文/英文召回差异仍要在阶段 8 的冻结评测集上判断。
"""

import argparse
import json
import os
import resource
import sys
import time

import psutil

from .embeddings import (
    DEFAULT_SIGLIP_MODEL_NAME,
    DEFAULT_SIGLIP_MODEL_VERSION,
    DEFAULT_SIGLIP_VECTOR_DIM,
    SiglipEmbedder,
)


def _synchronize_device(device, torch_module):
    """等待异步加速设备完成，避免把排队时间误当成真实推理耗时。"""
    if device == "mps":
        torch_module.mps.synchronize()
    elif device == "cuda":
        torch_module.cuda.synchronize()


def _measure(callable_, *, device, torch_module):
    _synchronize_device(device, torch_module)
    started = time.perf_counter()
    value = callable_()
    _synchronize_device(device, torch_module)
    return value, time.perf_counter() - started


def _dot(left, right):
    """向量已由 Embedder 归一化，点积即余弦相似度，范围理论上为 -1 到 1。"""
    return sum(left_value * right_value for left_value, right_value in zip(left, right))


def _max_rss_bytes():
    """把 macOS/Linux 的 ru_maxrss 单位统一成字节。"""
    raw = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return raw if sys.platform == "darwin" else raw * 1024


def run_smoke(*, image_path, english_query, chinese_query, device):
    """加载正式 SigLIP2 并返回单设备的可复跑诊断数据。"""
    process = psutil.Process(os.getpid())
    rss_before_load = process.memory_info().rss
    load_started = time.perf_counter()
    embedder = SiglipEmbedder(
        model_name=DEFAULT_SIGLIP_MODEL_NAME,
        model_version=DEFAULT_SIGLIP_MODEL_VERSION,
        expected_vector_dim=DEFAULT_SIGLIP_VECTOR_DIM,
        device=device,
    )
    _synchronize_device(embedder.device, embedder.torch)
    load_seconds = time.perf_counter() - load_started
    rss_after_load = process.memory_info().rss

    image_vector, first_image_seconds = _measure(
        lambda: embedder.embed_image_path(image_path),
        device=embedder.device,
        torch_module=embedder.torch,
    )
    _warm_image_vector, warm_image_seconds = _measure(
        lambda: embedder.embed_image_path(image_path),
        device=embedder.device,
        torch_module=embedder.torch,
    )
    english_vector, first_english_seconds = _measure(
        lambda: embedder.embed_text(english_query),
        device=embedder.device,
        torch_module=embedder.torch,
    )
    _warm_english_vector, warm_english_seconds = _measure(
        lambda: embedder.embed_text(english_query),
        device=embedder.device,
        torch_module=embedder.torch,
    )
    chinese_vector, chinese_seconds = _measure(
        lambda: embedder.embed_text(chinese_query),
        device=embedder.device,
        torch_module=embedder.torch,
    )

    return {
        "model_name": embedder.model_name,
        "model_version": embedder.model_version,
        "device": embedder.device,
        "vector_dim": len(image_vector),
        "load_seconds": round(load_seconds, 4),
        "first_image_seconds": round(first_image_seconds, 4),
        "warm_image_seconds": round(warm_image_seconds, 4),
        "first_english_text_seconds": round(first_english_seconds, 4),
        "warm_english_text_seconds": round(warm_english_seconds, 4),
        "chinese_text_seconds": round(chinese_seconds, 4),
        "rss_before_load_bytes": rss_before_load,
        "rss_after_load_bytes": rss_after_load,
        "rss_after_inference_bytes": process.memory_info().rss,
        "max_rss_bytes": _max_rss_bytes(),
        "english_image_cosine": round(_dot(image_vector, english_vector), 6),
        "chinese_image_cosine": round(_dot(image_vector, chinese_vector), 6),
        "english_query": english_query,
        "chinese_query": chinese_query,
        "image_path": os.path.abspath(image_path),
    }


def main():
    parser = argparse.ArgumentParser(description="Run the Phase 4 SigLIP2 smoke test")
    parser.add_argument("--image", required=True, help="本地测试图片路径")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda", "auto"), default="auto")
    parser.add_argument("--english-query", required=True)
    parser.add_argument("--chinese-query", required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            run_smoke(
                image_path=args.image,
                english_query=args.english_query,
                chinese_query=args.chinese_query,
                device=args.device,
            ),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
