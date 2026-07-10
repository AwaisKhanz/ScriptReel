"""Forced alignment via mlx-whisper (doc 11 / doc 14).

We already know the exact script; whisper is used only to discover word timings,
which the worker maps onto the known tokens. Wrong whisper words don't matter —
wrong timings do. The script text is NOT passed as a prompt (it biases timings).
"""

from __future__ import annotations

import asyncio
import os

_lock = asyncio.Lock()

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


class AlignError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_ALIGN"


def _whisper_language(language: str) -> str:
    return language.split("-")[0].lower()


def _transcribe(audio_path: str, language: str) -> list[dict]:
    import mlx_whisper

    model = os.environ.get("WHISPER_MODEL", DEFAULT_MODEL)
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=model,
        word_timestamps=True,
        language=_whisper_language(language),
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


async def align(audio_path: str, language: str, _text: str) -> list[dict]:
    async with _lock:
        try:
            return await asyncio.to_thread(_transcribe, audio_path, language)
        except Exception as exc:  # noqa: BLE001
            raise AlignError(f"whisper alignment failed: {exc}") from exc
