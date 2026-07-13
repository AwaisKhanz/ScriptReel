"""Download and verify the models ScriptReel uses (doc 19 §5, doc 25 §6).

Usage (HF_HOME defaults to the repo's data/models automatically — see below):
    uv run --directory services/ml python -m scripts.fetch_models [--no-flux]
    uv run --directory services/ml python -m scripts.fetch_models --identity

--identity fetches the reference-identity cascade models (doc 25 §5-C): DINOv2
(HF snapshot) plus InsightFace buffalo_l (downloaded by constructing FaceAnalysis,
which pulls the pack into ~/.insightface). Kept separate from the default fetch so
the optional, non-commercial-licensed InsightFace pack (doc 25 §6) is only fetched
when explicitly requested.

Repo ids drift. If a download 404s, search Hugging Face for the current id and
update this list *and* doc 04 rather than pinning a fork.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Mirror app/main.py: default HF_HOME to the repo's data/models so fetched weights land
# exactly where the sidecar looks (main.py sets the same default via setdefault). Without
# this, `make fetch-*` writes to ~/.cache/huggingface and the sidecar — which forces
# data/models — silently can't find them. setdefault still honors an explicit HF_HOME.
_REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))
if sys.platform == "win32":
    # Windows blocks symlinks without admin / Developer Mode (WinError 1314); tell
    # huggingface_hub to COPY blobs into snapshots instead. A little more disk, always works.
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

# (repo id, human label, approx size, note). Kokoro + SigLIP are cross-platform (torch); the
# alignment model differs by platform — mlx-whisper on Apple, faster-whisper (CTranslate2)
# elsewhere — mirroring the pyproject markers + align.py backend selection.
_IS_APPLE = sys.platform == "darwin"
MODELS = [
    ("hexgrad/Kokoro-82M", "Kokoro-82M (TTS)", "~330 MB", ""),
    ("google/siglip2-base-patch16-224", "SigLIP 2 base (matching)", "~800 MB", ""),
]
if _IS_APPLE:
    MODELS += [
        ("mlx-community/whisper-large-v3-turbo", "Whisper large-v3-turbo (alignment, MLX)", "~1.6 GB", ""),
        ("mlx-community/whisper-small-mlx", "Whisper small (alignment fallback, MLX)", "~480 MB", ""),
    ]
else:
    MODELS += [
        (
            os.environ.get("FASTER_WHISPER_MODEL", "Systran/faster-whisper-base"),
            "faster-whisper base (alignment, CTranslate2)",
            "~145 MB",
            "Windows/Linux",
        ),
    ]
FLUX = (
    "dhairyashil/FLUX.1-schnell-mflux-4bit",
    "FLUX.1-schnell 4-bit",
    "~6.5 GB",
    "Phase 13 only",
)
# Reference-identity cascade (doc 25 §5-C), fetched only with --identity.
IDENTITY_MODELS = [
    (
        os.environ.get("DINO_MODEL", "facebook/dinov2-small"),
        "DINOv2 small (landmark / artwork identity)",
        "~88 MB",
        "doc 25 §5-C",
    ),
]
# VLM checklist cascade (doc 25 §5-D), fetched only with --vlm. 4-bit is plenty for a
# constrained yes/no checklist and loads fast on an M3 Pro (load-on-demand, evicted after).
VLM_MODELS = [
    (
        os.environ.get("QWEN_VL_MODEL", "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"),
        "Qwen2.5-VL-3B 4-bit (VLM checklist, MLX)",
        "~2.2 GB",
        "doc 25 §5-D",
    ),
]


def _fetch_list(models: list[tuple[str, str, str, str]], heading: str) -> int:
    """Snapshot-download a list of HF repos. HF_HOME is defaulted at import to the repo's
    data/models so the sidecar finds them."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub is not installed — run `uv sync` in services/ml first.", file=sys.stderr)
        return 1
    print(f"HF_HOME = {os.environ.get('HF_HOME', '<default HF cache>')}")
    print(f"{heading}:\n")
    for repo_id, label, size, note in models:
        suffix = f"  [{note}]" if note else ""
        print(f"-> {label} ({size}) — {repo_id}{suffix}")
        path = snapshot_download(repo_id=repo_id)
        print(f"   ok: {path}\n")
    print("Done.")
    return 0


def _fetch_identity() -> int:
    """Fetch the doc 25 §5-C identity models: DINOv2 (HF snapshot) + InsightFace
    buffalo_l (forced by constructing FaceAnalysis, which downloads to ~/.insightface)."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub is not installed — run `uv sync` in services/ml first.", file=sys.stderr)
        return 1

    print(f"HF_HOME = {os.environ.get('HF_HOME', '<default HF cache>')}")
    print("Fetching reference-identity models (doc 25 §5-C):\n")

    for repo_id, label, size, note in IDENTITY_MODELS:
        suffix = f"  [{note}]" if note else ""
        print(f"-> {label} ({size}) — {repo_id}{suffix}")
        path = snapshot_download(repo_id=repo_id)
        print(f"   ok: {path}\n")

    # InsightFace buffalo_l (~300 MB) has no HF repo; constructing the app triggers its
    # download. Guard the import so a machine without insightface still fetches DINOv2.
    print("-> InsightFace buffalo_l (person identity) (~300 MB)  [doc 25 §6: non-commercial]")
    try:
        from insightface.app import FaceAnalysis

        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(640, 640))
        print("   ok: buffalo_l ready (~/.insightface)\n")
    except Exception as exc:  # noqa: BLE001 — insightface optional; note and continue
        print(f"   skipped: insightface not installed — `uv sync` to enable ({exc})\n")

    print("Done.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch ScriptReel models from Hugging Face.")
    parser.add_argument(
        "--no-flux",
        action="store_true",
        help="Skip the ~6.5 GB FLUX model (only needed for Phase 13).",
    )
    parser.add_argument(
        "--identity",
        action="store_true",
        help="Fetch only the reference-identity models (DINOv2 + InsightFace, doc 25 §5-C).",
    )
    parser.add_argument(
        "--vlm",
        action="store_true",
        help="Fetch only the VLM checklist model (Qwen2.5-VL-3B 4-bit, doc 25 §5-D).",
    )
    args = parser.parse_args()

    if args.identity:
        return _fetch_identity()
    if args.vlm:
        return _fetch_list(VLM_MODELS, "Fetching VLM checklist model (doc 25 §5-D)")

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub is not installed — run `uv sync` in services/ml first.", file=sys.stderr)
        return 1

    targets = list(MODELS)
    if not args.no_flux:
        targets.append(FLUX)

    print(f"HF_HOME = {os.environ.get('HF_HOME', '<default HF cache>')}")
    print(f"Fetching {len(targets)} model(s):\n")

    for repo_id, label, size, note in targets:
        suffix = f"  [{note}]" if note else ""
        print(f"-> {label} ({size}) — {repo_id}{suffix}")
        path = snapshot_download(repo_id=repo_id)
        print(f"   ok: {path}\n")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
