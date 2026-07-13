"""Generative-fallback image CLI (doc 25 §5-E). Run as `python -m gen ...`.

Dual backend, picked by platform:
  - Apple Silicon → FLUX.1-schnell 4-bit via **mflux** (MLX).
  - Windows / Linux (CUDA) → **SDXL-Turbo** via **diffusers** (torch-CUDA). Full FLUX is ~34 GB —
    it won't fit a 16 GB VRAM + 16 GB RAM box — so SDXL-Turbo (a ~6.5 GB, 1–4-step distilled SDXL)
    is the reliable generative fallback there. Override the model with GEN_MODEL.

Three modes (interface unchanged — the worker shells out exactly as before):
  --check      availability probe (backend importable + model cached), no download/generate.
  --download   fetch the backend's model into HF_HOME.
  (default)    generate ONE image from --prompt to --out (PNG).

Degrade-never-die (invariant 7): every failure prints to stderr and exits non-zero (never hangs),
so the worker's generateImage() returns null and the ladder drops through to the text card.
"""

from __future__ import annotations

import argparse
import os
import sys

_IS_APPLE = sys.platform == "darwin"

# --- Apple (mflux) --------------------------------------------------------------------------
# Pre-quantized 4-bit FLUX.1-schnell (~6.5 GB); loading this vs. quantizing the full ~24 GB
# schnell on the fly keeps the footprint small (doc 25 §5-E).
FLUX_REPO = "dhairyashil/FLUX.1-schnell-mflux-4bit"
BASE_MODEL = "schnell"

# --- Windows / Linux (diffusers) ------------------------------------------------------------
# SDXL-Turbo: 1–4-step distilled SDXL, ~6.5 GB, fits 16 GB VRAM. NON-COMMERCIAL license (Stability
# AI) — fine for dev; point GEN_MODEL at a permissively-licensed model before any commercial use.
SDXL_MODEL = os.environ.get("GEN_MODEL", "stabilityai/sdxl-turbo")
_SDXL_MAX_SIDE = 1024  # SDXL-Turbo is 512–1024-native; cap the long side (the image is panned anyway)
# Fetch ONLY the fp16 diffusers weights + configs (~6.5 GB). A bare snapshot_download pulls the
# WHOLE repo — fp32 weights, ~7 GB single-file checkpoints, and ONNX/OpenVINO exports (~55 GB for
# sdxl-turbo). from_pretrained(variant="fp16") needs exactly this subset.
_SDXL_ALLOW = ["*.json", "*/*.json", "*/*.txt", "*/*.fp16.safetensors"]

_MIN_DIM = 256


def _round_to(value: int, multiple: int, cap: int | None = None) -> int:
    """Round a dimension to a multiple (VAE alignment: 16 for FLUX, 8 for SDXL), floored at 256
    and optionally capped."""
    if cap is not None:
        value = min(value, cap)
    return max(_MIN_DIM, int(round(value / multiple)) * multiple)


# ── Apple / mflux backend ───────────────────────────────────────────────────────────────────
def _check_mflux() -> int:
    try:
        import mflux  # noqa: F401
        from mflux.models.flux.variants.txt2img.flux import Flux1  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — any import failure ⇒ not ready
        print(f"gen: mflux not importable ({exc}) — run `make gen-setup`", file=sys.stderr)
        return 1
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=FLUX_REPO, local_files_only=True)  # raises if not fully cached
    except Exception as exc:  # noqa: BLE001
        print(f"gen: FLUX model not in cache ({exc}) — run `make fetch-gen`", file=sys.stderr)
        return 1
    print("OK gen ready (mflux / FLUX.1-schnell)")
    return 0


def _download_mflux() -> int:
    from huggingface_hub import snapshot_download

    print(f"Downloading {FLUX_REPO} (~6.5 GB) → {os.environ.get('HF_HOME', '<default>')}")
    print(f"OK {snapshot_download(repo_id=FLUX_REPO)}")
    return 0


def _generate_mflux(prompt: str, width: int, height: int, steps: int, seed: int, out: str) -> int:
    from mflux.models.common.config import ModelConfig
    from mflux.models.flux.variants.txt2img.flux import Flux1

    w, h = _round_to(width, 16), _round_to(height, 16)
    # quantize=None: the community weights are ALREADY 4-bit; mflux reads the bit-width from them.
    flux = Flux1(
        model_config=ModelConfig.from_name(model_name=FLUX_REPO, base_model=BASE_MODEL),
        quantize=None,
    )
    image = flux.generate_image(
        seed=seed, prompt=prompt, num_inference_steps=steps, width=w, height=h
    )
    image.save(path=out, overwrite=True)
    print(f"OK {out}")
    return 0


