# 17 — Design System

Dark studio aesthetic: video tools live in the dark so the content is the brightest thing on screen. One accent, used sparingly, for *the thing you should click* and *the thing that's alive*.

## Tokens (`apps/web/app/globals.css`, Tailwind v4 `@theme`)

```css
@import "tailwindcss";

@theme {
  /* surfaces — each step ≈ +3% lightness, never pure black */
  --color-bg:            #0A0C10;   /* app background */
  --color-surface:       #11141A;   /* cards, rails */
  --color-surface-2:     #171B23;   /* raised: drawers, dialogs, hover */
  --color-border:        #232833;   /* 1px hairlines */
  --color-border-strong: #333A48;

  /* foreground */
  --color-fg:            #E8EBF0;
  --color-fg-muted:      #98A1B2;   /* ≥ 4.5:1 on --color-bg */
  --color-fg-subtle:     #6B7385;   /* metadata only, never body text */

  /* accent + semantics */
  --color-accent:        #7C5CFF;   /* violet — primary actions, active states */
  --color-accent-hover:  #8E72FF;
  --color-accent-quiet:  #7C5CFF1F; /* 12% wash for selected rows */
  --color-progress:      #F5A524;   /* amber — running/working, never success */
  --color-success:       #29C489;
  --color-warning:       #E8B84B;
  --color-danger:        #F0556B;

  /* type */
  --font-sans: "Inter var", Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 0.9375rem;
  --text-lg: 1.125rem; --text-xl: 1.375rem; --text-2xl: 1.75rem; --text-3xl: 2.25rem;

  /* shape & depth */
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-xl: 20px;
  --shadow-card: 0 1px 2px #0006;
  --shadow-pop:  0 12px 32px -8px #000A, 0 0 0 1px var(--color-border);

  /* motion */
  --ease-out: cubic-bezier(.16,1,.3,1);
  --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 280ms;
}
```

**Rules.** No hardcoded hex, px radius, or duration anywhere in components — token or nothing. Spacing is Tailwind's 4px scale; layout gutters are `space-6` (24px) desktop, `space-4` mobile. Body text `--text-base` at `leading-relaxed`; metadata `--text-xs` in `--color-fg-subtle`. Exactly one `--color-accent` element per view region.

## Component conventions

| Element | Spec |
|---|---|
| Card | `bg-surface border border-border rounded-lg shadow-card`; hover raises to `surface-2` + `border-strong`, `--dur-fast` |
| Primary button | accent bg, `#0A0C10` text (accent is light enough to need dark text), `radius-md`, 40px tall, `active:scale-[0.98]` |
| Secondary | `surface-2` bg, `fg` text, hairline border |
| Ghost/icon | transparent, hover `surface-2` |
| Input/textarea | `bg-bg`, hairline, focus = 2px accent ring at 40% + border-strong |
| Chip | 24px tall, `radius-sm`, `surface-2`, `--text-xs`, uppercase tracking-wide for status only |
| Score badge | filled dot + number: success ≥ τ_hi · warning between · `fg-subtle` below |
| Progress bar | 4px, `surface-2` track, `--color-progress` fill, indeterminate = 30% shimmer at 1.2 s |
| Skeleton | `surface-2` with a 1.4 s left→right sheen; never a spinner for content, spinners only inside buttons |
| Focus ring | `outline: 2px solid --color-accent; outline-offset: 2px` — never removed |

## Brand & empty states

Wordmark: "ScriptReel" in Inter SemiBold with a 2px accent underline on "Reel" (rename = one CSS file + one SVG). Empty dashboard: a single sentence ("Paste a script. Get a video."), the New Project button, nothing else. Illustration budget: zero.

## Subtitle presets (canonical — doc 11 renders these, doc 16 previews them)

ASS `PlayResX=1920, PlayResY=1080` always; libass scales to the render geometry. Colors are ASS `&HAABBGGRR` (AA=00 opaque). Fonts bundled in `assets/fonts/` and passed via `-vf subtitles=…:fontsdir=`.

| Preset | Font | Size (16:9 / 9:16 / 1:1) | Primary / Secondary | Outline · Shadow | Align · MarginV | Notes |
|---|---|---|---|---|---|---|
| `clean` | Inter SemiBold | 54 / 62 / 58 | `&H00E8EBF0` / — | 2.5 `&HC0000000` · 0 | 2 (bottom-center) · 90 | Default 16:9. Max 2 lines, 42 chars |
| `pop` | Inter ExtraBold | 76 / 92 / 84 | `&H00FF5C7C` (accent BGR) / `&H00FFFFFF` | 4 `&HFF0A0C10` · 2 | 5 (middle-center) · 0 | Word karaoke (`\k`), 1–3 words per event, `\fscx105\fscy105` on active |
| `lowerthird` | Inter Medium | 46 / 54 / 50 | `&H00E8EBF0` / — | 0 · 0, `BorderStyle=3`, `BackColour=&HB30A0C10` | 1 (bottom-left) · 70, MarginL 96 | Boxed band, documentary interview feel |
| `documentary` | Source Serif 4 SemiBold | 50 / 58 / 54 | `&H00F0EDE6` / — | 2 `&HD0000000` · 1 | 2 · 100 | Warm off-white, calmer pacing |
| `none` | — | — | — | — | — | Composer skips the subtitles filter entirely |

Karaoke color logic (doc 11): libass sweeps `SecondaryColour → PrimaryColour`, so for `pop`, Primary is the accent (sung/active) and Secondary is white (upcoming). Verify visually at Phase 4, don't reason about it twice.

Position override maps to `Alignment` (`top`=8, `middle`=5, `bottom`=2) plus MarginV; `pop` ignores `bottom` on 9:16 (center is the format's convention).

## Text-card themes (`assets/brand/textcard-themes.json`, consumed by sidecar doc 14)

```json
{
  "neutral":   { "bg": ["#11141A", "#0A0C10"], "text": "#E8EBF0", "accent": "#7C5CFF" },
  "uplifting": { "bg": ["#1B1430", "#0A0C10"], "text": "#F2EEFF", "accent": "#9B7CFF" },
  "calm":      { "bg": ["#0E1A1E", "#0A0C10"], "text": "#E3F1F0", "accent": "#3FC8B4" },
  "tense":     { "bg": ["#220F14", "#0A0C10"], "text": "#FFE9EC", "accent": "#F0556B" },
  "corporate": { "bg": ["#0D1520", "#0A0C10"], "text": "#E6EEF7", "accent": "#4C9BF0" }
}
```

Card layout: 8% safe margin; key phrase centered, Inter ExtraBold, auto-shrunk to fit 80% width across ≤ 2 lines; a 4px accent bar 32px under the last line, width = 18% of canvas; 6% grain overlay. Emotion → theme mapping lives in `packages/core/src/emotion.ts` (unmapped emotions → `neutral`).

## UI voice

Plain, specific, no exclamation marks. Say what happened and what to do: *"Pexels hourly limit reached. Re-search unlocks in 24 min, or continue with current matches."* Never "Oops!". Never blame the user. Numbers over adjectives ("3 weak matches", not "some matches may be poor"). Honest about tradeoffs: non-English voices are labelled "Good" vs English's "Best" rather than pretending parity.
