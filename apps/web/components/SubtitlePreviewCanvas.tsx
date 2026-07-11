'use client';

import { PLAY_RES, PRESETS, type SubtitleAspect, type SubtitlePreset } from '@scriptreel/core';

// ASS &HAABBGGRR (AA: 00=opaque, FF=transparent) → CSS rgba.
function assToCss(ass: string): string {
  const hex = ass.replace('&H', '').padStart(8, '0');
  const aa = parseInt(hex.slice(0, 2), 16);
  const bb = parseInt(hex.slice(2, 4), 16);
  const gg = parseInt(hex.slice(4, 6), 16);
  const rr = parseInt(hex.slice(6, 8), 16);
  return `rgba(${rr},${gg},${bb},${((255 - aa) / 255).toFixed(2)})`;
}

const PREVIEW_WIDTH: Record<SubtitleAspect, number> = { '16:9': 560, '9:16': 236, '1:1': 380 };

const SAMPLE = 'Every morning, the city wakes slowly and the streets fill with quiet purpose';

// Renders the chosen preset over a stock-like frame at the true ASS geometry (font,
// size, margins, alignment, colors from packages/core PRESETS/PLAY_RES) so the preview
// matches what libass burns (doc 16).
export function SubtitlePreviewCanvas({
  preset,
  aspect,
  position,
  text = SAMPLE,
}: {
  preset: SubtitlePreset | 'none';
  aspect: SubtitleAspect;
  position?: 'bottom' | 'middle' | 'top';
  text?: string;
}) {
  const res = PLAY_RES[aspect];
  const boxW = PREVIEW_WIDTH[aspect];
  const scale = boxW / res.x;
  const boxH = res.y * scale;

  const frame = (
    <div
      className="relative overflow-hidden rounded-md"
      style={{
        width: boxW,
        height: boxH,
        background:
          'linear-gradient(160deg,#2a2f3a 0%,#3a3020 40%,#1a1c22 100%), radial-gradient(120% 80% at 50% 30%,#4a4235,transparent)',
      }}
    >
      {preset === 'none' ? null : renderCaption()}
    </div>
  );

  function renderCaption() {
    const p = PRESETS[preset as SubtitlePreset];
    const fontSize = p.sizes[aspect] * scale;
    const marginV = p.marginV[aspect] * scale;
    const marginL = p.marginL * scale;
    const marginR = p.marginR * scale;
    const font =
      p.latinFont === 'Source Serif 4' ? 'Georgia, serif' : 'Inter, system-ui, sans-serif';
    const color = assToCss(p.primary);
    const outline = assToCss(p.outline);
    const words = text
      .split(' ')
      .slice(0, Math.max(4, Math.round(p.maxChars[aspect] / 5)))
      .join(' ');

    // alignment: 1 bottom-left, 2 bottom-center, 5 middle-center, 8 top-center.
    // position override remaps center presets (doc 17).
    let align = p.alignment;
    if (position && (p.alignment === 2 || p.alignment === 5 || p.alignment === 8)) {
      align = position === 'top' ? 8 : position === 'middle' ? 5 : 2;
    }
    const vertical =
      align === 5
        ? { top: '50%', transform: 'translateY(-50%)' }
        : align === 8
          ? { top: marginV }
          : { bottom: marginV };
    const horizontal =
      align === 1
        ? { left: marginL, right: marginR, textAlign: 'left' as const }
        : { left: marginL, right: marginR, textAlign: 'center' as const };

    const textShadow = `0 0 ${Math.max(1, p.outlineWidth * scale)}px ${outline}, 0 1px ${Math.max(1, p.outlineWidth * scale)}px ${outline}`;

    return (
      <div
        style={{
          position: 'absolute',
          ...vertical,
          ...horizontal,
          fontFamily: font,
          fontSize,
          fontWeight: p.bold === -1 ? 800 : 500,
          lineHeight: 1.2,
          color,
          textShadow: p.borderStyle === 1 ? textShadow : undefined,
          background: p.borderStyle === 3 ? assToCss(p.back) : undefined,
          padding: p.borderStyle === 3 ? `${4 * scale}px ${10 * scale}px` : undefined,
          borderRadius: p.borderStyle === 3 ? 4 * scale : undefined,
          display: p.borderStyle === 3 ? 'inline-block' : undefined,
          letterSpacing: p.spacing ? p.spacing * scale : undefined,
        }}
      >
        {words}
      </div>
    );
  }

  return <div className="flex justify-center">{frame}</div>;
}
