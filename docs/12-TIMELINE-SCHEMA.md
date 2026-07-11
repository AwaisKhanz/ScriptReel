# 12 — Timeline JSON Schema (THE CONTRACT)

`timeline.json` fully describes a render. The composer (doc 13) consumes **only** this file + referenced local paths. No DB reads, no AI, no network inside the renderer. Zod schema in `packages/core/src/timeline.ts` is the source of truth; this doc mirrors it. `version` gates breaking changes.

```ts
export interface Timeline {
  version: 1;
  projectId: string;
  createdAt: string;                      // ISO
  render: {
    aspect: '16:9' | '9:16' | '1:1';
    width: number; height: number;        // 1920×1080 | 1080×1920 | 1080×1080
    fps: 30;
    preset: 'draft' | 'final';            // encode params resolved in doc 13
  };
  narration: {
    audioPath: string;                    // absolute path to vo.wav (48kHz, -16 LUFS)
    durationSec: number;                  // ffprobe-measured
  };
  music: null | {
    path: string;                         // bundled track or user upload (local)
    gainDb: number;                       // relative to voice, e.g. -16
    fadeOutSec: number;                   // default 2
    credit: string;
  };
  subtitles: null | {
    assPath: string;                      // pre-built render.ass for this preset+aspect
    preset: 'clean'|'pop'|'lowerthird'|'documentary';
  };
  beats: TimelineBeat[];                  // ordered; startSec strictly increasing
  transitions: {
    default: 'crossfade' | 'cut';
    crossfadeSec: number;                 // 0.3–0.6
    perBoundary?: ('crossfade'|'cut')[];  // length = beats.length - 1 (smart mix resolves here)
  };
  credits: { text: string };              // full credits.txt content
}

export interface TimelineBeat {
  idx: number;
  text: string;                           // for logs/QA only
  startSec: number;                       // on the narration master clock
  durationSec: number;                    // measured narration duration + trailing pause share
  media: {
    kind: 'video' | 'image' | 'generated' | 'textcard';
    path: string;                         // normalized clip OR source still (see below)
    sourceDurationSec?: number;           // for videos, ffprobe of normalized clip
    inPointSec?: number;                  // trim start within source (videos; default 0)
    kenburns?: {                          // REQUIRED for image|generated|textcard
      direction: 'in-tl'|'in-br'|'out-tr'|'out-bl';  // alternate per consecutive still
      zoomFrom: number; zoomTo: number;   // e.g. 1.0 → 1.08 (in), 1.08 → 1.0 (out)
    };
    provider?: string; providerId?: string; author?: string; pageUrl?: string;
  };
}
```

## Invariants (composer MUST validate before rendering; violation = `E_TIMELINE_INVALID`)

1. `beats[0].startSec === 0`; `beats[i+1].startSec === beats[i].startSec + beats[i].durationSec` (contiguity); `Σ durationSec === narration.durationSec ± 1/30 s` (last beat absorbs rounding).
2. All durations frame-quantized to 1/30 s before writing (builder responsibility; accumulate rounding into the final beat).
3. Every `media.path` exists on disk; video clips already normalized to `render.width×height@30` (fetch stage output) with length ≥ `durationSec + crossfade padding` (padding rules in doc 13 §xfade) — builder guarantees via loop/hold during normalization.
4. `perBoundary`, when present, has exactly `beats.length − 1` entries.
5. `startSec` values are the **subtitle clock too** — `words.json` times and beat times share one origin (vo.wav t=0). The composer never re-times anything.

## Builder (worker, start of compose stage)

`buildTimeline(project, beats, selections, settings) → Timeline`:
- durations: `beat.durationSec = narration.durationSec + pauseSec` (pause attaches to the *preceding* beat; last beat gets remaining audio tail).
- videos: `inPointSec` is the **most dynamic window** of the source (doc 23 §7) — the fetch stage samples per-frame motion (`ffmpeg scdet` mean-abs-frame-diff) and `pickBestWindow` picks the highest-motion window of the needed length, so a clip doesn't open on a static intro. Fallback when no motion signal is available: center the used window, skipping the first 10%. If source shorter than needed → normalization already looped it.
- smart-mix transitions: boundary = `cut` when `shotType` equal AND emotion equal on both sides, else `crossfade` (from beats table).
- stills get `kenburns` with direction cycling `in-tl → out-tr → in-br → out-bl`.
- Frozen copy stored on the `renders` row for reproducibility.

## Example (abbreviated, 3 beats)

```json
{
  "version": 1, "projectId": "…", "createdAt": "2026-07-07T10:00:00Z",
  "render": { "aspect": "16:9", "width": 1920, "height": 1080, "fps": 30, "preset": "final" },
  "narration": { "audioPath": "…/audio/vo.wav", "durationSec": 21.400 },
  "music": { "path": "assets/music/uplift_01.mp3", "gainDb": -16, "fadeOutSec": 2, "credit": "FreePD (CC0)" },
  "subtitles": { "assPath": "…/subs/render.ass", "preset": "clean" },
  "beats": [
    { "idx": 0, "text": "Every morning, the city wakes slowly.", "startSec": 0, "durationSec": 6.833,
      "media": { "kind": "video", "path": "…/clips/0.mp4", "sourceDurationSec": 7.3, "inPointSec": 0,
                 "provider": "pexels", "providerId": "857195", "author": "…", "pageUrl": "…" } },
    { "idx": 1, "text": "Streets fill with quiet purpose.", "startSec": 6.833, "durationSec": 7.100,
      "media": { "kind": "image", "path": "…/clips/1.mp4", "provider": "pixabay", "providerId": "22114",
                 "kenburns": { "direction": "out-tr", "zoomFrom": 1.08, "zoomTo": 1.0 } } },
    { "idx": 2, "text": "And somewhere, a story begins.", "startSec": 13.933, "durationSec": 7.467,
      "media": { "kind": "textcard", "path": "…/clips/2.mp4",
                 "kenburns": { "direction": "in-tl", "zoomFrom": 1.0, "zoomTo": 1.06 } } }
  ],
  "transitions": { "default": "crossfade", "crossfadeSec": 0.4, "perBoundary": ["crossfade", "cut"] },
  "credits": { "text": "…" }
}
```

Note: stills/textcards are ALSO pre-baked into motion clips (`clips/{idx}.mp4`) during fetch/normalize using their `kenburns` spec — the composer's concat pass therefore only ever sees uniform video inputs. `kenburns` stays in the timeline for auditability and re-normalization.
