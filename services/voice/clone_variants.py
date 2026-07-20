"""Clone every samples/ref_N.wav on the health script at a calm, well-paced setting, so you can
compare mature voices and pick the perfect one.

Run:  cd services/voice && uv run python clone_variants.py
"""

from __future__ import annotations

import time
from pathlib import Path

import soundfile as sf
import torch

HERE = Path(__file__).parent
OUT = HERE / "samples"

TEXT = (
    "As we grow older, our bodies change in ways we don't always notice. Blood pressure can "
    "creep up quietly. Bones slowly lose their density. But here is the encouraging part: small, "
    "consistent habits — a daily walk, a little more water, a little less salt — can make a "
    "remarkable difference to how you feel, and how well you age."
)

# calm + deliberate (mature health register)
EXAGGERATION = 0.4
CFG_WEIGHT = 0.3


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading Chatterbox on {device}...")
    from chatterbox.tts import ChatterboxTTS

    model = ChatterboxTTS.from_pretrained(device=device)

    refs = sorted(OUT.glob("ref_*.wav"))
    if not refs:
        print("  no ref_*.wav found")
        return
    print(f"  cloning {len(refs)} reference voices at calm pacing...\n")
    for ref in refs:
        n = ref.stem.split("_")[-1]
        if (OUT / f"health_voice_{n}.wav").exists():
            print(f"  health_voice_{n}.wav — already done, skipping")
            continue
        try:
            t0 = time.time()
            wav = model.generate(
                TEXT, audio_prompt_path=str(ref), exaggeration=EXAGGERATION, cfg_weight=CFG_WEIGHT
            )
            dur = wav.shape[-1] / model.sr
            out = OUT / f"health_voice_{n}.wav"
            sf.write(out, wav.squeeze(0).cpu().numpy(), model.sr)
            print(f"  health_voice_{n}.wav — {dur:.1f}s (in {time.time() - t0:.0f}s)")
        except Exception as e:  # noqa: BLE001
            print(f"  voice {n} FAILED: {str(e)[:100]}")

    print("\nDone. Listen to services/voice/samples/health_voice_*.wav and pick your favorite.")


if __name__ == "__main__":
    main()
