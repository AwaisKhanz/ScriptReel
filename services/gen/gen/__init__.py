"""ScriptReel generative fallback service (doc 25 §5-E).

Deliberately isolated from the sidecar (services/ml): FLUX/mflux needs numpy>=2 +
torch>=2.7 + transformers>=5, which conflicts with the sidecar's pinned numpy<2
(mlx-whisper's numba). The worker never imports this — it shells out `uv run python -m
gen ...` as a subprocess, exactly like it shells out to ffmpeg.
"""

from __future__ import annotations

import os
from pathlib import Path

# HF_HOME → the repo's data/models (mirror services/ml/app/main.py), set at import — before
# any model library is imported — so generated-model weights share the sidecar's cache and
# `make fetch-gen` lands them where this service looks. setdefault honors an explicit HF_HOME.
_REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))
