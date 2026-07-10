# 11 — Alignment & Subtitles

## Problem shape

We synthesized the audio **and** know the exact text → this is *forced alignment*, not transcription. Whisper is used only to discover word timings, which are then mapped onto the known script tokens. Wrong Whisper words don't matter; wrong timings do.

## Alignment pipeline (align stage)

1. `POST /align {audioPath: vo.wav, language, text}` → sidecar runs **mlx-whisper** (`whisper-large-v3-turbo`; auto-fallback `whisper-small` if RAM-pressured) with `word_timestamps=True`, language pinned. Returns `[{word, start, end}]`.
2. **Token mapping (worker):** normalize both sequences (lowercase, strip punctuation, NFKC; ja/zh: no spaces — see CJK below). Align script tokens ↔ whisper tokens with `difflib.SequenceMatcher`-equivalent (implement diff-match in TS or call a tiny sidecar helper — pick TS, `fast-diff` on token arrays). Matched script tokens inherit whisper timings; unmatched runs get **linear interpolation** by character weight between the nearest matched anchors. First/last tokens clamp to beat narration bounds.
3. **Beat snapping:** every beat's first word start := max(word.start, beat.startSec) and last word end := min(word.end, beat.startSec+duration) — beats are ground truth; whisper only distributes time inside them.
4. Output `subs/words.json`: `[{beatIdx, word, start, end}]` (times on the master clock). This file, not ASS, is the durable artifact; ASS is regenerated per style/aspect at compose time (cheap re-renders).

**Fallback:** if whisper fails entirely (`E_ALIGN`), degrade to pure proportional interpolation per beat (character-weighted). Log loudly; subtitles remain watchable, slightly less crisp.

## CJK & Hindi specifics

- ja/zh script tokens: segment into display units of 2–4 characters (ja: prefer kana/kanji boundaries via simple regex classes; zh: 2-char pairs). Whisper output for zh/ja is already char-ish; align at character level then group.
- Fonts (bundled in `assets/fonts/`, OFL): `Inter` (Latin UI/subs), `NotoSans-*` (Latin fallback), `NotoSansDevanagari`, `NotoSansJP`, `NotoSansSC`. Font per language chosen by the style builder; pass `fontsdir=assets/fonts` to libass. **Never depend on system fonts.**

## ASS generation (`packages/core/src/subtitles/`)

`buildAss(words, preset, aspect, language) → string`. `PlayResX/Y` = render resolution. Line-breaking: greedy fill to `maxCharsPerLine` (16:9 clean: 42; 9:16 pop: n/a — word groups; lowerthird: 38; documentary: 46; CJK: ≈60% of those counts), max 2 lines, break at word boundaries, never orphan 1 word on line 2 if avoidable. Event timing: from first word start −80 ms lead-in to last word end +120 ms tail, clamped to neighbors.

### Presets (colors/fonts are tokens from doc 17)

| Preset | Behavior |
|---|---|
| `clean` | 2-line bottom captions, Inter SemiBold, white, 55% black rounded-feel band (BorderStyle=1, Outline 3, Shadow 0, subtle backcolour), Alignment 2, MarginV 96 |
| `pop` | **Karaoke.** Groups of 1–3 words as separate events, Alignment 5 (center), huge bold (PlayRes 1080×1920: size ~92), active word highlighted via `{\k}` centisecond tags with PrimaryColour→accent SecondaryColour; slight `\fscx105` pop on group start using `\t` |
| `lowerthird` | Single line, left-aligned (Alignment 1, MarginL 120), accent 4px underline via a drawn rect event, Inter Medium |
| `documentary` | Source Serif-style feel using Inter with wider spacing (`\fsp1.5`), smaller, high MarginV, letterboxed vibe |
| `none` | No subtitle pass |

Full ASS `Style:` lines with exact params live in `packages/core/src/subtitles/presets.ts` and are the single source; doc 17 lists the visual tokens. Position override (bottom/middle/top) maps to Alignment 2/5/8 with preset margins.

### Karaoke mechanics (`pop`)

Per group event: `{\k dur1}word1 {\k dur2}word2 …` where durN = round((end−start)·100) cs; group event spans group first-start→last-end. Highlight = SecondaryColour (pre-sung) vs PrimaryColour; set colors so the *active* word is accent (`--accent` token) on white — i.e. PrimaryColour=accent, SecondaryColour=white, and libass \k sweeps Secondary→Primary. Verify direction in Phase 4 (libass \k sweeps Secondary→Primary — correct as specified).

## Burn-in

Compose pass (doc 13) applies `subtitles={projectDir}/subs/render.ass:fontsdir=assets/fonts`. `render.ass` is built at compose time from `words.json` + current preset + aspect. `none` skips the filter.

## Quality bar (Phase 4 exit)

Golden English narration: 95% of words within ±120 ms of hand-checked timings (sample 40 words); ja/hi golden: subtitles visually sync at 1× playback with no line overflow; karaoke sweep matches audible word on spot-check.
