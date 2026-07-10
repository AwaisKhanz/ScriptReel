# CLAUDE.md — ScriptReel

AI script-to-video generator. Local-first, free stack, Apple Silicon (M3 Pro). Full specs in `docs/` — `docs/00-INDEX.md` first.

## Commands

```bash
pnpm dev            # web :3000 + worker + sidecar :8484 (turbo)
pnpm sidecar        # sidecar alone (uv run uvicorn)
pnpm check          # tsc -b + biome check + vitest      ← must be green to finish a phase
pnpm db:migrate     # supabase db push (applies migrations to Supabase Cloud)
pnpm db:types       # regenerate packages/db types
pnpm stage <name> --project <id>   # run one pipeline stage from the CLI
pnpm eval:matching  # matching precision@1 over the labeled set
pnpm test:drift <projectId>        # subtitle alignment drift
```

Prereqs and model downloads: `docs/19-SETUP-MACOS.md`. The DB is Supabase **Cloud** (no local Docker stack); the CLI is linked, so `pnpm db:migrate` pushes migrations to cloud.

## Architecture in one paragraph

Three local processes: **web** (Next.js 15 — UI + thin API routes), **worker** (Node 22 — the pipeline, providers, FFmpeg), **sidecar** (Python 3.12 FastAPI — models only: Kokoro TTS, SigLIP 2 embeddings, mlx-whisper alignment, Pillow text cards, optional FLUX). Postgres via Supabase **Cloud** (no local Docker); pg-boss for jobs; media and renders on disk under `DATA_DIR`. Stages: `analyze → search → score → [review gate] → tts → align → fetch → compose`.

## Non-negotiable invariants

1. **`timeline.json` (doc 12) is the only contract between the brain and the renderer.** The renderer never calls an AI; the brain never calls FFmpeg except to probe.
2. **Narration is the clock.** Measured TTS durations drive every visual duration. Never the reverse.
3. **Every stage is idempotent**, keyed by `inputsHash`, resumable from its on-disk manifest. Write artifacts, then the manifest, atomically.
4. **All media is downloaded before composition.** No hotlinking.
5. **English search queries always**, regardless of script language.
6. **No provider call outside `QuotaGuard` + `SearchCache`.** Free-tier quota is a hard budget (doc 22).
7. **Degrade, never die.** The fallback ladder ends at a text card, which always succeeds. `E_NO_CANDIDATES`, `E_ALIGN`, `E_GEN_MEM`, `E_NORMALIZE` are warnings, not failures.
8. **`packages/core` does zero I/O.** Pure functions and zod schemas only.
9. **Zod at every process boundary**; `unknown` until parsed; no `any`.
10. **No hardcoded design values.** Tokens from `docs/17` or nothing.

## Working rules

- Execute `docs/20-ROADMAP.md` **one phase per session, in order, with fresh context.** Read only the docs that phase lists. Don't start the next phase in the same session.
- A phase is done when its exit criteria are demonstrated, not when it compiles.
- Don't invent features. Anything unspecified: follow `docs/18-CODING-STANDARDS.md`, then the simplest correct implementation.
- Constants marked `[CALIBRATE]` are starting values owned by a specific phase. When you calibrate one, update `packages/core/src/constants.ts` **and** the doc that quotes it.
- If two docs conflict, the more specific one wins (13 beats 03 on FFmpeg).
- `execa` with argument arrays, never shell strings. Bounded concurrency (doc 06), never unbounded `Promise.all`.

## Sharp edges

- Kokoro needs Python **3.12** (not 3.13); Japanese needs `unidic` (`make setup-ja`); several languages need `espeak-ng`.
- FFmpeg must be a libass-enabled build — plain brew `ffmpeg` is **not** (no `subtitles`/`ass` filter); install `ffmpeg-full` (keg-only) and set `FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`. `zoompan` jitters unless you pre-scale ~1.5–2× first.
- `xfade` requires identical geometry/fps/pixel format on both inputs; offsets are computed in `buildTimeline`, not improvised in the filtergraph.
- libass `\k` sweeps `SecondaryColour → PrimaryColour` — for the `pop` preset the accent is *Primary*.
- Pexels: 200 req/h. Pixabay: 100 req/60 s and responses **must** be cached 24 h.
- LLM is **OpenAI GPT only** — no local LLM (owner directive 2026-07-10). Set `OPENAI_API_KEY`; `LLM_PROVIDER=openai`, default `OPENAI_MODEL=gpt-4o-mini`. No Docker; DB is Supabase Cloud.
- SigLIP cosine thresholds are model-specific. Never copy `τ` values across model versions; re-run `pnpm eval:matching`.
