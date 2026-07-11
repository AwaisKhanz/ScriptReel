# ScriptReel

**Paste a script, get a finished video** — relevant B-roll, a natural voiceover, word-synced
subtitles, and background music, cut to your narration. Runs entirely on an Apple-Silicon Mac
(M3 Pro) using free and open components. **$0 per render.**

What makes the videos good is the **matching engine**: an LLM writes a *visual description* per
beat, queries fan out to Pexels + Pixabay, a CLIP-family model (SigLIP 2) re-ranks the candidates,
and an explicit fallback ladder (broaden → conceptual → mood → generated → styled text card) means
a good abstract match always beats a wrong literal one — and it never hard-fails.

- 9 languages · 54 Kokoro voices · 3 aspect ratios (16:9 / 9:16 / 1:1) · Draft 720p / Final 1080p
- Storyboard review: swap any beat's clip or re-search it before rendering
- Cheap re-render when only subtitles / music / quality change (compose-only)

## 60-second start

Prerequisites (Homebrew, one time — see [docs/19-SETUP-MACOS.md](docs/19-SETUP-MACOS.md)):

```bash
brew install ffmpeg-full node@22 pnpm uv espeak-ng git-lfs   # ffmpeg-full, not ffmpeg (needs libass)
uv python install 3.12                                        # Kokoro needs 3.12 exactly
```

Then:

```bash
git clone <repo> scriptreel && cd scriptreel
make setup                 # pnpm install + uv sync + create .env
# → fill .env: OPENAI_API_KEY, PEXELS_API_KEY, PIXABAY_API_KEY, DATABASE_URL (Supabase Cloud),
#   FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
make db                    # push migrations to Supabase Cloud + regenerate types
make models                # download ML models (~7 GB) — add --no-flux to skip the optional image model
make music                 # download the 14 CC BY 4.0 music tracks
pnpm dev                   # web :3000 · worker · sidecar :8484
```

Open **http://localhost:3000/settings** — every health card should be green before you generate.
`make help` lists every target.

## Architecture

Three local processes:

- **web** (Next.js 15) — the UI and thin API routes; never calls an AI or FFmpeg
- **worker** (Node 22) — the pipeline, providers, and FFmpeg; owns all heavy work
- **sidecar** (Python 3.12, FastAPI) — models only: Kokoro TTS, SigLIP 2 embeddings, mlx-whisper
  alignment, Pillow text cards, optional FLUX image generation

State is Postgres (**Supabase Cloud**); jobs run on pg-boss; media and renders live on disk under
`DATA_DIR`. The pipeline stages are `analyze → search → score → [review gate] → tts → align →
fetch → compose`. Each stage is idempotent and resumable; `timeline.json` is the only contract
between the "brain" and the renderer.

## Stack

| Area | Choice |
|---|---|
| LLM (beat analysis) | **OpenAI GPT** (`gpt-4o-mini`) |
| TTS | Kokoro-82M (Apache-2.0) |
| Matching | SigLIP 2 base, MPS |
| Alignment | mlx-whisper large-v3-turbo |
| Encode | FFmpeg (`ffmpeg-full`, libass) · `h264_videotoolbox` |
| Image fallback (optional) | FLUX.1-schnell 4-bit via mflux (Apache-2.0) |
| DB / jobs | Supabase Cloud (Postgres 17) · pg-boss |

## Attribution & licenses

The app writes a `credits.txt` next to every render listing each source. Bundled/third-party assets:

- **Stock media** — Pexels & Pixabay, per their licenses; each clip's author + page URL is recorded
  in the render's credits.
- **Music** — 14 tracks by **Kevin MacLeod** (incompetech.com), **CC BY 4.0**; attribution in
  [assets/music/CREDITS.md](assets/music/CREDITS.md) and in every render's credits.
- **Voices** — Kokoro-82M, Apache-2.0.
- **Fonts** (`assets/fonts/`) — Inter, JetBrains Mono, Source Serif 4, Noto Sans — SIL OFL.
- **Image fallback** — FLUX.1-schnell, Apache-2.0 (optional, Phase 13).

Project code: see the repository license. Full risk/budget/license notes: [docs/22](docs/22-RISKS-LIMITS-LICENSES.md).

## Docs

Specs live in [`docs/`](docs/) — start with [docs/00-INDEX.md](docs/00-INDEX.md). Contributor rules
are in [CLAUDE.md](CLAUDE.md).
