"""Text-card renderer (doc 14 §Textcard, doc 17 §Text-card themes).

Deterministic given its inputs: a theme-gradient background, the key phrase in a
script-appropriate font auto-shrunk to fit ≤2 lines, an accent bar, and a fixed
grain overlay. This is the last rung of the fallback ladder — it must always
produce a legible card, so failures raise E_TEXTCARD (a real error, not a warning).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_REPO_ROOT = Path(__file__).resolve().parents[3]
_THEMES_PATH = _REPO_ROOT / "assets" / "brand" / "textcard-themes.json"
_FONTS = _REPO_ROOT / "assets" / "fonts"

# 2× target resolution per aspect (doc 14): rendered big, downscaled in compose.
_TARGET = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
_SCALE = 2
_SAFE_MARGIN = 0.08  # 8% safe margin
_TEXT_WIDTH = 0.80  # phrase fits 80% of canvas width
_ACCENT_BAR_W = 0.18  # 18% of canvas width
_GRAIN_OPACITY = 0.06


class TextcardError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_TEXTCARD"


def _load_themes() -> dict[str, dict]:
    return json.loads(_THEMES_PATH.read_text())


def _hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _font_path_for(phrase: str) -> Path:
    """Pick a font whose glyphs cover the phrase's script (doc 14)."""
    for ch in phrase:
        o = ord(ch)
        if 0x0900 <= o <= 0x097F:
            return _FONTS / "NotoSansDevanagari.ttf"
        if 0x3040 <= o <= 0x30FF:  # hiragana/katakana
            return _FONTS / "NotoSansJP.ttf"
        if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF:  # CJK ideographs
            return _FONTS / "NotoSansSC.ttf"
    return _FONTS / "Inter.ttf"


def _load_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(path), size)
    for name in ("Extra Bold", "ExtraBold", "Black", "Bold"):  # variable Inter → heaviest available
        try:
            font.set_variation_by_name(name)
            break
        except (OSError, AttributeError, ValueError):
            continue
    return font


def _gradient(w: int, h: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    t = np.linspace(0.0, 1.0, h)[:, None]  # h×1 top→bottom
    arr = np.array(top)[None, :] * (1 - t) + np.array(bottom)[None, :] * t  # h×3
    col = np.repeat(arr[:, None, :], w, axis=1).astype(np.uint8)
    return Image.fromarray(col, "RGB")


def _wrap_two_lines(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: float) -> list[str]:
    if draw.textlength(text, font=font) <= max_w:
        return [text]
    words = text.split()
    if len(words) < 2:
        return [text]  # single long word — shrink handles it
    best: tuple[float, list[str]] | None = None
    for i in range(1, len(words)):
        l1, l2 = " ".join(words[:i]), " ".join(words[i:])
        widest = max(draw.textlength(l1, font=font), draw.textlength(l2, font=font))
        if best is None or widest < best[0]:
            best = (widest, [l1, l2])
    return best[1] if best else [text]


def _fit(draw: ImageDraw.ImageDraw, text: str, font_path: Path, max_w: float, start_size: int) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    size = start_size
    while size > 12:
        font = _load_font(font_path, size)
        lines = _wrap_two_lines(draw, text, font, max_w)
        if len(lines) <= 2 and all(draw.textlength(ln, font=font) <= max_w for ln in lines):
            return font, lines
        size -= max(4, size // 20)
    font = _load_font(font_path, 12)
    return font, _wrap_two_lines(draw, text, font, max_w)


def _grain(w: int, h: int) -> Image.Image:
    # Blocky grain: generate at ¼ res and nearest-upscale so the PNG still compresses
    # (per-pixel noise balloons the file ~10×). Fixed seed → deterministic card.
    rng = np.random.default_rng(0)
    noise = rng.integers(0, 256, size=(max(1, h // 4), max(1, w // 4)), dtype=np.uint8)
    small = Image.fromarray(noise, "L").convert("RGB")
    return small.resize((w, h), Image.NEAREST)


def render(phrase: str, emotion: str, aspect: str, theme: str, out_path: str) -> str:
    try:
        themes = _load_themes()
        t = themes.get(theme) or themes.get("neutral")
        if t is None:
            raise TextcardError("no themes defined")
        tw, th = _TARGET.get(aspect, _TARGET["16:9"])
        w, h = tw * _SCALE, th * _SCALE

        img = _gradient(w, h, _hex_rgb(t["bg"][0]), _hex_rgb(t["bg"][1]))
        draw = ImageDraw.Draw(img)

        max_w = w * _TEXT_WIDTH
        text = (phrase or emotion or "").strip() or " "
        font, lines = _fit(draw, text, _font_path_for(text), max_w, int(h * 0.14))

        # Center the block vertically; measure line height from the font metrics.
        ascent, descent = font.getmetrics()
        line_h = int((ascent + descent) * 1.15)
        block_h = line_h * len(lines)
        y = (h - block_h) // 2
        text_rgb = _hex_rgb(t["text"])
        last_bottom = y
        for ln in lines:
            lw = draw.textlength(ln, font=font)
            draw.text(((w - lw) / 2, y), ln, font=font, fill=text_rgb)
            y += line_h
            last_bottom = y

        # Accent bar: 4px (×scale) tall, 18% wide, 32px (×scale) under the last line.
        bar_w = int(w * _ACCENT_BAR_W)
        bar_h = 4 * _SCALE
        bar_y = last_bottom + 32 * _SCALE
        bar_x = (w - bar_w) // 2
        draw.rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], fill=_hex_rgb(t["accent"]))

        # Subtle grain overlay at 6% opacity.
        img = Image.blend(img, _grain(w, h), _GRAIN_OPACITY)

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path, optimize=True)
        return out_path
    except TextcardError:
        raise
    except Exception as exc:  # noqa: BLE001 — any Pillow/IO failure surfaces as E_TEXTCARD
        raise TextcardError(f"E_TEXTCARD: {exc}") from exc
