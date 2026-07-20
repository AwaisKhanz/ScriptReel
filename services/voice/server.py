"""ScriptReel voice server — Chatterbox TTS (Resemble AI, MIT).

Speaks the SAME HTTP contract as the ML sidecar's /tts (doc 14) so the worker's tts stage can route
`engine: 'chatterbox'` voices here with no change to the narration-clock / alignment invariants:

    POST /tts  { text, voice, langCode?, speed?, outPath }  ->  { path, durationSec }

`voice` is a named voice id (usama/awais/noman/adeel); its reference clip is voices/<id>.wav. Output
is 24 kHz mono PCM_16 — identical to Kokoro — so beats concatenate and the drift assert holds. The
measured duration (len(samples)/24000) is the clock, never an estimate (invariant 2).

Lives in its own uv venv (see pyproject.toml): chatterbox-tts pins a torch build that conflicts with
the sidecar's, so it must not share that process. Loaded lazily and kept warm; a per-process lock
serialises generation (the worker calls with parallelism 2).
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

HERE = Path(__file__).parent
VOICES_DIR = HERE / "voices"
SAMPLE_RATE = 24_000  # must match the sidecar (services/ml/app/tts.py) so beat WAVs share one format

# Cache Chatterbox's model download alongside the sidecar's (DATA_DIR/models) — set before import.
_REPO_ROOT = HERE.parents[1]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))

# Calm, deliberate, mature register (the setting the owner picked for health narration):
# lower cfg_weight = slower/clearer pacing; lower exaggeration = calmer/steadier.
EXAGGERATION = 0.4
CFG_WEIGHT = 0.3

_VOICE_ID_RE = re.compile(r"^[a-z0-9_]+$")  # reject anything that could escape VOICES_DIR


class TtsError(Exception):
    def __init__(self, message: str, code: str = "E_TTS") -> None:
        super().__init__(message)
        self.code = code


class TtsRequest(BaseModel):
    text: str
    voice: str
    langCode: str = "a"
    speed: float = 1.0
    outPath: str


class TtsResponse(BaseModel):
    path: str
    durationSec: float


app = FastAPI(title="ScriptReel Voice Server", version="0.1.0")

_model: object | None = None
_model_lock = asyncio.Lock()  # guards the one-time load
_gen_lock = asyncio.Lock()  # serialises generation (Chatterbox generate isn't concurrency-safe)


async def _get_model() -> object:
    global _model
    if _model is None:
        async with _model_lock:
            if _model is None:
                device = "cuda" if torch.cuda.is_available() else "cpu"
                from chatterbox.tts import ChatterboxTTS

                _model = await asyncio.to_thread(ChatterboxTTS.from_pretrained, device=device)
    return _model


def _ref_for(voice: str) -> Path:
    if not _VOICE_ID_RE.match(voice):
        raise TtsError(f"invalid voice id {voice!r}", "E_TTS")
    ref = VOICES_DIR / f"{voice}.wav"
    if not ref.is_file():
        raise TtsError(f"unknown voice {voice!r} — no reference clip at voices/{voice}.wav")
    return ref


def _synthesize_sync(model: object, text: str, ref: Path) -> np.ndarray:
    wav = model.generate(  # type: ignore[attr-defined]
        text, audio_prompt_path=str(ref), exaggeration=EXAGGERATION, cfg_weight=CFG_WEIGHT
    )
    arr = wav.squeeze(0).detach().cpu()
    model_sr = int(getattr(model, "sr", SAMPLE_RATE))
    if model_sr != SAMPLE_RATE:
        import torchaudio

        arr = torchaudio.functional.resample(arr, model_sr, SAMPLE_RATE)
    out = np.asarray(arr.numpy(), dtype=np.float32).reshape(-1)
    if out.size == 0:
        raise TtsError("empty synthesis (no audio produced)")
    # Guard against NaN/inf clipping to silence downstream.
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)


@app.exception_handler(TtsError)
async def _tts_error_handler(_request: Request, exc: TtsError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "engine": "chatterbox",
        "modelLoaded": _model is not None,
        "cuda": torch.cuda.is_available(),
        "voices": sorted(p.stem for p in VOICES_DIR.glob("*.wav") if not p.stem.startswith("preview_")),
    }


@app.post("/warmup")
async def warmup() -> dict[str, str]:
    await _get_model()
    return {"status": "warm"}


@app.post("/tts", response_model=TtsResponse)
async def tts_endpoint(req: TtsRequest) -> TtsResponse:
    if not req.text.strip():
        raise TtsError("empty text")
    ref = _ref_for(req.voice)
    model = await _get_model()
    async with _gen_lock:
        audio = await asyncio.to_thread(_synthesize_sync, model, req.text, ref)
    out_path = Path(req.outPath)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 16-bit PCM so beat WAVs + the ffmpeg silence share one format (concat demuxer) — same as Kokoro.
    sf.write(str(out_path), audio, SAMPLE_RATE, subtype="PCM_16")
    return TtsResponse(path=str(out_path), durationSec=len(audio) / SAMPLE_RATE)
