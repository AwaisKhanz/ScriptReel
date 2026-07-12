import asyncio
import tempfile
from pathlib import Path

import pytest

# The whole module is skipped when OCR isn't available: first if the pytesseract
# Python package is missing, then if the tesseract binary itself can't be called.
# These tests are NOT part of `pnpm check` — they run only where Tesseract is set up.
pytesseract = pytest.importorskip("pytesseract")


def _tesseract_ready() -> bool:
    try:
        pytesseract.get_tesseract_version()
        return True
    except Exception:  # noqa: BLE001 — binary not installed
        return False


pytestmark = pytest.mark.skipif(not _tesseract_ready(), reason="tesseract binary not installed")


def test_coverage_math_is_clamped() -> None:
    from app.ocr import _coverage

    # Two 10×10 boxes over a 100×100 image = 200 / 10000 = 0.02.
    assert _coverage([(10, 10), (10, 10)], 100, 100) == pytest.approx(0.02)
    # Overlapping / oversized boxes clamp to 1.0, never above.
    assert _coverage([(100, 100), (80, 80)], 100, 100) == 1.0
    # Degenerate image → 0.0, no divide-by-zero.
    assert _coverage([(10, 10)], 0, 0) == 0.0
    assert _coverage([], 100, 100) == 0.0


def test_run_ocr_finds_known_text() -> None:
    from PIL import Image, ImageDraw

    from app.ocr import run_ocr

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "card.png"
        img = Image.new("RGB", (400, 140), (255, 255, 255))
        ImageDraw.Draw(img).text((20, 50), "SHUTTERSTOCK", fill=(0, 0, 0))
        img.save(p)

        results, failed = asyncio.run(run_ocr([str(p)]))
        assert failed == []
        assert len(results) == 1
        assert "shutterstock" in results[0]["text"].lower()
        assert results[0]["wordCount"] >= 1
        assert 0.0 <= results[0]["coverage"] <= 1.0


def test_run_ocr_reports_unreadable_path() -> None:
    from app.ocr import run_ocr

    results, failed = asyncio.run(run_ocr(["/nonexistent/nope.png"]))
    assert results == []
    assert failed == ["/nonexistent/nope.png"]
