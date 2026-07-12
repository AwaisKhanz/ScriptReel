"""FLUX.1-schnell image generation CLI (doc 25 §5-E). Run as `python -m gen ...`.

Three modes:
  --check      availability probe: mflux importable AND the FLUX repo present in the local
               HF cache — WITHOUT downloading or generating. Exit 0 ready, 1 not.
  --download   fetch the pre-quantized FLUX.1-schnell 4-bit model (~6.5 GB) into HF_HOME.
  (default)    generate ONE image from --prompt to --out (PNG).

Degrade-never-die (invariant 7): every failure prints to stderr and exits non-zero — never
hangs — so the worker's generateImage() returns null and the fallback ladder drops through
to the text card. The generator is optional; nothing here runs until `make gen-setup &&
make fetch-gen`.
"""

from __future__ import annotations

import argparse
import os
import sys

# Pre-quantized mflux model that `make fetch-gen` downloads. Loading this (vs.
# `from_name("schnell", quantize=4)`, which pulls the full ~24 GB schnell and quantizes on
# the fly) keeps the footprint at ~6.5 GB. base_model tells mflux which architecture the
# community weights follow (doc 25 §5-E).
FLUX_REPO = "dhairyashil/FLUX.1-schnell-mflux-4bit"
BASE_MODEL = "schnell"
_ALIGN = 16  # FLUX latents are an 8× VAE downsample then 2×2 patchify → dims must be ÷16
_MIN_DIM = 256


def _round16(value: int) -> int:
    """Round a dimension to the nearest multiple of 16 (FLUX requirement), floored at 256."""
    rounded = int(round(value / _ALIGN)) * _ALIGN
    return max(_MIN_DIM, rounded)


def check() -> int:
    """Probe availability without downloading or generating. Exit 0 iff mflux imports AND
    the FLUX model is fully present in the local HF cache."""
    try:
        import mflux  # noqa: F401
        from mflux.models.flux.variants.txt2img.flux import Flux1  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — any import failure ⇒ not ready
        print(f"gen: mflux not importable ({exc}) — run `make gen-setup`", file=sys.stderr)
        return 1
    try:
        from huggingface_hub import snapshot_download

        # local_files_only ⇒ raises if the snapshot isn't fully cached; never hits the network.
        snapshot_download(repo_id=FLUX_REPO, local_files_only=True)
    except Exception as exc:  # noqa: BLE001 — not cached / unreadable ⇒ not ready
        print(f"gen: FLUX model not in cache ({exc}) — run `make fetch-gen`", file=sys.stderr)
        return 1
    print("OK gen ready")
    return 0


def download() -> int:
    """Download the pre-quantized FLUX.1-schnell 4-bit model (~6.5 GB) into HF_HOME."""
    try:
        from huggingface_hub import snapshot_download

        print(f"Downloading {FLUX_REPO} (~6.5 GB) → {os.environ.get('HF_HOME', '<default>')}")
        path = snapshot_download(repo_id=FLUX_REPO)
        print(f"OK {path}")
        return 0
    except Exception as exc:  # noqa: BLE001 — surface as a clean non-zero exit
        print(f"gen: download failed ({exc})", file=sys.stderr)
        return 1


def generate(prompt: str, width: int, height: int, steps: int, seed: int, out: str) -> int:
    """Generate one image and save it to `out` as PNG. Any failure is a clean non-zero exit
    (never a hang) so the caller degrades to the text card."""
    try:
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux.variants.txt2img.flux import Flux1

        w, h = _round16(width), _round16(height)
        # quantize=None: the community weights are ALREADY 4-bit; mflux reads the bit-width
        # from the saved model, so we must not re-quantize.
        flux = Flux1(
            model_config=ModelConfig.from_name(model_name=FLUX_REPO, base_model=BASE_MODEL),
            quantize=None,
        )
        image = flux.generate_image(
            seed=seed,
            prompt=prompt,
            num_inference_steps=steps,
            width=w,
            height=h,
        )
        image.save(path=out, overwrite=True)
    except Exception as exc:  # noqa: BLE001 — never propagate a traceback / hang the worker
        print(f"gen: generation failed ({exc})", file=sys.stderr)
        return 1
    print(f"OK {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="gen",
        description="ScriptReel FLUX.1-schnell generative fallback (doc 25 §5-E).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Probe: mflux importable + FLUX model cached (no download/generate). Exit 0/1.",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download FLUX.1-schnell 4-bit (~6.5 GB) into HF_HOME.",
    )
    parser.add_argument("--prompt", type=str, default="", help="Text prompt to generate from.")
    parser.add_argument("--width", type=int, default=1024, help="Image width (rounded to ÷16).")
    parser.add_argument("--height", type=int, default=1024, help="Image height (rounded to ÷16).")
    parser.add_argument("--steps", type=int, default=4, help="Inference steps (schnell: ~4).")
    parser.add_argument("--seed", type=int, default=0, help="Deterministic seed.")
    parser.add_argument("--out", type=str, default="", help="Output PNG path.")
    args = parser.parse_args()

    if args.check:
        return check()
    if args.download:
        return download()
    if not args.prompt or not args.out:
        print("gen: generate mode requires --prompt and --out", file=sys.stderr)
        return 1
    return generate(args.prompt, args.width, args.height, args.steps, args.seed, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
