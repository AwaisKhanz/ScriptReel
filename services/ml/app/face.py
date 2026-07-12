"""InsightFace face-identity embeddings (doc 25 §5-C, cascade C).

Reference identity for a beat that names a specific PERSON: the score stage embeds
the entity's Wikidata P18 portrait and the beat's top-5 candidate thumbs here, then
compares face cosine to veto lookalikes (a different man standing in for the named
person). ``buffalo_l`` returns a 512-d ArcFace ``normed_embedding`` per face,
already L2-normalized, so cosine is a plain dot product.

InsightFace and its model pack are OPTIONAL and NOT installed by default — the
pretrained buffalo models are non-commercial-research licensed (doc 25 §6). Loading
the model IS the availability signal: a missing package or pack raises here,
``available()`` caches ``False``, and ``embed_faces`` raises ``FaceError`` (a 500 the
worker catches) so the whole identity pass skips and the render is unchanged
(invariant 7 — degrade, never die). Nothing here can fail or alter a render when the
model is absent.

Embeddings are cached on disk as ``{path}.face.f32`` (raw little-endian float32),
mirroring embed.py — re-runs and re-scores are free. An ``asyncio`` lock serialises
the heavy forward passes; the availability probe interleaves.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np

_FACE_DIM = 512  # buffalo_l ArcFace embedding width — fixed
_CACHE_SUFFIX = ".face.f32"

_app: object | None = None
_available_cache: bool | None = None  # one-time availability probe cache
_infer_lock = asyncio.Lock()


class FaceError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_FACE"


def available() -> bool:
    """True when InsightFace + the ``buffalo_l`` pack construct and prepare. Cached —
    the probe (import + FaceAnalysis construction + prepare, which forces the model
    download on first use) runs at most once per process. Loading the model IS the
    availability signal: a missing package or pack raises here and caches ``False``."""
    global _app, _available_cache
    if _available_cache is None:
        try:
            from insightface.app import FaceAnalysis

            app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
            app.prepare(ctx_id=-1, det_size=(640, 640))
            _app = app
            _available_cache = True
        except Exception:  # noqa: BLE001 — missing package / pack / import failure ⇒ unavailable
            _available_cache = False
    return _available_cache


def _cache_path(path: str) -> Path:
    return Path(path + _CACHE_SUFFIX)


def _read_cache(path: str) -> np.ndarray | None:
    p = _cache_path(path)
    try:
        if not p.is_file():
            return None
        vec = np.fromfile(p, dtype=np.float32)
        return vec if vec.shape == (_FACE_DIM,) else None
    except OSError:
        return None


def _write_cache(path: str, vec: np.ndarray) -> None:
    try:
        vec.astype(np.float32).tofile(_cache_path(path))
    except OSError:
        pass  # cache is best-effort; a write failure just costs a re-embed


def _bbox_area(face: object) -> float:
    x1, y1, x2, y2 = face.bbox  # type: ignore[attr-defined]
    return float((x2 - x1) * (y2 - y1))


def _embed_faces_sync(paths: list[str]) -> tuple[np.ndarray, list[str]]:
    from PIL import Image

    assert _app is not None
    out = np.zeros((len(paths), _FACE_DIM), dtype=np.float32)
    failed: list[str] = []
    for i, path in enumerate(paths):
        cached = _read_cache(path)
        if cached is not None:
            out[i] = cached
            continue
        try:
            rgb = np.asarray(Image.open(path).convert("RGB"))
        except Exception:  # noqa: BLE001 — unreadable/corrupt image → drop candidate
            failed.append(path)
            continue
        # InsightFace expects BGR (OpenCV convention); flip the channel axis. Force a
        # contiguous copy — `[..., ::-1]` is a negative-stride view that cv2 / onnxruntime
        # inside `app.get` can reject ("incompatible layout").
        bgr = np.ascontiguousarray(rgb[:, :, ::-1])
        faces = _app.get(bgr)  # type: ignore[attr-defined]
        if not faces:
            failed.append(path)  # no detectable face → no identity for this image
            continue
        # Largest bbox = the portrait's main subject, not a bystander in the background.
        best = max(faces, key=_bbox_area)
        vec = np.asarray(best.normed_embedding, dtype=np.float32)  # already L2-normalized
        out[i] = vec
        _write_cache(path, vec)
    return out, failed


async def embed_faces(paths: list[str]) -> tuple[list[list[float]], int, list[str]]:
    # Probe before threading — a missing model is a 500 the worker catches, not work.
    if not available():
        raise FaceError(
            "E_FACE_UNAVAILABLE: insightface model not installed — "
            "cd services/ml && uv sync && make fetch-identity"
        )
    if not paths:
        return [], _FACE_DIM, []
    async with _infer_lock:
        vectors, failed = await asyncio.to_thread(_embed_faces_sync, paths)
    return vectors.tolist(), int(vectors.shape[1]), failed
