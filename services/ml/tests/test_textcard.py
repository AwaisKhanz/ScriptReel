import hashlib
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)


def _render(out: Path, aspect: str = "16:9", theme: str = "tense", phrase: str = "What does it mean to doubt?") -> None:
    res = client.post(
        "/textcard",
        json={"phrase": phrase, "emotion": "tense", "aspect": aspect, "theme": theme, "outPath": str(out)},
    )
    assert res.status_code == 200, res.text
    assert res.json()["path"] == str(out)


def test_textcard_deterministic_checksum() -> None:
    with tempfile.TemporaryDirectory() as d:
        a, b = Path(d) / "a.png", Path(d) / "b.png"
        _render(a)
        _render(b)
        # Deterministic given inputs (doc 14): identical bytes → identical checksum.
        assert hashlib.sha256(a.read_bytes()).hexdigest() == hashlib.sha256(b.read_bytes()).hexdigest()


def test_textcard_dimensions_per_aspect() -> None:
    with tempfile.TemporaryDirectory() as d:
        for aspect, size in (("16:9", (3840, 2160)), ("9:16", (2160, 3840)), ("1:1", (2160, 2160))):
            out = Path(d) / f"{aspect.replace(':', 'x')}.png"
            _render(out, aspect=aspect)
            assert Image.open(out).size == size  # 2× target resolution


def test_textcard_unknown_theme_falls_back() -> None:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "fallback.png"
        _render(out, theme="does-not-exist")  # falls back to neutral, still renders
        assert out.exists() and out.stat().st_size > 0
