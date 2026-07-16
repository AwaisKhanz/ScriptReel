"""SigLIP 2 embeddings (doc 09 / doc 14).

One shared SigLIP 2 base model, lazy-loaded and kept warm. Text and image towers
produce L2-normalized vectors so cosine similarity is a plain dot product. Image
embeddings are cached on disk next to their thumbnail (``{thumb}.{model-slug}.emb.f32``, raw
little-endian float32) — re-runs and re-scores are free. An asyncio lock
serialises the heavy forward passes; light ops (health) still interleave.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

import numpy as np

_log = logging.getLogger("scriptreel.embed")

MODEL_ID = os.environ.get("SIGLIP_MODEL", "google/siglip2-base-patch16-224")
_TEXT_MAX_TOKENS = 64  # SigLIP text tower is fixed-length; must pad to max_length
_IMAGE_BATCH = 16  # doc 14: batch 16 on MPS


def _model_slug(model_id: str) -> str:
    """Filesystem-safe tag identifying which model produced a cached vector."""
    return re.sub(r"[^a-z0-9]+", "-", model_id.lower()).strip("-")


# Cached vectors are keyed by MODEL_ID, not just ".emb.f32".
#
# Embeddings from different models are NOT interchangeable, and the dimension guard in
# _read_cache only catches it when the dims happen to differ (base-224 is 768-d, so-400m is
# 1152-d — caught by luck). Two same-dimension variants would silently return the PREVIOUS
# model's vectors, so `pnpm eval:matching` would "re-run" and quietly score the new model using
# stale embeddings — defeating the one rule CLAUDE.md states about this ("τ are model-specific;
# re-run the eval"). Keying by model makes a swap a cache MISS, which is the correct behaviour,
# and lets both models' vectors coexist so switching back is still free.
_EMB_SUFFIX = f".{_model_slug(MODEL_ID)}.emb.f32"

_model: object | None = None
_processor: object | None = None
_device: str = "cpu"
_load_lock = asyncio.Lock()
# First load failure, remembered forever. See _ensure_loaded — a retry cannot succeed, and lies.
_load_error: str | None = None
_infer_lock = asyncio.Lock()


class EmbedError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_EMBED"


async def _ensure_loaded() -> None:
    global _model, _processor, _device, _load_error
    async with _load_lock:
        if _model is not None:
            return
        # A failed import is PERMANENT for this process, so replay the first error instead of
        # retrying. `import transformers` pulls torch._dynamo, whose package.py registers a cache
        # artifact at module scope. If that import dies partway, the half-initialised modules stay
        # in sys.modules, and the next attempt re-runs the decorator and raises
        #   AssertionError: Artifact of type=precompile already registered in mega-cache artifact factory
        # — which then masks the real cause on every subsequent call. That is not hypothetical: a
        # missing USERNAME (turbo's strict env mode) made torch's getpass.getuser() fall through to
        # `import pwd` on Windows; the first call reported that honestly and every call after blamed
        # the artifact factory, which is where the debugging went wrong. The process needs a restart
        # either way — so say why, accurately, every time.
        if _load_error is not None:
            raise EmbedError(_load_error)
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
            # transformers can leave SigLIP's weights on the torch META device — the checkpoint
            # never materializes — and the later `.to(device)` then dies with "Cannot copy out of
            # meta tensor; no data!". On macOS low_cpu_mem_usage=False avoids it, but on some torch
            # builds (seen on Windows / torch 2.13) it's an INTERMITTENT concurrent-load race inside
            # the threaded sidecar (transformers#41782) — the same build loads fine most runs. So
            # load normally, then if ANY weight is on meta, force-materialize from the local
            # checkpoint: real CPU storage (to_empty), copy the checkpoint tensors, and restore the
            # non-persistent arange position_ids buffers. Verified bit-exact vs a normal load.
            model = AutoModel.from_pretrained(MODEL_ID, low_cpu_mem_usage=False)
            if any(t.is_meta for t in (*model.parameters(), *model.buffers())):
                from huggingface_hub import snapshot_download
                from safetensors.torch import load_file

                _log.warning("SigLIP on meta device (transformers#41782 race) — materializing")
                # already cached (from_pretrained just resolved it) — local_files_only, no network
                snap = snapshot_download(MODEL_ID, local_files_only=True)
                weights = load_file(Path(snap) / "model.safetensors")
                model = model.to_empty(device="cpu")
                model.load_state_dict(weights, strict=False, assign=False)
                for name, buf in model.named_buffers():
                    if name.endswith("position_ids"):
                        buf.copy_(torch.arange(buf.shape[-1], device=buf.device).expand(buf.shape))
            model.eval()
            if _device != "cpu":
                model = model.to(_device)
            _model = model
            _processor = AutoProcessor.from_pretrained(MODEL_ID)
        except Exception as exc:  # noqa: BLE001 — surface any load failure as E_MODEL_LOAD
            # Log the full traceback (like ocr/vlm) — the endpoint only returns the short code,
            # so without this a SigLIP load failure is undiagnosable from the sidecar console.
            # `_device` is only assigned once the import succeeds, so on an import failure it still
            # holds its "cpu" default — say "device unresolved" rather than print a reading that
            # looks like a CUDA problem and isn't.
            where = _device if _model is not None else f"{_device} (unresolved — load never got there)"
            _log.warning("SigLIP load failed (%s) on device=%s", MODEL_ID, where, exc_info=True)
            _load_error = f"E_MODEL_LOAD: SigLIP 2 ({MODEL_ID}) — {exc}"
            raise EmbedError(_load_error) from exc


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
