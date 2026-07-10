"""ScriptReel ML sidecar — Phase 0.

Exposes only ``/health`` and ``/warmup``. Model libraries are importable but never
loaded here; the weight-loading endpoints (``/tts``, ``/embed``, ``/align``,
``/textcard``) arrive in later phases behind the worker-side interfaces (doc 14).
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from app import models

app = FastAPI(title="ScriptReel ML Sidecar", version="0.0.0")


class HealthResponse(BaseModel):
    ok: bool
    device: str
    torch_available: bool


class WarmupResponse(BaseModel):
    ok: bool
    warmed: bool
    importable: dict[str, bool]
    note: str


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    device = models.device()
    return HealthResponse(ok=True, device=device, torch_available=device != "unavailable")


@app.post("/warmup", response_model=WarmupResponse)
def warmup() -> WarmupResponse:
    # Phase 0: prove the model libraries import, but do NOT load any weights.
    return WarmupResponse(
        ok=True,
        warmed=False,
        importable=models.check_importable(),
        note="Phase 0 — model libraries importable; weights not loaded.",
    )
