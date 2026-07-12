"""Tesseract OCR — watermark / burned-in text detection (doc 25 §5, cascade A).

The score stage OCRs each beat's SigLIP top-5 shortlist to penalize watermarked
candidates and veto ones whose burned-in text contradicts the beat's era. Tesseract
is a subprocess, not a resident model — there's nothing to keep warm, so we only
cache a one-time availability probe. A missing binary raises ``OcrError`` (500) so
the worker can skip the whole gate and degrade cleanly (invariant 7); a single
unreadable image is reported in ``failed``, never fatal.

The per-word confidence floor ``_OCR_MIN_CONF`` mirrors ``OCR_MIN_CONF`` in
``packages/core/src/constants.ts`` so both sides agree on what counts as text.
"""

from __future__ import annotations

import asyncio
import logging

_log = logging.getLogger("scriptreel.ocr")

_OCR_MIN_CONF = 45  # mirrors OCR_MIN_CONF (packages/core/src/constants.ts, doc 25 §5)
_OCR_MAX_SIDE = 2048  # cap huge playground uploads before tesseract (pipeline thumbs are ~384)
_available: bool | None = None  # one-time availability probe cache


class OcrError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_OCR"


def available() -> bool:
    """True when the tesseract binary is importable and callable. Cached — the probe
    (an ``import`` + a version subprocess call) runs at most once per process."""
    global _available
    if _available is None:
        try:
            import pytesseract

            pytesseract.get_tesseract_version()
            _available = True
        except Exception:  # noqa: BLE001 — missing binary / import failure ⇒ unavailable
            _available = False
    return _available


def _coverage(boxes: list[tuple[int, int]], width: int, height: int) -> float:
    """Fraction of the image covered by the kept word boxes. Boxes can overlap; a
    clamp to [0, 1] is enough — we don't compute a true union (doc 25 §5)."""
    area = width * height
    if area <= 0:
        return 0.0
    covered = sum(w * h for w, h in boxes)
    return max(0.0, min(1.0, covered / area))


def _run_ocr_sync(paths: list[str]) -> tuple[list[dict], list[str]]:
    import pytesseract
    from PIL import Image
    from pytesseract import Output

    results: list[dict] = []
    failed: list[str] = []
    for path in paths:
        # Wrap the WHOLE per-image body: an unreadable image OR a tesseract failure (the
        # subprocess can fail to spawn under memory pressure in a long-running, model-loaded
        # sidecar) drops just this image to `failed` — never an unhandled 500 for the batch.
        try:
            from app.models import resize_to_max_side

            img = resize_to_max_side(Image.open(path).convert("RGB"), _OCR_MAX_SIDE)
            data = pytesseract.image_to_data(img, output_type=Output.DICT)
            words: list[str] = []
            boxes: list[tuple[int, int]] = []
            for i in range(len(data["text"])):
                text = str(data["text"][i]).strip()
                try:
                    conf = float(data["conf"][i])
                except (TypeError, ValueError):
                    conf = -1.0
                if not text or conf < _OCR_MIN_CONF:
                    continue
                words.append(text)
                boxes.append((int(data["width"][i]), int(data["height"][i])))
            results.append(
                {
                    "path": path,
                    "text": " ".join(words),
                    "coverage": _coverage(boxes, img.width, img.height),
                    "wordCount": len(words),
                }
            )
        except Exception:  # noqa: BLE001 — never let one image sink the whole /ocr call
            _log.warning("OCR failed for %s", path, exc_info=True)
            failed.append(path)
    return results, failed


async def run_ocr(paths: list[str]) -> tuple[list[dict], list[str]]:
    # Probe before threading — a missing binary is a 500 the worker catches, not work.
    if not available():
        raise OcrError("E_OCR_UNAVAILABLE: tesseract not installed — brew install tesseract")
    if not paths:
        return [], []
    return await asyncio.to_thread(_run_ocr_sync, paths)
