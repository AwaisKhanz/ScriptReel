"""Score the §3.9 caption axis: cos(bge(beat.visualDescription), bge(florence2_caption)).

Second half of the §3.9 experiment (`caption_fixture.py` writes the captions). Emits one similarity
per (beat, thumbPath) so `pnpm eval:matching` can treat it as an extra axis and reuse the AUC /
paired-bootstrap machinery that already exists there — rather than reimplementing statistics in a
second language and risking two subtly different answers to the same question.

Why a separate text encoder: SigLIP's text tower is trained for text<->IMAGE alignment, so using it
to compare two sentences measures something it was never fit for. A null there would be
uninterpretable — encoder weakness or a dead hypothesis, no way to tell. BGE is trained for exactly
this (symmetric short-text similarity), so a null here is evidence ABOUT §3.9.

Deliberately NOT a sidecar endpoint: every Phase 1 lever measured null, so nothing enters the
pipeline before the fixture says it earns its place. If this axis wins, it earns /embed/doc.

Run (after caption_fixture.py): cd services/ml && uv run python -m scripts.caption_sim
"""

from __future__ import annotations

import json
import os
import platform
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))
if platform.system() == "Windows":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# bge-base over bge-small: this run has to be able to FALSIFY §3.9, and a null caused by a weak
# 33M encoder would not distinguish "captions don't help" from "the encoder couldn't read them".
MODEL_ID = "BAAI/bge-base-en-v1.5"
LABELS = _REPO_ROOT / "fixtures" / "eval" / "labels.jsonl"
CAPTIONS = _REPO_ROOT / "fixtures" / "eval" / ".captions.json"
OUT = _REPO_ROOT / "fixtures" / "eval" / ".caption-sim.json"


def main() -> int:
    import torch
    from transformers import AutoModel, AutoTokenizer

    if not CAPTIONS.is_file():
        print(f"missing {CAPTIONS} — run `python -m scripts.caption_fixture` first")
        return 1
    captions: dict[str, str] = json.loads(CAPTIONS.read_text(encoding="utf-8"))

    rows = [
        json.loads(s)
        for s in (x.strip() for x in LABELS.read_text(encoding="utf-8").splitlines())
        if s and not s.startswith("//")
    ]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModel.from_pretrained(MODEL_ID).to(device).eval()
    print(f"{MODEL_ID} on {device}")

    def embed(texts: list[str]) -> torch.Tensor:
        out: list[torch.Tensor] = []
        for i in range(0, len(texts), 32):
            batch = texts[i : i + 32]
            enc = tok(batch, padding=True, truncation=True, max_length=512, return_tensors="pt").to(
                device
            )
            with torch.no_grad():
                # BGE pools the CLS token, then L2-normalises — its documented recipe.
                h = model(**enc).last_hidden_state[:, 0]
            out.append(torch.nn.functional.normalize(h, p=2, dim=1).cpu())
        return torch.cat(out)

    # No "Represent this sentence..." query prefix: that instruction is for asymmetric
    # short-query -> long-passage retrieval. Here both sides are short descriptive sentences, so the
    # symmetric (bare) form is the matched setting.
    descs = sorted({r["beatDescription"] for r in rows})
    caps = sorted({c for c in captions.values() if c})
    demb = dict(zip(descs, embed(descs), strict=True))
    cemb = dict(zip(caps, embed(caps), strict=True))

    sims: dict[str, float] = {}
    missing = 0
    for r in rows:
        cap = captions.get(r["thumbPath"])
        if not cap:
            missing += 1
            continue
        sims[f"{r['beat']}|{r['thumbPath']}"] = float(demb[r["beatDescription"]] @ cemb[cap])

    OUT.write_text(json.dumps(sims, indent=0), encoding="utf-8")
    # Plain ASCII: the Windows console is cp1252 and raises UnicodeEncodeError on arrows.
    print(f"wrote {len(sims)} caption sims ({missing} pairs had no caption) -> {OUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
