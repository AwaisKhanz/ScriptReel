"""Caption the eval fixture with Florence-2 — the §3.9 experiment, NOT production code.

The redesign's §3.9 wants a second, structurally different ranker fused with the SigLIP one: embed
Florence-2's detailed caption and compare it to the beat's visualDescription, catching the
compositional relations a CLIP-family encoder misses (it is near bag-of-words on relations).

Every Phase 1 lever measured as a null, so this one gets MEASURED BEFORE it is built into the
pipeline. That is what this script is for: caption fixtures/eval/labels.jsonl once, dump the text,
and let `pnpm eval:matching` score the caption axis and paired-bootstrap it against sim. Nothing
here touches the pipeline; if the axis proves out, THEN it earns a sidecar endpoint.

Florence-2 on transformers 4.57 needs two workarounds, both load-bearing:
  attn_implementation='eager' — its remote code predates the _supports_sdpa probe.
  use_cache=False             — its prepare_inputs_for_generation assumes the OLD tuple-shaped
                                past_key_values and dies on the Cache refactor
                                (`past_key_values[0][0].shape` → NoneType).
use_cache=False disables KV caching, so decoding is O(n^2) — tolerable for a 222-image experiment,
but it is exactly why the plan's "Florence-2 batches well" claim should not be trusted for
production without pinning an older transformers.

Run: cd services/ml && uv run python -m scripts.caption_fixture
Idempotent — existing captions are kept, so a re-run only fills gaps.
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

MODEL_ID = "microsoft/Florence-2-large"
TASK = "<MORE_DETAILED_CAPTION>"
LABELS = _REPO_ROOT / "fixtures" / "eval" / "labels.jsonl"
OUT = _REPO_ROOT / "fixtures" / "eval" / ".captions.json"
MAX_NEW_TOKENS = 80


def load_thumbs() -> list[str]:
    seen: list[str] = []
    for line in LABELS.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("//"):
            continue
        p = json.loads(s)["thumbPath"]
        if p not in seen:
            seen.append(p)
    return seen


def main() -> int:
    import torch
    from PIL import Image
    from transformers import AutoModelForCausalLM, AutoProcessor

    done: dict[str, str] = {}
    if OUT.is_file():
        try:
            done = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt cache just means re-caption
            done = {}

    thumbs = load_thumbs()
    todo = [t for t in thumbs if t not in done]
    print(f"thumbs {len(thumbs)} · cached {len(thumbs) - len(todo)} · to caption {len(todo)}")
    if not todo:
        print("nothing to do.")
        return 0

    model = (
        AutoModelForCausalLM.from_pretrained(
            MODEL_ID, trust_remote_code=True, torch_dtype=torch.float16, attn_implementation="eager"
        )
        .to("cuda" if torch.cuda.is_available() else "cpu")
        .eval()
    )
    proc = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Florence-2 loaded on {device}")

    for i, rel in enumerate(todo, 1):
        path = _REPO_ROOT / rel
        try:
            img = Image.open(path).convert("RGB")
            inp = proc(text=TASK, images=img, return_tensors="pt").to(device, torch.float16)
            with torch.no_grad():
                ids = model.generate(
                    input_ids=inp["input_ids"],
                    pixel_values=inp["pixel_values"],
                    max_new_tokens=MAX_NEW_TOKENS,
                    num_beams=1,
                    do_sample=False,
                    use_cache=False,  # see module docstring — required on transformers 4.57
                )
            done[rel] = proc.batch_decode(ids, skip_special_tokens=True)[0].strip()
        except Exception as exc:  # noqa: BLE001 — one bad image must not lose the whole run
            print(f"  FAIL {rel}: {type(exc).__name__}: {exc}")
            continue
        if i % 10 == 0 or i == len(todo):
            OUT.write_text(json.dumps(done, indent=0), encoding="utf-8")  # checkpoint
            print(f"  {i}/{len(todo)}")

    OUT.write_text(json.dumps(done, indent=0), encoding="utf-8")
    print(f"\nwrote {len(done)} captions → {OUT.relative_to(_REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
