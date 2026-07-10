# 03 — Architecture

## Processes (all local on the M3 Pro)

```
┌─────────────────────────────────────────────────────────────────┐
│  MacBook Pro (M3 Pro, Apple Silicon)                            │
│                                                                  │
│  ┌──────────────┐   HTTP    ┌───────────────────────────────┐   │
│  │ apps/web     │──────────▶│ Supabase local stack (Docker) │   │
│  │ Next.js 15   │  supabase │  Postgres · Realtime · Studio │   │
│  │ :3000        │◀──────────│  :54321 (API) :54322 (DB)     │   │
│  └──────┬───────┘  realtime └───────────────▲───────────────┘   │
│         │ REST (enqueue, review actions)    │ pg-boss jobs      │
│         ▼                                   │ + row updates     │
│  ┌──────────────────────────────────────────┴─────┐             │
│  │ apps/worker — Node 22 / TypeScript             │             │
│  │ pg-boss consumer · pipeline state machine ·    │             │
│  │ provider clients + rate limiter · FFmpeg driver│             │
│  └───────┬──────────────────────────┬─────────────┘             │
│          │ HTTP :8484               │ spawn (execa)             │
│          ▼                          ▼                           │
│  ┌───────────────────┐      ┌──────────────┐                    │
│  │ services/ml       │      │ FFmpeg 7     │                    │
│  │ Python 3.12       │      │ VideoToolbox │                    │
│  │ FastAPI sidecar   │      └──────────────┘                    │
│  │ MPS/MLX models:   │                                          │
│  │ Kokoro · SigLIP2 ·│      ┌──────────────────────────┐        │
│  │ mlx-whisper ·     │      │ DATA_DIR (local disk)    │        │
│  │ Pillow textcards ·│      │ projects/ cache/ models/ │        │
│  │ (FLUX-schnell P13)│      │ renders inside projects/ │        │
│  └───────────────────┘      └──────────────────────────┘        │
│                                                                  │
│  External (only these): Pexels API · Pixabay API ·               │
│  Gemini API (optional; Ollama :11434 is the local alternative)   │
└─────────────────────────────────────────────────────────────────┘
```

Three long-lived processes started by `pnpm dev` (Turborepo): **web**, **worker**, **sidecar** (uvicorn via a package.json script wrapping `uv run`). Supabase runs via `supabase start`.

## Responsibilities

| Component | Owns | Never does |
|---|---|---|
| **web** (Next.js) | UI, REST routes, zod validation, enqueue jobs, serve renders/thumbnails from DATA_DIR via streaming route, realtime subscription client | Long-running work, FFmpeg, model inference |
| **worker** (Node) | Pipeline state machine, all provider HTTP + quota accounting, asset download/normalize, timeline building, FFmpeg orchestration, writing all pipeline rows | UI, direct model math |
| **sidecar** (Python) | Model inference only: TTS, forced alignment, text/image embeddings, text-card rendering, (image generation P13). Stateless: paths in → paths/JSON out | DB access, provider APIs, business logic |
| **Supabase local** | Postgres (app schema + pg-boss schema), Realtime broadcast of `pipeline_runs`/`projects` changes, Studio for inspection | Storage of media (media lives on disk) |

## Data flow for one generation

1. Web `POST /api/projects/:id/generate` → inserts `pipeline_runs` rows (all stages, `pending`) → `pgboss.send('pipeline', {projectId})`.
2. Worker picks job, walks stages `analyze → search → score → [review gate] → tts → align → fetch → compose` (doc 06). Each stage: read inputs from DB/disk → call sidecar and/or providers → write outputs to DB + `DATA_DIR/projects/{id}/stages/{stage}/` → update its `pipeline_runs` row (progress 0–100).
3. UI receives realtime row updates; on `awaiting_review`, storyboard unlocks; `POST .../continue` re-enqueues.
4. `compose` writes MP4 + credits.txt into `DATA_DIR/projects/{id}/renders/{renderId}/`, inserts `renders` row → UI shows player.

## The two seams (future-proofing, do not violate)

1. **Timeline JSON (doc 12)** between brain and renderer. Enables: manual-edit UI later, cloud renderer later, re-render without re-analysis now.
2. **Sidecar HTTP API (doc 14)** between orchestration and ML. Enables: swapping Kokoro→ElevenLabs, SigLIP→cloud embeddings, local→GPU-server, without touching the worker beyond an adapter. Every sidecar capability is behind a worker-side interface (`TtsEngine`, `Embedder`, `Aligner`, `ImageGen`) in `packages/core`.

Similarly, media providers implement one interface (`MediaProvider`, doc 08) and the LLM sits behind `ScriptAnalyzer` with `GeminiAnalyzer` and `OllamaAnalyzer` implementations (doc 07).

## DATA_DIR layout

```
data/
├── projects/{projectId}/
│   ├── stages/{analyze|search|score|tts|align|fetch|compose}/manifest.json (+ stage artifacts)
│   ├── audio/beats/{beatIdx}.wav · vo.wav
│   ├── subs/subs.ass · words.json
│   ├── clips/{beatIdx}.mp4          # normalized per-beat visuals
│   ├── timeline.json
│   └── renders/{renderId}/final.mp4 · credits.txt · thumbnail.jpg
├── cache/
│   ├── search/{provider}/{sha1(normalized query+params)}.json   # 24h TTL
│   ├── assets/{provider}/{providerId}.{mp4|jpg}                 # content-addressed originals
│   ├── thumbs/{provider}/{providerId}.jpg
│   └── voice-samples/{voiceId}.wav
└── models/        # HF_HOME target; Kokoro, SigLIP2, whisper, (FLUX)
```

## Configuration

Single `.env` at repo root, loaded and zod-validated in `packages/config/env.ts` (fail fast with a readable list of missing vars). Keys: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATA_DIR`, `SIDECAR_URL`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `LLM_PROVIDER=gemini|ollama`, `GEMINI_API_KEY?`, `GEMINI_MODEL`, `OLLAMA_MODEL`, `FFMPEG_PATH?`.
