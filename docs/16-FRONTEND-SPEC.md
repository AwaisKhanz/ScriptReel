# 16 — Frontend Spec

Next.js 15 App Router, React 19, all data through TanStack Query + one realtime hook. Server Components for shells and initial data; Client Components for anything interactive. No global state library — the server is the state.

## Routes

| Route | Purpose |
|---|---|
| `/` | Dashboard: project grid, New Project CTA, quota + health strip |
| `/projects/new` | 3-step wizard |
| `/projects/[id]` | Status-routed workspace (progress · storyboard · result) |
| `/settings` | Environment, models, cache, quotas |

`/projects/[id]` renders by `project.status`: `queued|running` → **Progress**; `awaiting_review` → **Storyboard**; `done` → **Result** (with a "back to storyboard" affordance); `failed` → **Failure panel** + last good view; `draft` → wizard prefilled at step 3 with a **Generate** button.

## The wizard (`/projects/new`)

Single form (`react-hook-form` + `zod` resolver on `ProjectSettings`), three panes, always-visible right-hand **Summary rail** (estimated duration, beat count, estimated Pexels requests, "≈ 4 min to render on this machine").

1. **Script** — textarea (mono-ish, 1.7 line-height), live counters, language select (`Auto-detect` default), title. Paste of >6,000 chars → inline trim helper, never silent truncation.
2. **Voice** — language-filtered voice grid; each card: name, gender chip, ▶ preview (fetches `/api/voices/:id/sample`, plays through one shared `<audio>`; only one plays at a time). Speed slider with a live "≈ 1:42 narration" recalc. Beat pause slider.
3. **Look & sound** — aspect toggle (three device-shaped buttons, they *look* like their ratio), quality preset, pacing, media preference, transition style, subtitle preset (with **live preview**: a canvas rendering the preset over a stock frame at the chosen aspect — same font stack and geometry as the ASS spec, doc 17, so what you see is what libass burns), subtitle position, music mood + track picker with 8-second in-browser preview, music level, "Review before render" switch (default on).

Submit → `POST /api/projects` then `POST /api/projects/:id/generate` → route to `/projects/[id]`.

## Progress view

`StageStepper` — the seven stages from doc 06 as a vertical rail on desktop, horizontal chips on mobile. Each: name, state (pending/running/done/skipped/failed), per-stage bar, and the live `detail` string ("beat 12/44 · scoring"). Above it: one overall bar using the doc 06 weights, elapsed timer, ETA (weights × observed rate, hidden until 15 s of data), **Cancel**.

`LogTail` — the last 20 `detail` values, timestamped, monospace, collapsible; this is the debugging surface, not a console.

Realtime: `useProjectRealtime(id)` subscribes to `projects` and `pipeline_runs` filtered on `project_id`, patching the query cache. On reconnect, refetch once. Never poll except a 20 s safety refetch when the tab regains focus.

Skipped stages render dimmed with a "cached" chip — this is the moment the user learns re-runs are cheap.

## Storyboard (the money screen)

Grid of `BeatCard`s (16:9 → 3 columns, 9:16 → 5, responsive). Each card:

- Thumbnail of the chosen candidate; on hover/long-press, swap to a muted looping 2-second proxy (`preview_url` for videos, Ken Burns CSS transform for stills). Respects `prefers-reduced-motion`.
- Beat text (2 lines, expandable), duration pill, emotion chip, `kind` badge (video/photo/text card/generated), and a **score badge** — green ≥ τ_hi, amber between, grey below (doc 09). Text cards always show grey with a "fallback" tooltip.
- Row of actions: **Swap** · **Re-search** · **Text card**.

**Swap drawer** (right sheet): top-8 alternates as a 2-column list with thumbnail, provider chip, duration, score, author. Click = optimistic `PATCH /api/beats/:id` and drawer stays open (compare-then-commit feels better). Keyboard: `←/→` move, `Enter` choose, `Esc` close.

**Re-search dialog**: shows the current `visualDescription` (editable, English-only hint), an optional extra query, remaining quota, and a warning when below reserve. Submits `beat-research`; the card shows a spinner shimmer and repopulates on realtime.

Sticky footer: count of beats below τ_lo ("3 beats are weak matches — swap or continue"), **Approve & Render** (primary), duration total. Approve → `POST /continue`.

## Result view

Player (`<video controls>` streaming from `/api/files/...`, poster = thumbnail), duration, filesize, aspect chip. Buttons: **Download MP4**, **Reveal in Finder** (`/api/files/...?reveal=1` is *not* a thing — use a copy-path button; a browser cannot open Finder), **Credits** (modal rendering `credits.txt`, with a Copy button), **Re-render** panel.

Re-render panel is a small subset of wizard step 3 (subtitles, music, quality, aspect). On change it calls a dry-run of the invalidation rules and shows: "Will re-run: compose (~50 s)". Aspect additionally shows "and re-fetch visuals (~2 min)". Then a single **Re-render** button.

Render history strip: previous renders as thumbnails with preset/aspect chips; clicking loads that render in the player (all rows are kept; delete individually).

## Settings

Health cards for db / sidecar / ffmpeg / API keys (from `/api/health`) with a **Re-check** button; model list with size + loaded/cold and a **Warm up** button (`POST {SIDECAR_URL}/warmup`); quota meters; `DATA_DIR` path with cache size and **Clear cache** (search cache / thumbs / assets, each with its own byte count and confirmation).

## Components (`apps/web/components/`)

`VoiceCard`, `VoicePreviewButton`, `AspectToggle`, `SubtitlePreviewCanvas`, `MusicPicker`, `SummaryRail`, `StageStepper`, `LogTail`, `BeatCard`, `CandidateDrawer`, `ReSearchDialog`, `ScoreBadge`, `QuotaMeter`, `HealthCard`, `RenderPlayer`, `CreditsModal`, `RerenderPanel`, `EmptyState`, `ErrorPanel`. shadcn/ui primitives underneath; nothing gets a wrapper that only renames props.

## States that must exist (no exceptions)

Every data surface ships **loading (skeleton, not spinner), empty (with the one action that fixes it), error (code + copyable detail + retry), and offline/sidecar-down** variants. The failure panel maps `error.code` → a human sentence and a suggested fix (doc 18 table), plus "Copy diagnostics" (code, stage, last 20 log lines, versions).

## Accessibility & feel

Keyboard reachable everywhere; focus rings from the token set, never removed. Drawer/dialog focus traps. `aria-live="polite"` on the overall progress percentage and on stage transitions only (not on every detail line). Contrast ≥ 4.5:1 on all text — the dark theme's muted foreground is chosen for this (doc 17). Motion: 150–200 ms ease-out for local UI, no page-level transitions, all decorative motion off under `prefers-reduced-motion`.
