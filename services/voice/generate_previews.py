"""Render a short audition clip for each of the 4 named voices, at the calm/mature health register.
These double as (a) a sanity check that each reference clones cleanly and (b) the preview audio the
UI plays when the user picks a voice. Output: voices/preview_<id>.wav
"""

from __future__ import annotations

import time
from pathlib import Path

import soundfile as sf
import torch

HERE = Path(__file__).parent
VOICES = HERE / "voices"

# ~9 s health-narration audition line.
TEXT = (
    "As we grow older, our bodies change in ways we don't always notice — but small, consistent "
    "habits can make a remarkable difference to how you feel, and how well you age."
)
EXAGGERATION = 0.4  # calm / mature
CFG_WEIGHT = 0.3    # slower, deliberate pacing

IDS = ["usama", "awais", "noman", "adeel"]


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading Chatterbox on {device}...")
    from chatterbox.tts import ChatterboxTTS

    model = ChatterboxTTS.from_pretrained(device=device)
    for vid in IDS:
        ref = VOICES / f"{vid}.wav"
        if not ref.exists():
            print(f"  {vid}: MISSING ref, skipping")
            continue
        t0 = time.time()
        wav = model.generate(
            TEXT, audio_prompt_path=str(ref), exaggeration=EXAGGERATION, cfg_weight=CFG_WEIGHT
        )
        dur = wav.shape[-1] / model.sr
        sf.write(VOICES / f"preview_{vid}.wav", wav.squeeze(0).cpu().numpy(), model.sr)
        print(f"  preview_{vid}.wav — {dur:.1f}s (in {time.time() - t0:.0f}s)")
    print("\ndone — listen to voices/preview_*.wav")


if __name__ == "__main__":
    main()
