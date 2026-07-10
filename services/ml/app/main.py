"""ScriptReel ML sidecar (doc 14).

Phase 0: /health + /warmup. Phase 3 adds Kokoro /tts. Stateless; only touches
paths under DATA_DIR / assets that the worker passes as absolute paths.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path

# HF_HOME → DATA_DIR/models (doc 14), set before any model library is imported.
_REPO_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("HF_HOME", str(_REPO_ROOT / "data" / "models"))

from fastapi import Body, FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from app import models, tts  # noqa: E402

app = FastAPI(title="ScriptReel ML Sidecar", version="0.1.0")


@app.exception_handler(tts.TtsError)
async def _tts_error_handler(_request: Request, exc: tts.TtsError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


class HealthResponse(BaseModel):
    ok: bool
    device: str
    models: dict[str, str]
    versions: dict[str, str]


class WarmupRequest(BaseModel):
    langs: list[str] = []


class WarmupResponse(BaseModel):
    ok: bool
    warmedLangs: list[str]
    importable: dict[str, bool]


class TtsRequest(BaseModel):
    text: str
    voice: str
    langCode: str
    speed: float = 1.0
    outPath: str


class TtsResponse(BaseModel):
    path: str
    durationSec: float


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    device = models.device()
    loaded = tts.loaded_langs()
    return HealthResponse(
        ok=True,
        device=device,
        models={"kokoro": "loaded" if loaded else "cold"},
        versions={"python": platform.python_version(), "hf_home": os.environ.get("HF_HOME", "")},
    )


@app.post("/warmup", response_model=WarmupResponse)
async def warmup(req: WarmupRequest = Body(default=WarmupRequest())) -> WarmupResponse:
    for lang in req.langs:
        await tts.warm(lang)
    return WarmupResponse(ok=True, warmedLangs=tts.loaded_langs(), importable=models.check_importable())


@app.post("/tts", response_model=TtsResponse)
async def tts_endpoint(req: TtsRequest) -> TtsResponse:
    duration = await tts.synthesize(req.text, req.voice, req.langCode, req.speed, req.outPath)
    return TtsResponse(path=req.outPath, durationSec=duration)
