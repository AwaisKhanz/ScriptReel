"""Forced alignment (doc 11 / doc 14).

We already know the exact script; whisper is used only to discover word timings, which the
worker maps onto the known tokens. Wrong whisper words don't matter — wrong timings do. The
script text is NOT passed as a prompt (it biases timings).

Two backends, picked by availability (see pyproject platform markers):
  - Apple Silicon → **mlx-whisper** (MLX, fast).
  - Windows / Linux → **faster-whisper** (CTranslate2, cross-platform).
Both return the same ``[{word, start, end}]`` shape. If neither is installed, alignment fails
with ``E_ALIGN`` — a warning, not a render failure (invariant 7): subtitles fall back to
even word spacing.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os

from app.models import is_apple_silicon

_lock = asyncio.Lock()

# mlx-whisper default (Apple). faster-whisper uses its own default below (a different, CTranslate2
# model format) — both env-overridable so a machine can pick a smaller/larger model.
DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
DEFAULT_FASTER_MODEL = "Systran/faster-whisper-base"  # CTranslate2 repo `make models` fetches;
#                       alignment needs good TIMINGS, not transcription quality (base is plenty)


class AlignError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_ALIGN"


def _whisper_language(language: str) -> str:
    return language.split("-")[0].lower()


def _transcribe_mlx(audio_path: str, lang: str) -> list[dict]:
    """Apple-Silicon path — mlx-whisper."""
    import mlx_whisper

    model = os.environ.get("WHISPER_MODEL", DEFAULT_MODEL)
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=model,
        word_timestamps=True,
        language=lang,
        condition_on_previous_text=False,
    )
    words: list[dict] = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []):
            token = str(word.get("word", "")).strip()
            if not token:
                continue
            words.append({"word": token, "start": float(word["start"]), "end": float(word["end"])})
    return words


def _transcribe_faster(audio_path: str, lang: str) -> list[dict]:
    """Cross-platform path — faster-whisper (CTranslate2). CPU/int8 runs everywhere; the model
    auto-downloads to the HF cache on first use (or via `make models` on Windows)."""
    from faster_whisper import WhisperModel

    model_name = os.environ.get("FASTER_WHISPER_MODEL", DEFAULT_FASTER_MODEL)
    device = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
    compute = os.environ.get("FASTER_WHISPER_COMPUTE", "int8")
    model = WhisperModel(model_name, device=device, compute_type=compute)
    segments, _info = model.transcribe(
        audio_path,
        word_timestamps=True,
        language=lang,
        condition_on_previous_text=False,
    )
    words: list[dict] = []
    for segment in segments:
        for word in segment.words or []:
            token = str(word.word).strip()
            if not token:
                continue
            words.append({"word": token, "start": float(word.start), "end": float(word.end)})
    return words


def _transcribe(audio_path: str, language: str) -> list[dict]:
    lang = _whisper_language(language)
    # Prefer mlx-whisper on Apple Silicon (the only platform MLX loads on); else faster-whisper.
    # Gate on the PLATFORM, not just find_spec: a stale mlx_whisper left in a Windows venv is
    # "found" by find_spec yet crashes on import (native MLX DLL). See models.is_apple_silicon.
    if is_apple_silicon() and importlib.util.find_spec("mlx_whisper") is not None:
        return _transcribe_mlx(audio_path, lang)
    if importlib.util.find_spec("faster_whisper") is not None:
        return _transcribe_faster(audio_path, lang)
    raise RuntimeError("no whisper backend installed (mlx-whisper on Apple, faster-whisper elsewhere)")


async def align(audio_path: str, language: str, _text: str) -> list[dict]:
    async with _lock:
        try:
            return await asyncio.to_thread(_transcribe, audio_path, language)
        except Exception as exc:  # noqa: BLE001
            raise AlignError(f"whisper alignment failed: {exc}") from exc
