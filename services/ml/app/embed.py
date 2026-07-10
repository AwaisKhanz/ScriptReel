"""SigLIP 2 embeddings (doc 09 / doc 14).

One shared SigLIP 2 base model, lazy-loaded and kept warm. Text and image towers
produce L2-normalized vectors so cosine similarity is a plain dot product. Image
embeddings are cached on disk next to their thumbnail (``{thumb}.emb.f32``, raw
little-endian float32) — re-runs and re-scores are free. An asyncio lock
serialises the heavy forward passes; light ops (health) still interleave.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import numpy as np

MODEL_ID = os.environ.get("SIGLIP_MODEL", "google/siglip2-base-patch16-224")
_TEXT_MAX_TOKENS = 64  # SigLIP text tower is fixed-length; must pad to max_length
_IMAGE_BATCH = 16  # doc 14: batch 16 on MPS
_EMB_SUFFIX = ".emb.f32"

_model: object | None = None
_processor: object | None = None
_device: str = "cpu"
_load_lock = asyncio.Lock()
_infer_lock = asyncio.Lock()


class EmbedError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_EMBED"


async def _ensure_loaded() -> None:
    global _model, _processor, _device
    async with _load_lock:
        if _model is not None:
            return
        try:
            import torch
            from transformers import AutoModel, AutoProcessor

            _device = (
                "mps"
                if torch.backends.mps.is_available()
                else "cuda"
                if torch.cuda.is_available()
                else "cpu"
            )
            model = AutoModel.from_pretrained(MODEL_ID)
            model.eval()
            model.to(_device)
            _model = model
            _processor = AutoProcessor.from_pretrained(MODEL_ID)
        except Exception as exc:  # noqa: BLE001 — surface any load failure as E_MODEL_LOAD
            raise EmbedError(f"E_MODEL_LOAD: SigLIP 2 ({MODEL_ID}) — {exc}") from exc


def _normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    norms[norms == 0] = 1.0
    return (vectors / norms).astype(np.float32)


def _as_np(feats: object) -> np.ndarray:
    """SigLIP feature getters return a tensor on some transformers versions and a
    pooled-output object on others — accept both, then L2-normalize."""
    import torch

    if isinstance(feats, torch.Tensor):
        tensor = feats
    else:
        pooled = getattr(feats, "pooler_output", None)
        if pooled is None:
            hidden = getattr(feats, "last_hidden_state", None)
            if hidden is None:
                raise EmbedError(f"unexpected embedding output: {type(feats).__name__}")
            pooled = hidden.mean(dim=1)
        tensor = pooled
    return _normalize(tensor.detach().to("cpu", dtype=torch.float32).numpy())


def _embed_texts_sync(texts: list[str]) -> np.ndarray:
    import torch

    assert _model is not None and _processor is not None
    inputs = _processor(
        text=texts,
        padding="max_length",
        max_length=_TEXT_MAX_TOKENS,
        truncation=True,
        return_tensors="pt",
    ).to(_device)
    with torch.no_grad():
        feats = _model.get_text_features(**inputs)  # type: ignore[operator]
    return _as_np(feats)


def _embed_images_sync(paths: list[str]) -> tuple[np.ndarray, list[str]]:
    import torch
    from PIL import Image

    assert _model is not None and _processor is not None
    dim = _text_dim()
    out = np.zeros((len(paths), dim), dtype=np.float32)
    failed: list[str] = []

    # Split into cached (load from disk) and pending (need a forward pass).
    pending: list[tuple[int, object]] = []  # (row index, PIL image)
    for i, path in enumerate(paths):
        cached = _read_cache(path, dim)
        if cached is not None:
            out[i] = cached
            continue
        try:
            img = Image.open(path).convert("RGB")
            pending.append((i, img))
        except Exception:  # noqa: BLE001 — unreadable/corrupt thumb → drop candidate
            failed.append(path)  # row stays zero; caller drops it via `failed`

    for start in range(0, len(pending), _IMAGE_BATCH):
        batch = pending[start : start + _IMAGE_BATCH]
        images = [img for _, img in batch]
        inputs = _processor(images=images, return_tensors="pt").to(_device)
        with torch.no_grad():
            feats = _model.get_image_features(**inputs)  # type: ignore[operator]
        vecs = _as_np(feats)
        for (row, _img), vec in zip(batch, vecs, strict=True):
            out[row] = vec
            _write_cache(paths[row], vec)

    return out, failed


def _text_dim() -> int:
    assert _model is not None
    cfg = getattr(_model, "config", None)
    # Siglip2Config exposes the shared projection dim on the text sub-config.
    for attr in ("text_config",):
        sub = getattr(cfg, attr, None)
        if sub is not None and getattr(sub, "hidden_size", None):
            return int(sub.hidden_size)
    return 768


def _cache_path(thumb_path: str) -> Path:
    return Path(thumb_path + _EMB_SUFFIX)


def _read_cache(thumb_path: str, dim: int) -> np.ndarray | None:
    p = _cache_path(thumb_path)
    try:
        if not p.is_file():
            return None
        vec = np.fromfile(p, dtype=np.float32)
        return vec if vec.shape == (dim,) else None
    except OSError:
        return None


def _write_cache(thumb_path: str, vec: np.ndarray) -> None:
    try:
        vec.astype(np.float32).tofile(_cache_path(thumb_path))
    except OSError:
        pass  # cache is best-effort; a write failure just costs a re-embed


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], int]:
    if not texts:
        return [], _text_dim() if _model is not None else 768
    await _ensure_loaded()
    async with _infer_lock:
        vectors = await asyncio.to_thread(_embed_texts_sync, texts)
    return vectors.tolist(), int(vectors.shape[1])


async def embed_images(paths: list[str]) -> tuple[list[list[float]], int, list[str]]:
    if not paths:
        return [], _text_dim() if _model is not None else 768, []
    await _ensure_loaded()
    async with _infer_lock:
        vectors, failed = await asyncio.to_thread(_embed_images_sync, paths)
    return vectors.tolist(), int(vectors.shape[1]), failed


def is_loaded() -> bool:
    return _model is not None
