# ScriptReel — Setup Guide

Onboarding for a fresh machine. This is the top-level, cross-platform entry point;
`docs/19-SETUP-MACOS.md` is the deeper macOS reference and `docs/00-INDEX.md` maps the
full spec set.

---

## 0. Platform support — read this first

ScriptReel is an **Apple-Silicon-first** local pipeline. The ML sidecar uses **MLX**
(Apple's array framework) for Whisper alignment and the doc-25 vision cascade, and MLX
runs **only on Apple-Silicon Macs** (M1/M2/M3/M4).

| Platform | Web + Worker | ML sidecar (TTS, embeddings, alignment, OCR/identity) |
|---|---|---|
| **macOS (Apple Silicon)** | ✅ supported | ✅ supported — the target platform |
| **macOS (Intel)** | ✅ | ⚠️ no MLX → alignment + VLM won't run; the rest is CPU-slow |
| **Windows 10/11** | ✅ | ❌ `uv sync` fails — `mlx`/`mlx-whisper` have no Windows build |
| **Linux** | ✅ | ❌ same MLX blocker (WSL2 doesn't help — it's x86, not Apple Silicon) |

**What this means in practice:** the Node side (script analysis, provider search, scoring
logic, the whole UI) is fully cross-platform. The **model inference** is not, today,
because MLX is a hard dependency. See **§7 Windows & Linux** for the honest state and what
a real port would take. If your goal is "a teammate on Windows can generate videos," that
needs a code change (making MLX optional + a non-MLX alignment backend) — ask and it can be
scoped as its own task.

---

## 1. What you're installing

Three local processes + a cloud database:

- **web** — Next.js 15 (UI + thin API), port `3000`.
- **worker** — Node 22 (the pipeline: providers, FFmpeg, orchestration).
- **sidecar** — Python 3.12 FastAPI (models only: Kokoro TTS, SigLIP embeddings,
  mlx-whisper alignment, Pillow text cards, + doc-25 Tesseract/InsightFace/DINOv2), port `8484`.
- **Postgres** — Supabase **Cloud** (no local Docker). pg-boss runs the job queue on it.

And **five install layers** — only the first travels cleanly in git:

| Layer | Installed by | In git? |
|---|---|---|
| JS/Node deps | `pnpm install` | lockfile ✅ (`node_modules` rebuilt) |
| Python deps | `uv sync` (in `services/ml`) | `uv.lock` ✅ (exact versions) |
| ML model weights (~3–10 GB) | `make models` + `make identity` | ❌ `data/` is gitignored |
| System binaries (ffmpeg, tesseract…) | Homebrew / winget | ❌ per-machine |
| Secrets (`.env`) | copy `.env.example`, fill keys | ❌ `.env` is gitignored |

> Running `pnpm install` alone gets you **only** the JS layer. The models, Python env,
> binaries, and API keys each need their own step below.

---

## 2. Prerequisites

### macOS (Apple Silicon) — via Homebrew

```bash
# Homebrew itself: https://brew.sh
brew install node@22 pnpm uv git-lfs python@3.12 espeak-ng tesseract
brew install ffmpeg-full        # keg-only, libass-enabled — NOT plain `ffmpeg` (see §8)
```

- **Python must be 3.12** (Kokoro TTS breaks on 3.13).
- `ffmpeg-full` is required — plain `brew install ffmpeg` lacks the `subtitles`/`ass`
  filters and composition will fail. Point `FFMPEG_PATH` at it (see §5).
- `tesseract` powers the doc-25 OCR gate; `espeak-ng` is needed for several non-English voices.

### Windows 10/11 — via winget (+ installers)

> The **web + worker** run fine on Windows. The **sidecar does not install as-is** (MLX,
> §0). Install these to run the Node side and develop the cross-platform code; see §7.

```powershell
winget install OpenJS.NodeJS.LTS        # Node 22 LTS
winget install Python.Python.3.12       # Python 3.12 (NOT 3.13)
winget install astral-sh.uv             # uv (Python package manager)
winget install Git.Git GitHub.GitLFS
winget install Gyan.FFmpeg              # a libass-enabled FFmpeg build
winget install UB-Mannheim.TesseractOCR # Tesseract OCR (add its folder to PATH)
corepack enable pnpm                    # pnpm (ships with Node via corepack)
```

- **espeak-ng**: install the MSI from <https://github.com/espeak-ng/espeak-ng/releases>.
- **FFmpeg**: confirm your build has libass — `ffmpeg -filters | findstr ass` must list the
  `ass`/`subtitles` filters. Set `FFMPEG_PATH` to the full `ffmpeg.exe` path (§5).
- **`make` is not on Windows** — use the raw commands shown in §3/§6 instead of `make …`.

---

## 3. Get the code + install dependencies

```bash
git clone <your-repo-url> ScriptReel
cd ScriptReel
```

**macOS (one-liner):**
```bash
make setup        # = pnpm install + (cd services/ml && uv sync) + cp .env.example .env
```

**Windows (equivalent, no make):**
```powershell
pnpm install
cd services/ml; uv sync; cd ..
copy .env.example .env
```

> On Windows, `uv sync` will error trying to resolve `mlx`/`mlx-whisper`. That is the §0
> limitation — the Node side still works; the sidecar does not.

---

## 4. Configure `.env`

Copy `.env.example` → `.env` (done by `make setup`) and fill it in:

| Variable | What it is | Where to get it |
|---|---|---|
| `OPENAI_API_KEY` | GPT for script analysis (the **only** cloud call) | platform.openai.com |
| `OPENAI_MODEL` | default `gpt-4o` | — |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key | Supabase → Settings → API |
| `DATABASE_URL` | **Session pooler** conn string (`:5432`, NOT `:6543`) | Supabase → Settings → Database |
| `PEXELS_API_KEY` | stock video/photo | pexels.com/api |
| `PIXABAY_API_KEY` | stock video/photo | pixabay.com/api/docs |
| `FFMPEG_PATH` | absolute path to the libass FFmpeg | `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` (mac) / `…\ffmpeg.exe` (win) |
| `DATA_DIR` | media + models + renders root | default `./data` |
| `SIDECAR_URL` | sidecar address | default `http://127.0.0.1:8484` |

- `DATABASE_URL` **must** be the session pooler (`:5432`) — pg-boss needs session mode.
- Optional archive-provider keys (Flickr, Europeana, Smithsonian — doc 25) are entered in
  the app's **Settings → API keys** UI, not in `.env`.

---

## 5. Download the models

Weights are **not** in git (`data/` is gitignored) — fetch them per machine. They land in
`data/models` (+ `~/.insightface` for the face model), where the sidecar looks.

**macOS:**
```bash
make models          # Kokoro + SigLIP + Whisper (~3 GB; add --no-flux is default-safe)
make identity        # doc-25 cascade: DINOv2 + InsightFace buffalo_l (~400 MB)
```

**Windows** (if/when the sidecar is portable — §7):
```powershell
cd services/ml
uv run python -m scripts.fetch_models            # base models
uv run python -m scripts.fetch_models --identity # identity models
```

- `make models` also fetches the optional **FLUX** image model (~6.5 GB, Phase 13). Skip it
  with `uv run … fetch_models --no-flux`.
- **buffalo_l (InsightFace) is non-commercial-research licensed** — fine for development;
  swap to a permissive face model before any commercial use (doc 25 §6).

---

## 6. Database + run

```bash
make db              # pnpm db:migrate (push migrations to Supabase Cloud) + db:types
# Windows: pnpm db:migrate ; pnpm db:types

pnpm dev             # web :3000 + worker + sidecar (turbo)
```

Open <http://localhost:3000/settings> — every health card should be green. Create a project,
paste a script, and generate.

> **Never run two workers** against the same Supabase project — the session pooler caps at
> ~15 connections and the web + worker pools already share that budget (see §8).

---

## 7. Windows & Linux — current limitations (honest state)

The blocker is **MLX**. `services/ml/pyproject.toml` lists `mlx` and `mlx-whisper` as
unconditional dependencies, and:

- MLX ships wheels **only for Apple Silicon**, so `uv sync` cannot even resolve the
  environment on Windows/Linux.
- `services/ml/app/align.py` (forced subtitle alignment) is mlx-whisper.
- The doc-25 **Step 7** VLM cascade will use Qwen2.5-VL via MLX.

**What works today on Windows/Linux:** the web app and worker — script analysis (GPT),
provider search, the scoring/selection logic, and the UI. Everything that doesn't call the
sidecar.

**What does not:** TTS, SigLIP embeddings, Whisper alignment, and the OCR/identity gates —
i.e. you can't render a finished video without the sidecar.

**What a real cross-platform port needs** (a code change, not just setup):
1. Make `mlx`/`mlx-whisper` **optional** via platform markers
   (`sys_platform == 'darwin' and platform_machine == 'arm64'`).
2. Add a **non-MLX alignment backend** (e.g. `faster-whisper`) selected at runtime.
3. Provide a **non-MLX VLM** path for the doc-25 cascade (or let it degrade — the cascade is
   already built to skip when its model is absent).
4. Verify Kokoro / SigLIP / InsightFace / DINOv2 on CUDA or CPU (they're torch/onnx — should
   work, but untested here).

This is a well-defined task if cross-platform inference becomes a requirement — it just
hasn't been done because the project targets one machine (an M3 Pro). The degrade-never-die
design already means a missing model warns instead of crashing, which is most of the way to
graceful non-Apple behavior.

---

## 8. Troubleshooting (the sharp edges)

- **`subtitles`/`ass` filter not found / composition fails** → your FFmpeg lacks libass.
  Install `ffmpeg-full` (mac) or a Gyan "full" build (win) and set `FFMPEG_PATH`. Verify:
  `"$FFMPEG_PATH" -filters | grep -i ass`.
- **TTS crashes / Kokoro import error** → you're on Python 3.13. Use **3.12**.
- **A fetched model isn't found by the sidecar** → `HF_HOME` mismatch. `make models`/`make
  identity` set `HF_HOME=$PWD/data/models` and `fetch_models.py` defaults to the same, so
  weights land where the sidecar looks. If you fetched manually, export
  `HF_HOME="$PWD/data/models"` first.
- **Worker dies mid-run / "too many connections"** → the Supabase session pooler caps ~15
  clients; web + worker pools must sum under it. Don't run two workers.
- **Tesseract "not installed" (OCR gate skipped)** → the binary isn't on `PATH`. The gate
  degrades silently (by design) until `tesseract --version` works.
- **Sidecar stuck at 0% after hours** → a wedged long-lived sidecar; restart `pnpm sidecar`.
- **`uv sync` fails on `mlx`** → you're not on Apple Silicon. See §7.

---

## Quick reference — fresh Apple-Silicon Mac, start to finish

```bash
brew install node@22 pnpm uv git-lfs python@3.12 espeak-ng tesseract ffmpeg-full
git clone <repo> ScriptReel && cd ScriptReel
make setup                       # deps + .env
$EDITOR .env                     # add OPENAI/PEXELS/PIXABAY keys + DATABASE_URL
make models && make identity     # ~3.5 GB of weights
make db                          # migrations + types
pnpm dev                         # → http://localhost:3000
```
