"""DINOv2 image-identity embeddings (doc 25 §5-C, cascade C).

Reference identity for a beat that names a specific LANDMARK / BUILDING / ARTWORK:
the score stage embeds the entity's Wikidata reference image and the beat's top-5
candidate thumbs here, then compares image cosine to PENALIZE (not veto) candidates
that don't look like the reference — the wrong building, a different painting. The
L2-normalized CLS token is the descriptor, so cosine is a plain dot product.

DINOv2 (``facebook/dinov2-small``, Apache-2.0) is OPTIONAL and NOT installed by
default. Loading the model IS the availability signal, and it is loaded
``local_files_only`` so an absent snapshot NEVER triggers a surprise network
download that would silently change a render — the gate stays inert until
``make fetch-identity`` pre-fetches the weights. A missing snapshot raises here,
``available()`` caches ``False``, and ``embed_images`` raises ``DinoError`` (a 500
the worker catches) so the identity pass skips and the render is unchanged
(invariant 7 — degrade, never die).

Embeddings are cached on disk as ``{path}.dino.f32`` (raw little-endian float32),
mirroring embed.py. An ``asyncio`` lock serialises the heavy forward passes.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import numpy as np

from app import models

MODEL_ID = os.environ.get("DINO_MODEL", "facebook/dinov2-small")
_CACHE_SUFFIX = ".dino.f32"

_model: object | None = None
_processor: object | None = None
_dim: int | None = None
_device: str = "cpu"
_available_cache: bool | None = None  # one-time availability probe cache
_infer_lock = asyncio.Lock()


class DinoError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_DINO"


def _load() -> None:
    global _model, _processor, _dim, _device
    from transformers import AutoImageProcessor, AutoModel

    device = models.device()
    _device = "cpu" if device == "unavailable" else device
    # local_files_only: never auto-download from a request — an un-fetched model must
    # read as "absent" (raises → available() False), so the gate is truly inert until
    # `make fetch-identity` (the #1 degrade requirement, invariant 7).
    model = AutoModel.from_pretrained(MODEL_ID, local_files_only=True)
    model.eval()
    model.to(_device)
    _model = model
    _processor = AutoImageProcessor.from_pretrained(MODEL_ID, local_files_only=True)
    _dim = int(getattr(model.config, "hidden_size", 384))


def available() -> bool:
    """True when DINOv2 loads from the local HF cache. Cached — the probe (import +
    from_pretrained) runs at most once per process. Loading the model IS the
    availability signal; a missing snapshot raises and caches ``False``."""
    global _available_cache
    if _available_cache is None:
        try:
            _load()
            _available_cache = True
        except Exception:  # noqa: BLE001 — missing snapshot / import failure ⇒ unavailable
            _available_cache = False
    return _available_cache


def _cache_path(path: str) -> Path:
    return Path(path + _CACHE_SUFFIX)


def _read_cache(path: str, dim: int) -> np.ndarray | None:
    p = _cache_path(path)
    try:
        if not p.is_file():
            return None
        vec = np.fromfile(p, dtype=np.float32)
        return vec if vec.shape == (dim,) else None
    except OSError:
        return None


def _write_cache(path: str, vec: np.ndarray) -> None:
    try:
        vec.astype(np.float32).tofile(_cache_path(path))
    except OSError:
        pass  # cache is best-effort; a write failure just costs a re-embed


def _normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    return (vec / norm).astype(np.float32) if norm > 0 else vec.astype(np.float32)


def _embed_images_sync(paths: list[str]) -> tuple[np.ndarray, list[str]]:
    import torch
    from PIL import Image

    assert _model is not None and _processor is not None and _dim is not None
    out = np.zeros((len(paths), _dim), dtype=np.float32)
    failed: list[str] = []
    for i, path in enumerate(paths):
        cached = _read_cache(path, _dim)
        if cached is not None:
            out[i] = cached
            continue
        try:
            img = Image.open(path).convert("RGB")
        except Exception:  # noqa: BLE001 — unreadable/corrupt image → drop candidate
            failed.append(path)
            continue
        inputs = _processor(images=img, return_tensors="pt").to(_device)  # type: ignore[operator]
        with torch.no_grad():
            outputs = _model(**inputs)  # type: ignore[operator]
        cls = outputs.last_hidden_state[:, 0]  # CLS token — the global image descriptor
        vec = _normalize(cls[0].detach().to("cpu", dtype=torch.float32).numpy())
        out[i] = vec
        _write_cache(path, vec)
    return out, failed


async def embed_images(paths: list[str]) -> tuple[list[list[float]], int, list[str]]:
    # Probe before threading — a missing model is a 500 the worker catches, not work.
    if not available():
        raise DinoError("E_DINO_UNAVAILABLE: DINOv2 not installed — make fetch-identity")
    if not paths:
        return [], _dim or 384, []
    async with _infer_lock:
        vectors, failed = await asyncio.to_thread(_embed_images_sync, paths)
    return vectors.tolist(), int(vectors.shape[1]), failed
