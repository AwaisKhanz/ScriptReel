# 04 — Tech Stack (LOCKED)

Pin exact minor versions in Phase 0 (`pnpm add`, `uv add`) and record them here in a `## Pinned` appendix. Verify each model's HF repo id at setup time (doc 19) — repo ids occasionally move.

## Application

| Layer | Choice | License | Why |
|---|---|---|---|
| Web framework | Next.js 15 (App Router) + React 19 | MIT | Owner's standard stack |
| Language | TypeScript 5.x, `strict` everywhere | — | Doc 18 |
| Styling | Tailwind CSS v4 (`@theme` tokens) + shadcn/ui | MIT | Doc 17 |
| State/data | TanStack Query v5 + Supabase Realtime; react-hook-form + zod | MIT | Standard |
| Monorepo | pnpm workspaces + Turborepo | MIT | Owner's pattern |
| Worker runtime | Node 22 LTS | MIT | Native fetch, stable streams |
| Job queue | **pg-boss v10** on Supabase Postgres | MIT | No Redis; retries, backoff, singleton jobs; fits stack |
| DB/platform | **Supabase local stack** (Postgres 15, Realtime, Studio) via Docker | Apache-2.0 | Free, unlimited, offline; cloud path later |
| Process spawn | execa | MIT | FFmpeg driving |
| Logging | pino (worker) / console-structured (web) | MIT | Doc 18 |
| Media probe | ffprobe (bundled with FFmpeg) | LGPL/GPL | Asset metadata |
| Image ops (Node) | sharp | Apache-2.0 | Thumbnail resize before embedding |

## AI / media pipeline

| Capability | Choice | License | Notes |
|---|---|---|---|
| Script analysis LLM | **Gemini Flash free tier** (primary for dev) behind `ScriptAnalyzer` interface; **Ollama** (`qwen3:8b` default) as fully-local alternative | API ToS / Apache-2.0 (Qwen) | Free tier data may be used for training and limits shift — check live docs; commercial launch = paid Tier 1 or Ollama. 1–3 calls per video |
| TTS | **Kokoro-82M** via `kokoro` PyPI + misaki G2P, in sidecar | **Apache-2.0** | 54 voices, 9 language variants, CPU-fast, best free narration quality in class. Python 3.10–3.12 only; ja needs `unidic` download (~1 GB); zh needs misaki[zh] |
| Semantic matching | **SigLIP 2 base** (`google/siglip2-base-patch16-224`) via transformers on **MPS** | Apache-2.0 | Text↔image similarity for candidate ranking + near-dup detection |
| Forced alignment | **mlx-whisper** (`mlx-community/whisper-large-v3-turbo`; `-small` fallback) word timestamps, token-aligned to known script | MIT (MLX) / MIT (Whisper) | Metal-fast on M3 Pro; we align, not transcribe (doc 11) |
| Image gen fallback (P13) | **FLUX.1-schnell** 4-bit via **mflux** (MLX) | Apache-2.0 | Only Apache-licensed high-quality option; SDXL-Turbo rejected (non-commercial license) |
| Text cards | Pillow in sidecar, brand-templated PNG @2× | MIT-CMU | Fallback ladder terminal |
| Composition | **FFmpeg 7** (brew: includes libass, zimg) | LGPL/GPL | The renderer. `h264_videotoolbox` hw encode; `libx264` quality fallback |
| Subtitles | ASS (libass burn-in), Noto fonts bundled | OFL fonts | Doc 11 |

## Media & audio sources

| Source | Use | Terms that bind us |
|---|---|---|
| **Pexels API** | Videos + photos, primary | 200 req/h, 20k/mo; cache ~24 h; show credit in UI; free unlimited upgrade available with attribution proof |
| **Pixabay API** | Videos + photos + illustrations, primary | 100 req/60 s; **must** cache responses 24 h; show source when displaying results; download assets, don't hotlink |
| Bundled music | **FreePD.com** CC0 tracks (12–18, mood-tagged, committed to `assets/music/`) + user upload | CC0 — no obligations; credits still listed |
| Later (optional providers) | Openverse (images/audio), Wikimedia Commons, NASA Images | Per-asset license inspection required — out of v1 |

## Python sidecar

Python **3.12** (hard requirement — Kokoro deps don't support 3.13), managed with **uv**. FastAPI + uvicorn. torch (MPS build), transformers, mlx, mlx-whisper, kokoro, misaki[en,ja,zh], soundfile, Pillow, numpy<2 where required.

## Rejected alternatives (do not revisit without new evidence)

- **Remotion** (license terms), **editly** (unmaintained) → plain FFmpeg + timeline JSON.
- **Edge TTS** (unofficial API, product risk), **Piper** (quality/licensing of active fork), **XTTS v2** (non-commercial), **Chatterbox** (kept as optional premium-voice module later; heavier 0.5B) → Kokoro.
- **Transformers.js/ONNX in Node for CLIP/whisper** → CPU-only in practice; MPS sidecar is ~an order faster and required for FLUX anyway.
- **Redis/BullMQ** → pg-boss on existing Postgres.
- **Supabase cloud free tier for renders** → 1 GB storage dies immediately; local disk.
- **SDXL-Turbo** → non-commercial license.