# ── Windows / Linux / diffusers (SDXL-Turbo) backend ────────────────────────────────────────
def _check_diffusers() -> int:
    try:
        import diffusers  # noqa: F401
        import torch
    except Exception as exc:  # noqa: BLE001
        print(f"gen: diffusers/torch not importable ({exc}) — run `make gen-setup`", file=sys.stderr)
        return 1
    if not torch.cuda.is_available():
        # CPU SDXL is minutes per image — report not-ready so the ladder degrades to a text card
        # instead of hanging. Blackwell (RTX 50, sm_120) needs a CUDA-12.8 torch build (see SETUP).
        print(
            "gen: CUDA not available — image generation needs a CUDA GPU + cu128 torch",
            file=sys.stderr,
        )
        return 1
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=SDXL_MODEL, allow_patterns=_SDXL_ALLOW, local_files_only=True)
    except Exception as exc:  # noqa: BLE001
        print(f"gen: model {SDXL_MODEL} not in cache ({exc}) — run `make fetch-gen`", file=sys.stderr)
        return 1
    print(f"OK gen ready (diffusers / {SDXL_MODEL})")
    return 0


def _download_diffusers() -> int:
    from huggingface_hub import snapshot_download

    print(f"Downloading {SDXL_MODEL} (fp16 weights, ~6.5 GB) → {os.environ.get('HF_HOME', '<default>')}")
    print(f"OK {snapshot_download(repo_id=SDXL_MODEL, allow_patterns=_SDXL_ALLOW)}")
    return 0


def _generate_diffusers(
    prompt: str, width: int, height: int, steps: int, seed: int, out: str
) -> int:
    import torch
    from diffusers import AutoPipelineForText2Image

    w, h = _round_to(width, 8, cap=_SDXL_MAX_SIDE), _round_to(height, 8, cap=_SDXL_MAX_SIDE)
    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            SDXL_MODEL, torch_dtype=torch.float16, variant="fp16"
        )
    except Exception:  # noqa: BLE001 — model may not ship an fp16 variant; load default weights
        pipe = AutoPipelineForText2Image.from_pretrained(SDXL_MODEL, torch_dtype=torch.float16)
    # CPU offload keeps peak VRAM ~4 GB, so generation coexists with a resident Ollama model on a
    # 16 GB GPU without OOM. Slower than a full .to("cuda"), fine for a rare fallback.
    pipe.enable_model_cpu_offload()
    generator = torch.Generator(device="cpu").manual_seed(seed)
    # SDXL-Turbo uses NO classifier-free guidance (guidance_scale=0) and 1–4 steps.
    image = pipe(
        prompt=prompt,
        num_inference_steps=max(1, steps),
        guidance_scale=0.0,
        width=w,
        height=h,
        generator=generator,
    ).images[0]
    image.save(out)
    print(f"OK {out}")
    return 0


# ── Dispatch ────────────────────────────────────────────────────────────────────────────────
def check() -> int:
    return _check_mflux() if _IS_APPLE else _check_diffusers()


def download() -> int:
    try:
        return _download_mflux() if _IS_APPLE else _download_diffusers()
    except Exception as exc:  # noqa: BLE001 — surface as a clean non-zero exit
        print(f"gen: download failed ({exc})", file=sys.stderr)
        return 1


def generate(prompt: str, width: int, height: int, steps: int, seed: int, out: str) -> int:
    """Generate one image → `out` (PNG). Any failure is a clean non-zero exit (never a hang) so
    the caller degrades to the text card."""
    try:
        if _IS_APPLE:
            return _generate_mflux(prompt, width, height, steps, seed, out)
        return _generate_diffusers(prompt, width, height, steps, seed, out)
    except Exception as exc:  # noqa: BLE001 — never propagate a traceback / hang the worker
        print(f"gen: generation failed ({exc})", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="gen",
        description="ScriptReel generative fallback — FLUX (mflux/Apple) or SDXL-Turbo (CUDA).",
    )
    parser.add_argument("--check", action="store_true", help="Probe availability. Exit 0/1.")
    parser.add_argument("--download", action="store_true", help="Download the model into HF_HOME.")
    parser.add_argument("--prompt", type=str, default="", help="Text prompt to generate from.")
    parser.add_argument("--width", type=int, default=1024, help="Image width.")
    parser.add_argument("--height", type=int, default=1024, help="Image height.")
    parser.add_argument("--steps", type=int, default=4, help="Inference steps (schnell/turbo: ~4).")
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
