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
import os

_log = logging.getLogger("scriptreel.ocr")

_OCR_MIN_CONF = 45  # mirrors OCR_MIN_CONF (packages/core/src/constants.ts, doc 25 §5)
_OCR_MAX_SIDE = 2048  # cap huge playground uploads before tesseract (pipeline thumbs are ~384)
_available: bool | None = None  # one-time availability probe cache
_errors_patched = False


def _unmask_tesseract_errors() -> None:
    """pytesseract's ``get_errors`` strict-decodes tesseract's stderr as UTF-8 and CRASHES
    with a ``UnicodeDecodeError`` when it isn't valid UTF-8 — masking the REAL tesseract
    failure behind a confusing decode error. Patch it once to replace-decode, so the actual
    error surfaces in the logs instead of a masking crash. Best-effort + idempotent."""
    global _errors_patched
    if _errors_patched:
        return
    _errors_patched = True
    try:
        import pytesseract.pytesseract as pt

        original = pt.get_errors

        def safe_get_errors(error_string: object) -> list[str]:
            try:
                return original(error_string)
            except Exception:  # noqa: BLE001 — a bad decode must never hide the real error
                if isinstance(error_string, (bytes, bytearray)):
                    return bytes(error_string).decode("utf-8", "replace").splitlines()
                return [str(error_string)]

        pt.get_errors = safe_get_errors
    except Exception:  # noqa: BLE001 — patching is best-effort
        pass


class OcrError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_OCR"


def _configure_tesseract_cmd() -> None:
    """Point pytesseract at an explicit tesseract binary when TESSERACT_CMD is set. The Windows
    UB-Mannheim installer drops tesseract.exe under Program Files but frequently does NOT add it
    to PATH, so pytesseract's default ``"tesseract"`` lookup fails; setting TESSERACT_CMD to the
    full exe path fixes it without editing PATH. No-op when unset (relies on PATH, as on Unix)."""
    cmd = os.environ.get("TESSERACT_CMD")
    if not cmd:
        return
    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = cmd
    except Exception:  # noqa: BLE001 — an unimportable pytesseract is handled by available()
        pass


def available() -> bool:
    """True when the tesseract binary is importable and callable. Cached — the probe
    (an ``import`` + a version subprocess call) runs at most once per process."""
    global _available
    if _available is None:
        _configure_tesseract_cmd()
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

    from app.models import resize_to_max_side

    _unmask_tesseract_errors()
    results: list[dict] = []
    failed: list[str] = []
    for path in paths:
        # Hand tesseract a FILE PATH, not a PIL image: given a PIL image pytesseract re-encodes
        # it to its own temp PNG (an extra failure surface — the likely source of the masked
        # decode errors). Only oversized uploads are rewritten, to a temp JPEG we control;
        # normal images (incl. pipeline thumbnails) go straight through by path. Any failure
        # drops just this image to `failed` — never an unhandled 500 for the batch.
        tmp_path: str | None = None
        try:
            with Image.open(path) as raw:
                width, height = raw.size
                if max(width, height) > _OCR_MAX_SIDE:
                    small = resize_to_max_side(raw.convert("RGB"), _OCR_MAX_SIDE)
                    tmp_path = f"{path}.ocr.jpg"
                    small.save(tmp_path, "JPEG", quality=92)
                    ocr_path, ocr_w, ocr_h = tmp_path, small.width, small.height
                else:
                    ocr_path, ocr_w, ocr_h = path, width, height
            data = pytesseract.image_to_data(ocr_path, output_type=Output.DICT)
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
                    "coverage": _coverage(boxes, ocr_w, ocr_h),
                    "wordCount": len(words),
                }
            )
        except Exception:  # noqa: BLE001 — never let one image sink the whole /ocr call
            _log.warning("OCR failed for %s", path, exc_info=True)
            failed.append(path)
        finally:
            if tmp_path is not None:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
    return results, failed


async def run_ocr(paths: list[str]) -> tuple[list[dict], list[str]]:
    # Probe before threading — a missing binary is a 500 the worker catches, not work.
    if not available():
        raise OcrError(
            "E_OCR_UNAVAILABLE: tesseract not found — install it (macOS: `brew install "
            "tesseract`; Windows: `winget install UB-Mannheim.TesseractOCR`), then put it on "
            "PATH or set TESSERACT_CMD to the full path of tesseract.exe"
        )
    if not paths:
        return [], []
    return await asyncio.to_thread(_run_ocr_sync, paths)
