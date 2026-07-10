"""Kokoro TTS (doc 10 / doc 14).

One ``KPipeline`` per language code, created lazily and kept warm for the process
lifetime. A per-pipeline asyncio lock serialises heavy synthesis while light ops
(health/warmup) still interleave. 24 kHz mono WAV out; the measured duration
(``len(samples)/24000``) is the narration clock.
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24_000

_pipelines: dict[str, object] = {}
_locks: dict[str, asyncio.Lock] = {}
_registry_lock = asyncio.Lock()


class TtsError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_TTS"


def _assert_unidic() -> None:
    if importlib.util.find_spec("unidic") is None and importlib.util.find_spec("unidic_lite") is None:
        raise TtsError("Japanese TTS needs unidic — run `make setup-ja` in services/ml")


async def _get_pipeline(lang_code: str) -> tuple[object, asyncio.Lock]:
    async with _registry_lock:
        if lang_code not in _pipelines:
            if lang_code == "j":
                _assert_unidic()
            from kokoro import KPipeline

            _pipelines[lang_code] = KPipeline(lang_code=lang_code)
            _locks[lang_code] = asyncio.Lock()
        return _pipelines[lang_code], _locks[lang_code]


def _synthesize_sync(pipeline: object, text: str, voice: str, speed: float) -> np.ndarray:
    chunks: list[np.ndarray] = []
    for item in pipeline(text, voice=voice, speed=speed):  # type: ignore[operator]
        audio = getattr(item, "audio", None)
        if audio is None and isinstance(item, (tuple, list)) and len(item) >= 3:
            audio = item[2]
        if audio is None:
            continue
        arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        chunks.append(np.asarray(arr, dtype=np.float32).reshape(-1))
    if not chunks:
        raise TtsError("empty synthesis (no audio produced)")
    return np.concatenate(chunks)


async def synthesize(text: str, voice: str, lang_code: str, speed: float, out_path: str) -> float:
    pipeline, lock = await _get_pipeline(lang_code)
    async with lock:
        audio = await asyncio.to_thread(_synthesize_sync, pipeline, text, voice, speed)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    # 16-bit PCM so all beat WAVs + the ffmpeg silence share one format (concat demuxer).
    sf.write(out_path, audio, SAMPLE_RATE, subtype="PCM_16")
    return len(audio) / SAMPLE_RATE


async def warm(lang_code: str) -> None:
    await _get_pipeline(lang_code)


def loaded_langs() -> list[str]:
    return sorted(_pipelines.keys())
