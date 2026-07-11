# 17 — Design System

**Dual-theme studio aesthetic (redesigned 2026-07-11).** A clean, professional app shell (left sidebar + topbar) that ships **light and dark** modes. Light is airy and neutral; dark is a deep studio so the content is the brightest thing on screen. One indigo→violet→blue **brand gradient** carries "the thing you should click" and "the thing that's alive"; solid `--color-accent` (indigo) carries active/selected states. Motion is tasteful (fade-up on mount, shimmer skeletons, animated hero gradient, per-stage progress) and respects `prefers-reduced-motion`.

## Theming mechanism (`apps/web/app/globals.css`, Tailwind v4 `@theme`)

Semantic color tokens are declared in `@theme` with **light** values (so `:root` = light and the `bg-*/text-*/border-*` utilities generate). The `.dark` class (on `<html>`) overrides the same `--color-*` names with dark values. A tiny inline boot script in `layout.tsx` sets the class before first paint (localStorage → `prefers-color-scheme`) so there is no flash; the topbar toggle flips it and persists to `localStorage.theme`. `@custom-variant dark (&:where(.dark, .dark *))` enables `dark:` utilities where a token swap isn't enough.

```css
@theme {                              /* light defaults; .dark {} overrides these */
  --color-bg / surface / surface-2 / surface-3;   /* app bg → cards → raised → deeper */
  --color-border / border-strong;                 /* hairlines */
  --color-fg / fg-muted / fg-subtle;              /* body → labels → metadata only */
  --color-accent / accent-hover / accent-fg / accent-quiet;  /* indigo #6366F1 light, #818CF8 dark */
  --color-progress / success / warning / danger;  /* amber running · emerald · amber · red */
  --brand-1 #7C5CFF / --brand-2 #6366F1 / --brand-3 #4F86F7;  /* gradient stops (shared) */
  --font-sans (Inter, next/font) / --font-mono (JetBrains Mono, next/font);
  --text-xs…4xl; --radius-sm…2xl; --shadow-xs…lg + --shadow-glow;
  --ease-out / --ease-spring; --dur-fast 120 / base 200 / slow 320;
  --animate-fade-up / fade-in / scale-in / shimmer / gradient / pulse-ring / float;
}
```

Component classes in `@layer components`: `.brand-gradient`, `.brand-gradient-animated`, `.text-gradient`, `.hero-surface`, `.app-mesh`, `.skeleton` (shimmer sheen), `.card-interactive` (hover lift), `.accent-rule` (gradient hairline). Reusable UI primitives live in `components/ui.tsx` (Button, Card, Badge, Dot, ProgressBar, Spinner, Skeleton, ErrorPanel) and `components/controls.tsx` (Field, Pills, Slider, AspectToggle); the shell is `components/shell.tsx` (Sidebar, Topbar, ThemeToggle, systems pill).

**Rules.** No hardcoded hex, px radius, or duration in components — token or nothing (raw values allowed only inside `globals.css`, which biome excludes). Both themes must stay legible: rely on semantic tokens that auto-swap rather than `dark:` one-offs. Spacing is Tailwind's 4px scale. Body text `--text-base`; metadata `--text-xs` in `--color-fg-subtle`. The brand gradient is the single "alive/click" cue per region.

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

ASS `PlayRes` **matches the render aspect** (`16:9`→1920×1080, `9:16`→1080×1920, `1:1`→1080×1080) so libass scales uniformly and captions never distort or overflow — a fixed 1920×1080 `PlayRes` on a 1080×1920 frame was the portrait-overflow bug (fixed 2026-07-11). Font size, MarginV, and the per-line char cap are therefore per-aspect. Colors are ASS `&HAABBGGRR` (AA=00 opaque). Fonts bundled in `assets/fonts/` and passed via `-vf subtitles=…:fontsdir=`.

| Preset | Font | Size (16:9 / 9:16 / 1:1) | Primary / Secondary | Outline · Shadow | Align · MarginV (16:9 / 9:16 / 1:1) | Max chars/line (16:9 / 9:16 / 1:1) |
|---|---|---|---|---|---|---|
| `clean` | Inter SemiBold | 54 / 50 / 50 | `&H00E8EBF0` / — | 2.5 `&HC0000000` · 0 | 2 (bottom-center) · 90 / 220 / 110 | 42 / 26 / 28 |
| `pop` | Inter ExtraBold | 76 / 80 / 78 | `&H00FF5C7C` (accent BGR) / `&H00FFFFFF` | 4 `&HFF0A0C10` · 2 | 5 (middle-center) · 0 | Word karaoke (`\k`), 1–3 words/event, `\fscx105\fscy105` on active |
| `lowerthird` | Inter Medium | 46 / 44 / 44 | `&H00E8EBF0` / — | 0 · 0, `BorderStyle=3`, `BackColour=&HB30A0C10` | 1 (bottom-left) · 70 / 180 / 90, MarginL 96 | 38 / 24 / 26 |
| `documentary` | Source Serif 4 SemiBold | 50 / 46 / 48 | `&H00F0EDE6` / — | 2 `&HD0000000` · 1 | 2 · 100 / 230 / 120 | 46 / 28 / 30 |
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
