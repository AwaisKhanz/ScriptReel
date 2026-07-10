"""Lazy model access for the sidecar.

Phase 0 only checks that torch reports a device and that the model libraries are
importable. No model weights are loaded. Later phases add cached singletons here
behind the worker-side TtsEngine / Embedder / Aligner interfaces (doc 03, doc 14).
"""

from __future__ import annotations

import importlib.util


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
