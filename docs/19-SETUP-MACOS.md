# 19 — Setup (macOS, Apple Silicon)

> **Stack change — 2026-07-10:** DB is **Supabase Cloud** — skip Docker/OrbStack and `supabase start`; instead `supabase login --token <pat>`, `supabase link --project-ref <ref>`, then `pnpm db:migrate` (= `supabase db push`) and `pnpm db:types` (= `gen types --linked`). §4 (local DB) does not apply. LLM is **OpenAI GPT only** — skip Ollama (§3 Ollama note n/a); set `OPENAI_API_KEY`.

Target: MacBook Pro M3 Pro, macOS 14+, ≥ 18 GB unified memory, ≥ 25 GB free disk. Everything below is free.

## 1. System dependencies

```bash
# Homebrew packages
brew install ffmpeg-full node@22 pnpm uv espeak-ng git-lfs   # NOTE: ffmpeg-full, not ffmpeg — see below
brew install --cask orbstack            # or Docker Desktop — Supabase local needs a container runtime
brew install supabase/tap/supabase

FF=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg   # ffmpeg-full is keg-only (not symlinked onto PATH)
"$FF" -version | head -1                # 8.x is fine
"$FF" -hide_banner -filters | grep -E 'zoompan|xfade|sidechaincompress|subtitles'  # all four required
"$FF" -hide_banner -encoders | grep videotoolbox                                    # h264_videotoolbox present
```

**libass (updated 2026-07):** the plain Homebrew `ffmpeg` formula no longer bundles
libass, so its `subtitles`/`ass` filters are missing and `brew reinstall ffmpeg`
does **not** restore them. Install **`ffmpeg-full`** (keg-only, bottled) instead and
point the app at it with `FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` in
`.env`. `espeak-ng` is misaki's phonemizer fallback for several Kokoro languages;
install it before touching TTS.

Python **3.12 exactly** (Kokoro's dependency chain does not support 3.13): `uv python install 3.12`.

## 2. Repo

```bash
git clone <repo> scriptreel && cd scriptreel
pnpm install
cd services/ml && uv sync && cd ../..
cp .env.example .env
```

## 3. API keys (all free, ~5 minutes)

| Key | Where | Notes |
|---|---|---|
| `PEXELS_API_KEY` | pexels.com/api → create an app | 200 req/h, 20k/mo |
| `PIXABAY_API_KEY` | pixabay.com/api/docs → sign in, key is on the page | 100 req/60 s |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key | Optional. Free tier only covers Flash/Flash-Lite and its inputs may be used to improve Google's products — set `LLM_PROVIDER=ollama` for anything confidential |

Fully-local alternative: `brew install ollama && ollama serve && ollama pull qwen3:8b`, then `LLM_PROVIDER=ollama`. Beat quality drops somewhat; everything else is identical.

`.env` (root, git-ignored):

```bash
DATA_DIR=./data
SIDECAR_URL=http://127.0.0.1:8484
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<printed by `supabase start`>
PEXELS_API_KEY=…
PIXABAY_API_KEY=…
LLM_PROVIDER=gemini            # gemini | ollama
GEMINI_API_KEY=…
GEMINI_MODEL=gemini-2.5-flash  # verify the current free-tier model id at setup
OLLAMA_MODEL=qwen3:8b
# FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
```

`packages/config/env.ts` zod-validates this at boot and prints every missing/invalid var at once.

## 4. Database

```bash
supabase start                 # first run pulls ~1.5 GB of images
supabase db reset              # applies supabase/migrations/*
pnpm db:types                  # supabase gen types typescript > packages/db/src/types.ts
```
Studio at `http://127.0.0.1:54323`. `supabase stop` when you're done for the day (it keeps the volume).

## 5. Models (~7 GB, one time)

```bash
export HF_HOME="$PWD/data/models"
uv run --directory services/ml python -m scripts.fetch_models
```

`fetch_models.py` downloads and verifies, printing sizes:

| Model | Repo | Size | Used by |
|---|---|---|---|
| Kokoro-82M | `hexgrad/Kokoro-82M` | ~330 MB | TTS |
| SigLIP 2 base | `google/siglip2-base-patch16-224` | ~800 MB | Matching |
| Whisper large-v3-turbo (MLX) | `mlx-community/whisper-large-v3-turbo` | ~1.6 GB | Alignment |
| Whisper small (MLX) | `mlx-community/whisper-small-mlx` | ~480 MB | Alignment fallback |
| FLUX.1-schnell 4-bit | `dhairyashil/FLUX.1-schnell-mflux-4bit` | ~6.5 GB | **Phase 13 only** — skip with `--no-flux` |

Repo ids drift; if a download 404s, search Hugging Face for the current id and update `fetch_models.py` + doc 04 rather than pinning a fork. Extra language data: `make setup-ja` (unidic, ~1 GB) and `uv add "misaki[zh]"` only if you'll narrate Japanese/Chinese.

Fonts (`assets/fonts/`, OFL, committed): Inter, JetBrains Mono, Source Serif 4, Noto Sans (Devanagari, JP, SC). Music (`assets/music/`, CC BY 4.0 from incompetech.com — large, **not committed**): run `python scripts/fetch_music.py` to download the 14 tracks listed in `manifest.json` (attribution in `CREDITS.md`).

## 6. Run

```bash
pnpm dev        # turbo: web :3000 · worker · sidecar :8484
pnpm sidecar    # sidecar alone
pnpm check      # tsc + biome + vitest
```

Then open `http://localhost:3000/settings` — every health card should be green before you generate anything. First TTS call downloads nothing but takes ~10 s to warm Kokoro; use **Warm up** to do it deliberately.

## 7. Verification checklist (Phase 0 exit)

1. `/api/health` returns `ok: true` with `device: "mps"`.
2. `POST /tts` for `af_heart` produces a WAV whose measured duration is within 20% of `words / 2.7`.
3. `POST /embed/image` on the same JPEG twice → cosine similarity > 0.999.
4. `ffmpeg` renders a 3-second black clip with burned-in ASS text using a bundled font.
5. `supabase status` shows API + DB up; `select count(*) from music_tracks` ≥ 12.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `torch` picks CPU | `python -c "import torch;print(torch.backends.mps.is_available())"` → false means a non-arm64 Python. Reinstall via `uv python install 3.12` |
| `unidic` error on Japanese | `make setup-ja` |
| `subtitles` filter not found | FFmpeg without libass — `brew reinstall ffmpeg` |
| VideoToolbox output looks soft | Expected at low bitrates; raise `-b:v`, or `FORCE_X264=1` for an archival A/B (doc 13) |
| Sidecar OOM during FLUX | Close Chrome. `E_GEN_MEM` is the guard; generation is optional (doc 14) |
| Pexels 429 immediately | Another process shares the key, or `provider_usage` is stale — check `/api/quota` |
| Slow first render | Model warmup + cold asset cache. Second run on the same script is ~3× faster (doc 21 benchmarks) |
