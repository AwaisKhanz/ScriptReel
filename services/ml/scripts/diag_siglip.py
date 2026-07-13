"""Standalone SigLIP load diagnostic (NOT part of the app). Windows meta-tensor triage.

    uv run --directory services/ml python -m scripts.diag_siglip

Loads SigLIP SINGLE-THREADED, outside the FastAPI server, three ways. This tells us whether the
"Cannot copy out of meta tensor" failure is the transformers concurrent-load bug (#41782 — then
all three succeed here and the fix is in the app's load path) or a torch-build issue (then they
fail here too and the fix is a pin / manual materialization). Delete after triage.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO / "data" / "models"))
if sys.platform == "win32":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import torch  # noqa: E402
import transformers  # noqa: E402
from transformers import AutoModel  # noqa: E402

MODEL = os.environ.get("SIGLIP_MODEL", "google/siglip2-base-patch16-224")


def check(label: str, **kwargs: object) -> None:
    try:
        model = AutoModel.from_pretrained(MODEL, **kwargs)
        meta = [n for n, p in model.named_parameters() if p.is_meta]
        print(f"[{label}] loaded — meta params: {len(meta)} {meta[:3]}")
        model.to("cpu")
        print(f"[{label}] .to('cpu') OK ✓")
    except Exception as exc:  # noqa: BLE001 — diagnostic: report and continue to the next mode
        print(f"[{label}] FAILED: {type(exc).__name__}: {str(exc)[:160]}")


def main() -> int:
    print(f"torch {torch.__version__} | transformers {transformers.__version__} | {sys.platform}")
    print(f"HF_HOME={os.environ.get('HF_HOME')}\n")
    check("A: low_cpu_mem_usage=False", low_cpu_mem_usage=False)
    check("B: plain from_pretrained")
    check("C: device_map cpu", device_map={"": "cpu"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
