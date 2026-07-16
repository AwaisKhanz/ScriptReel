"""GPU smoke test — run this FIRST on any new machine (redesign plan, Phase 0).

Blackwell (RTX 50-series, sm_120) is newer than a lot of the ML ecosystem's pinned wheels, and
each of these three fails in a way that costs a day to diagnose:

  1. torch          — a pre-cu128 wheel has no sm_120 kernels ("sm_120 is not compatible ...").
  2. CTranslate2    — faster-whisper's INT8 path is unsupported on sm_120 (CUBLAS_STATUS_NOT_SUPPORTED);
                      float16 works. align.py defaults to int8, so this decides FASTER_WHISPER_COMPUTE.
  3. onnxruntime    — pins its own CUDA; if CUDAExecutionProvider is absent it silently runs on CPU,
                      making the InsightFace identity gate ~20x slower WITHOUT ever erroring.

Run:  cd services/ml && uv run python -m scripts.smoke_gpu
Exit code is 0 even on failures — this reports, it doesn't gate. Read the VERDICT lines.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path

# Same HF_HOME as the sidecar (app/main.py) so we probe the models actually on disk.
_REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))
if platform.system() == "Windows":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

WHISPER_MODEL = os.environ.get("FASTER_WHISPER_MODEL", "Systran/faster-whisper-base")


def check_torch() -> None:
    print("=== 1. torch / CUDA ===")
    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        print(f"  VERDICT: FAIL — torch not importable: {exc}")
        return
    print(f"  torch={torch.__version__}  cuda_build={torch.version.cuda}")
    if not torch.cuda.is_available():
        print("  VERDICT: FAIL — torch.cuda.is_available() is False (CPU-only wheel or no driver)")
        return
    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    sm = f"sm_{cap[0]}{cap[1]}"
    print(f"  device={name}  capability={cap} ({sm})")
    try:  # a real kernel launch — is_available() alone does NOT prove sm_120 kernels exist
        a = torch.randn(2048, 2048, device="cuda", dtype=torch.float16)
        b = (a @ a).sum().item()
        torch.cuda.synchronize()
        print(f"  fp16 matmul on GPU: OK (checksum finite={b == b})")
        print(f"  VERDICT: PASS — torch computes on {sm}")
    except Exception as exc:  # noqa: BLE001
        print(f"  fp16 matmul FAILED: {type(exc).__name__}: {str(exc)[:160]}")
        print(f"  VERDICT: FAIL — torch sees the GPU but has no working kernels for {sm}")


def check_onnxruntime() -> None:
    print("\n=== 2. onnxruntime (InsightFace identity gate) ===")
    try:
        import onnxruntime as ort
    except Exception as exc:  # noqa: BLE001
        print(f"  VERDICT: SKIP — onnxruntime not importable: {exc}")
        return
    providers = ort.get_available_providers()
    print(f"  onnxruntime={ort.__version__}")
    print(f"  available_providers={providers}")
    if "CUDAExecutionProvider" in providers:
        print("  VERDICT: PASS — CUDA provider available (gate B can use the GPU)")
    else:
        print("  VERDICT: CPU-ONLY — no CUDAExecutionProvider.")
        print("    The identity gate runs on CPU (~20x slower) and never errors about it.")
        print("    Note: app/face.py currently PINS CPUExecutionProvider anyway (see report).")


def _tone_wav() -> str:
    """A 1s 16k mono wav in a temp file — just enough audio to force a real decode."""
    import math
    import struct
    import tempfile
    import wave

    path = Path(tempfile.gettempdir()) / "scriptreel_smoke_tone.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        frames = b"".join(
            struct.pack("<h", int(3000 * math.sin(2 * math.pi * 220 * (i / 16000))))
            for i in range(16000)
        )
        w.writeframes(frames)
    return str(path)


def check_ctranslate2() -> None:
    print("\n=== 3. CTranslate2 / faster-whisper (align stage) ===")
    try:
        import ctranslate2
    except Exception as exc:  # noqa: BLE001
        print(f"  VERDICT: SKIP — ctranslate2 not importable: {exc}")
        return
    print(f"  ctranslate2={ctranslate2.__version__}")
    try:
        n = ctranslate2.get_cuda_device_count()
        print(f"  ct2 cuda_device_count={n}")
    except Exception as exc:  # noqa: BLE001
        print(f"  ct2 cuda_device_count failed: {exc}")
        n = 0
    if n == 0:
        print("  VERDICT: CPU-ONLY — CT2 sees no CUDA device; keep FASTER_WHISPER_DEVICE=cpu")
        return
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(f"  VERDICT: SKIP — faster_whisper not importable: {exc}")
        return
    wav = _tone_wav()  # loading a model proves nothing — cuBLAS is only called at inference
    results: dict[str, str] = {}
    for compute in ("int8", "float16"):
        try:
            model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type=compute)
            segments, _ = model.transcribe(wav, language="en", beam_size=1)
            list(segments)  # generator — force the actual decode
            del model
            results[compute] = "OK"
            print(f"  cuda/{compute:8s}: OK (loaded AND transcribed)")
        except Exception as exc:  # noqa: BLE001
            results[compute] = f"{type(exc).__name__}: {str(exc)[:110]}"
            print(f"  cuda/{compute:8s}: FAILED — {results[compute]}")
    if results.get("float16") == "OK":
        rec = "float16" if results.get("int8") != "OK" else "int8 or float16"
        print(f"  VERDICT: PASS — set FASTER_WHISPER_DEVICE=cuda FASTER_WHISPER_COMPUTE={rec}")
    elif results.get("int8") == "OK":
        print("  VERDICT: PARTIAL — int8 works, float16 does not (unexpected on sm_120)")
    else:
        print("  VERDICT: FAIL — no CUDA compute type loads; set FASTER_WHISPER_DEVICE=cpu")


def main() -> int:
    print(f"HF_HOME={os.environ['HF_HOME']}")
    print(f"platform={platform.system()} {platform.machine()}\n")
    check_torch()
    check_onnxruntime()
    check_ctranslate2()
    print("\nDone. Read the VERDICT lines above before writing pipeline code.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
