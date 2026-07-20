"""Health-narration samples at different pacing/tone settings, so you can pick the mature,
well-paced voice that fits a health audience.

Run:  cd services/voice && uv run python sample_health.py
Writes into services/voice/samples/ — open each and listen.

Chatterbox knobs used here:
- cfg_weight  : LOWER = slower, more deliberate pacing (better comprehension). 0.5 default.
- exaggeration: LOWER = calmer, more measured (mature). 0.5 default.
If you drop your own ~15s clip at samples/ref.wav, it clones THAT voice at the calm/slow setting.
"""

from __future__ import annotations

import time
from pathlib import Path

import soundfile as sf
import torch

HERE = Path(__file__).parent
OUT = HERE / "samples"
OUT.mkdir(exist_ok=True)

# A mature-audience health explainer — measured, reassuring register.
TEXT = (
    "As we grow older, our bodies change in ways we don't always notice. Blood pressure can "
    "creep up quietly. Bones slowly lose their density. But here is the encouraging part: small, "
    "consistent habits — a daily walk, a little more water, a little less salt — can make a "
    "remarkable difference to how you feel, and how well you age."
)

# (label, exaggeration, cfg_weight) — from slowest/calmest to default.
VARIANTS = [
    ("health_calm_slow", 0.35, 0.3),  # calm + deliberate — best for a health audience
    ("health_measured", 0.45, 0.4),  # balanced
    ("health_default", 0.5, 0.5),  # Chatterbox default pacing
]


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading Chatterbox on {device} (cached now)...")
    t0 = time.time()
    from chatterbox.tts import ChatterboxTTS

    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"  loaded in {time.time() - t0:.0f}s")

    ref = OUT / "ref.wav"
    ref_arg = {"audio_prompt_path": str(ref)} if ref.exists() else {}
    if ref.exists():
        print("  cloning YOUR samples/ref.wav")

    for label, exaggeration, cfg in VARIANTS:
        t0 = time.time()
        wav = model.generate(TEXT, exaggeration=exaggeration, cfg_weight=cfg, **ref_arg)
        dur = wav.shape[-1] / model.sr
        sf.write(OUT / f"{label}.wav", wav.squeeze(0).cpu().numpy(), model.sr)
        print(
            f"  {label}.wav — {dur:.1f}s audio (exaggeration={exaggeration}, cfg_weight={cfg}) "
            f"in {time.time() - t0:.0f}s"
        )

    print("\nDone. Listen to services/voice/samples/health_*.wav — lower cfg_weight = slower/clearer.")


if __name__ == "__main__":
    main()
