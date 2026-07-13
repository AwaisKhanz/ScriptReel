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
if platform.system() == "Windows":
    # Windows blocks symlinks without admin / Developer Mode (WinError 1314); tell
    # huggingface_hub to COPY blobs into snapshots instead. A little more disk, always works.
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

from fastapi import Body, FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from app import align, dino, embed, face, models, ocr, textcard, tts, vlm  # noqa: E402

app = FastAPI(title="ScriptReel ML Sidecar", version="0.1.0")


@app.exception_handler(tts.TtsError)
async def _tts_error_handler(_request: Request, exc: tts.TtsError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(align.AlignError)
async def _align_error_handler(_request: Request, exc: align.AlignError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(embed.EmbedError)
async def _embed_error_handler(_request: Request, exc: embed.EmbedError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(textcard.TextcardError)
async def _textcard_error_handler(_request: Request, exc: textcard.TextcardError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(ocr.OcrError)
async def _ocr_error_handler(_request: Request, exc: ocr.OcrError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(face.FaceError)
async def _face_error_handler(_request: Request, exc: face.FaceError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(dino.DinoError)
async def _dino_error_handler(_request: Request, exc: dino.DinoError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(vlm.VlmError)
async def _vlm_error_handler(_request: Request, exc: vlm.VlmError) -> JSONResponse:
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
        models={
            "kokoro": "loaded" if loaded else "cold",
            "siglip": "loaded" if embed.is_loaded() else "cold",
            "ocr": "ready" if ocr.available() else "cold",
            "insightface": "ready" if face.available() else "cold",
            "dinov2": "ready" if dino.available() else "cold",
            "vlm": "ready" if vlm.available() else "cold",
        },
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


class WordTiming(BaseModel):
    word: str
    start: float
    end: float


class AlignRequest(BaseModel):
    audioPath: str
    language: str
    text: str = ""


class AlignResponse(BaseModel):
    words: list[WordTiming]


@app.post("/align", response_model=AlignResponse)
async def align_endpoint(req: AlignRequest) -> AlignResponse:
    words = await align.align(req.audioPath, req.language, req.text)
    return AlignResponse(words=[WordTiming(**w) for w in words])


class EmbedTextRequest(BaseModel):
    texts: list[str]


class EmbedTextResponse(BaseModel):
    vectors: list[list[float]]
    dim: int


class EmbedImageRequest(BaseModel):
    paths: list[str]


class EmbedImageResponse(BaseModel):
    vectors: list[list[float]]
    dim: int
    failed: list[str]


@app.post("/embed/text", response_model=EmbedTextResponse)
async def embed_text_endpoint(req: EmbedTextRequest) -> EmbedTextResponse:
    vectors, dim = await embed.embed_texts(req.texts)
    return EmbedTextResponse(vectors=vectors, dim=dim)


@app.post("/embed/image", response_model=EmbedImageResponse)
async def embed_image_endpoint(req: EmbedImageRequest) -> EmbedImageResponse:
    vectors, dim, failed = await embed.embed_images(req.paths)
    return EmbedImageResponse(vectors=vectors, dim=dim, failed=failed)


class TextcardRequest(BaseModel):
    phrase: str
    emotion: str = "neutral"
    aspect: str = "16:9"
    theme: str = "neutral"
    outPath: str


class TextcardResponse(BaseModel):
    path: str


@app.post("/textcard", response_model=TextcardResponse)
def textcard_endpoint(req: TextcardRequest) -> TextcardResponse:
    path = textcard.render(req.phrase, req.emotion, req.aspect, req.theme, req.outPath)
    return TextcardResponse(path=path)


class OcrRequest(BaseModel):
    paths: list[str]


class OcrItem(BaseModel):
    path: str
    text: str
    coverage: float
    wordCount: int


class OcrResponse(BaseModel):
    results: list[OcrItem]
    failed: list[str]


@app.post("/ocr", response_model=OcrResponse)
async def ocr_endpoint(req: OcrRequest) -> OcrResponse:
    results, failed = await ocr.run_ocr(req.paths)
    return OcrResponse(results=[OcrItem(**r) for r in results], failed=failed)


# Reference-identity cascade (doc 25 §5-C). /face/embed (InsightFace, person identity)
# and /dino/embed (DINOv2, landmark/artwork identity) share the /embed/image response
# shape: vectors[i] aligns with paths[i] (a zero row for a failed path), failed lists
# paths with no usable embedding. A missing model raises E_FACE/E_DINO (500) → the
# worker skips the identity pass (invariant 7).
class FaceEmbedRequest(BaseModel):
    paths: list[str]


class DinoEmbedRequest(BaseModel):
    paths: list[str]


class EmbedVectorsResponse(BaseModel):
    vectors: list[list[float]]
    dim: int
    failed: list[str]


@app.post("/face/embed", response_model=EmbedVectorsResponse)
async def face_embed_endpoint(req: FaceEmbedRequest) -> EmbedVectorsResponse:
    vectors, dim, failed = await face.embed_faces(req.paths)
    return EmbedVectorsResponse(vectors=vectors, dim=dim, failed=failed)


@app.post("/dino/embed", response_model=EmbedVectorsResponse)
async def dino_embed_endpoint(req: DinoEmbedRequest) -> EmbedVectorsResponse:
    vectors, dim, failed = await dino.embed_images(req.paths)
    return EmbedVectorsResponse(vectors=vectors, dim=dim, failed=failed)


# VLM checklist cascade (doc 25 §5-D). Qwen2.5-VL judges each item's image against the
# beat's description + era, returning four bools per readable image; unreadable / unparsed
# images land in `failed`. A missing model raises E_VLM (500) → the worker skips the whole
# VLM pass and selection is unchanged (invariant 7).
class VlmItem(BaseModel):
    path: str
    description: str
    era: str


class VlmRequest(BaseModel):
    items: list[VlmItem]


class VlmResultItem(BaseModel):
    path: str
    subjectPresent: bool
    shotTypeMatches: bool
    eraMatches: bool
    contradictingText: bool


class VlmResponse(BaseModel):
    results: list[VlmResultItem]
    failed: list[str]


@app.post("/vlm", response_model=VlmResponse)
async def vlm_endpoint(req: VlmRequest) -> VlmResponse:
    results, failed = await vlm.run_vlm([item.model_dump() for item in req.items])
    return VlmResponse(results=[VlmResultItem(**r) for r in results], failed=failed)
