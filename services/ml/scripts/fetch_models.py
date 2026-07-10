"""Download and verify the models ScriptReel uses (doc 19 §5).

Usage:
    export HF_HOME="$PWD/data/models"
    uv run --directory services/ml python -m scripts.fetch_models [--no-flux]

Repo ids drift. If a download 404s, search Hugging Face for the current id and
update this list *and* doc 04 rather than pinning a fork.
"""

from __future__ import annotations

import argparse
import os
import sys

# (repo id, human label, approx size, note)
MODELS = [
    ("hexgrad/Kokoro-82M", "Kokoro-82M (TTS)", "~330 MB", ""),
    ("google/siglip2-base-patch16-224", "SigLIP 2 base (matching)", "~800 MB", ""),
    ("mlx-community/whisper-large-v3-turbo", "Whisper large-v3-turbo (alignment)", "~1.6 GB", ""),
    ("mlx-community/whisper-small-mlx", "Whisper small (alignment fallback)", "~480 MB", ""),
]
FLUX = (
    "dhairyashil/FLUX.1-schnell-mflux-4bit",
    "FLUX.1-schnell 4-bit",
    "~6.5 GB",
    "Phase 13 only",
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch ScriptReel models from Hugging Face.")
    parser.add_argument(
        "--no-flux",
        action="store_true",
        help="Skip the ~6.5 GB FLUX model (only needed for Phase 13).",
    )
    args = parser.parse_args()

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
