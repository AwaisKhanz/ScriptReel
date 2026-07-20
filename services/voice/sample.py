"""Generate Chatterbox TTS samples so you can HEAR the voice before wiring it into the pipeline.

Run:  cd services/voice && uv run python sample.py
Writes WAVs into services/voice/samples/ — open them and listen.

- Default voice: no reference clip needed (Chatterbox's built-in voice).
- Cloned voice: drop a clean ~10-20s WAV of the voice you want at samples/ref.wav and it clones it.

This does NOT touch the running sidecar or the pipeline — it's a standalone check.
"""

from __future__ import annotations

import time
from pathlib import Path

import soundfile as sf
import torch

HERE = Path(__file__).parent
OUT = HERE / "samples"
OUT.mkdir(exist_ok=True)

# A realistic documentary sentence — the same register you narrate in.
TEXT = (
    "On September 5th, 1977, NASA launched Voyager 1. Decades later, from six billion "
    "kilometers away, it turned its camera back toward home and captured Earth as a single "
    "pale blue dot — a reminder of how small, and how precious, our world really is."
)


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading Chatterbox on {device} (first run downloads ~2GB)...")
    t0 = time.time()
    from chatterbox.tts import ChatterboxTTS

    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"  loaded in {time.time() - t0:.0f}s, sample rate {model.sr} Hz")

    # 1) Default built-in voice (no reference).
    t0 = time.time()
    wav = model.generate(TEXT)
    dur = wav.shape[-1] / model.sr
    sf.write(OUT / "sample_default.wav", wav.squeeze(0).cpu().numpy(), model.sr)
    print(f"  wrote sample_default.wav — {dur:.1f}s of audio in {time.time() - t0:.0f}s")

    # 2) Cloned voice, if a reference clip is present.
    ref = OUT / "ref.wav"
    if ref.exists():
        t0 = time.time()
        wav = model.generate(TEXT, audio_prompt_path=str(ref))
        sf.write(OUT / "sample_cloned.wav", wav.squeeze(0).cpu().numpy(), model.sr)
        print(f"  wrote sample_cloned.wav (cloned from ref.wav) in {time.time() - t0:.0f}s")
    else:
        print("  (no samples/ref.wav — skipped cloning. Drop a ~15s clip there to try a chosen voice.)")

    print("\nDone. Open the WAVs in services/voice/samples/ and listen.")


if __name__ == "__main__":
    main()
