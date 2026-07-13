"""Lazy model access for the sidecar.

Phase 0 only checks that torch reports a device and that the model libraries are
importable. No model weights are loaded. Later phases add cached singletons here
behind the worker-side TtsEngine / Embedder / Aligner interfaces (doc 03, doc 14).
"""

from __future__ import annotations

import importlib.util
import platform
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL.Image import Image as PilImage


def is_apple_silicon() -> bool:
    """True only on Apple-Silicon Macs (darwin + arm64) — the ONLY platform MLX runs on.

    MLX ships arm64-mac wheels exclusively; on Windows/Linux/Intel-Mac ``import mlx.core`` fails
    at the native DLL load *even when the pip package is present* (e.g. a stale venv that still
    has the Apple-only packages). Backend selectors must gate on THIS, not on
    ``find_spec('mlx_*')`` — a spec is findable for a present-but-unimportable package, so
    find_spec alone would pick the MLX path and crash. With this gate align.py falls back to
    faster-whisper and the VLM gate degrades cleanly (invariant 7 — degrade, never die)."""
    return sys.platform == "darwin" and platform.machine() == "arm64"


def resize_to_max_side(image: PilImage, max_side: int) -> PilImage:
    """Downscale a PIL image so its longer side is <= max_side (no-op, same object, when it
    already fits). Large diagnostic-playground uploads otherwise explode Qwen2.5-VL's native
    resolution into a multi-GB vision tensor (Metal OOM) and stress tesseract; the pipeline's
    <=384 px thumbnails are untouched. Returns the input unchanged when it's small enough so
    callers can tell whether a resize happened (identity check)."""
    width, height = image.size
    longest = max(width, height)
    if longest <= max_side:
        return image
    scale = max_side / longest
    return image.resize((max(1, round(width * scale)), max(1, round(height * scale))))


def device() -> str:
    """Return the best available torch device without loading any model weights."""
    try:
        import torch
    except ImportError:
        return "unavailable"

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# Libraries that must be importable (installed) but are NOT loaded in Phase 0.
_MODEL_MODULES = (
    "torch",
    "transformers",
    "kokoro",
    "misaki",
    "mlx",
    "mlx_whisper",
    "soundfile",
    "PIL",
)


def check_importable() -> dict[str, bool]:
    """Report which model libraries are importable, without importing them."""
    return {name: importlib.util.find_spec(name) is not None for name in _MODEL_MODULES}
