# ScriptReel — Setup Guide

Onboarding for a fresh machine. This is the top-level, cross-platform entry point;
`docs/19-SETUP-MACOS.md` is the deeper macOS reference and `docs/00-INDEX.md` maps the
full spec set.

---

## 0. Platform support — read this first

ScriptReel is **Apple-Silicon-first** but **cross-platform** — every pipeline step runs on
Windows, Linux, and Intel Macs using a platform-appropriate backend rather than being skipped.
Most of it (SigLIP matching, Kokoro TTS, OCR, InsightFace, DINOv2) is torch/onnx and identical
everywhere. Three steps swap backend by platform — Apple uses MLX; elsewhere uses a native tool:

| Step | Apple Silicon | Windows / Linux / Intel Mac |
|---|---|---|
| Alignment (word timings) | mlx-whisper (MLX) | **faster-whisper** (CTranslate2) |
| VLM checklist (doc 25 §5-D) | Qwen2.5-VL via **mlx-vlm** | Qwen2.5-VL via **Ollama** (or LM Studio) |
| Generative fallback (abstract beats) | FLUX via **mflux** (MLX) | **SDXL-Turbo** via diffusers (CUDA) |

| Platform | Web + Worker | ML sidecar | VLM check | Image-gen fallback |
|---|---|---|---|---|
| **macOS (Apple Silicon)** | ✅ | ✅ full — the target platform | ✅ mlx-vlm | ✅ FLUX (mflux) |
| **macOS (Intel)** | ✅ | ✅ (faster-whisper) | ✅ Ollama | ❌ → text card (no CUDA) |
| **Windows 10/11** | ✅ | ✅ (faster-whisper) | ✅ Ollama | ✅ SDXL-Turbo (CUDA GPU) |
| **Linux** | ✅ | ✅ (faster-whisper) | ✅ Ollama | ✅ SDXL-Turbo (CUDA GPU) |

**Every platform renders a complete video with the full verification cascade** — real footage
matched by SigLIP, natural TTS, word-synced subtitles, and OCR + identity + VLM checks. Off Apple
the VLM step talks to a local **Ollama** server (one-time `ollama pull qwen2.5vl:3b`, see §7); if
Ollama isn't running the gate degrades cleanly. The generative fallback (for abstract beats with no
stock/archive match) runs **FLUX** on Apple and **SDXL-Turbo** on a CUDA GPU elsewhere — without a
GPU those beats fall back to a styled text card (the pipeline's designed final fallback).

---

## 1. What you're installing

Three local processes + a cloud database:

- **web** — Next.js 15 (UI + thin API), port `3000`.
- **worker** — Node 22 (the pipeline: providers, FFmpeg, orchestration).
- **sidecar** — Python 3.12 FastAPI (models only: Kokoro TTS, SigLIP embeddings, mlx-whisper
  alignment, Pillow text cards, + doc-25 Tesseract OCR / InsightFace / DINOv2 / Qwen2.5-VL), port `8484`.
- **gen** — `services/gen`, an *isolated* Python venv for FLUX.1-schnell image generation
  (doc-25 cascade E); the worker shells out to it. Separate because it needs `numpy≥2` while
  the sidecar needs `numpy<2`.
- **Postgres** — Supabase **Cloud** (no local Docker). pg-boss runs the job queue on it.

And **five install layers** — only the first travels cleanly in git:

| Layer | Installed by | In git? |
|---|---|---|
| JS/Node deps | `pnpm install` | lockfile ✅ (`node_modules` rebuilt) |
| Python deps | `uv sync` in `services/ml` (+ `services/gen`) | `uv.lock` ✅ (exact versions) |
| ML model weights (~3–12 GB) | `make models` / `identity` / `vlm` / `fetch-gen` | ❌ `data/` is gitignored |
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

> Windows runs the **full** pipeline. The VLM checklist runs through Ollama (below) instead of
> MLX; only FLUX image generation is still Apple-only (abstract beats → text card). These are the
> prerequisites; the complete Windows walkthrough is **§7**.

```powershell
winget install OpenJS.NodeJS.LTS        # Node 22 LTS
winget install Python.Python.3.12       # Python 3.12 (NOT 3.13)
winget install astral-sh.uv             # uv (Python package manager)
winget install Git.Git GitHub.GitLFS
winget install Gyan.FFmpeg              # a libass-enabled FFmpeg build
winget install UB-Mannheim.TesseractOCR # Tesseract OCR (see PATH note below)
winget install Ollama.Ollama            # local VLM server (Qwen2.5-VL) — the VLM checklist step
corepack enable pnpm                    # pnpm (ships with Node via corepack)
```

- **espeak-ng**: install the MSI from <https://github.com/espeak-ng/espeak-ng/releases>.
- **FFmpeg**: confirm your build has libass — `ffmpeg -filters | findstr ass` must list the
  `ass`/`subtitles` filters. Set `FFMPEG_PATH` to the full `ffmpeg.exe` path (§5).
- **Tesseract PATH**: the UB-Mannheim installer usually does **not** add tesseract to PATH, so
  the OCR gate reports `E_OCR_UNAVAILABLE` (it degrades — video still renders — but the gate is
  skipped). Fix it either way: tick *"Add to PATH"* during install, **or** set
  `TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe` in `.env`. Verify with
  `tesseract --version`.
- **Ollama (VLM checklist)**: after install, pull the vision model once —
  `ollama pull qwen2.5vl:3b`. Ollama auto-starts a server on `http://localhost:11434`; the
  sidecar finds it automatically (override with `VLM_BASE_URL` / `VLM_REMOTE_MODEL` in `.env`, or
  point at LM Studio). If Ollama isn't running the VLM gate degrades cleanly — the video still
  renders, just without the extra double-check.
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

> On Windows/Linux, `uv sync` skips the MLX packages and installs the cross-platform models
> (SigLIP, Kokoro, faster-whisper, OCR, InsightFace, DINOv2). Full walkthrough: **§7**.

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

## 5. Download the models (macOS / Apple Silicon)

Weights are **not** in git (`data/` is gitignored) — fetch them per machine. They land in
`data/models` (+ `~/.insightface` for the face model), where the sidecar looks. Each is
optional and the pipeline **degrades gracefully** until you fetch it, so install what you need.

```bash
make models          # REQUIRED core: Kokoro TTS + SigLIP + Whisper (~3 GB)
make identity        # doc-25 cascade C: DINOv2 + InsightFace buffalo_l (~400 MB)
make vlm             # doc-25 cascade D: Qwen2.5-VL-3B 4-bit checklist (~2.2 GB)
make gen-setup       # doc-25 cascade E: install the ISOLATED FLUX venv (services/gen)
make fetch-gen       # doc-25 cascade E: FLUX.1-schnell 4-bit for abstract beats (~6.5 GB)
```

- **`make models`** is the only *required* download (TTS + the SigLIP matching model). Without
  the others the OCR/identity/VLM gates and the generative fallback simply don't run — the
  pipeline still produces a video (text-card fallback for abstract beats).
- The OCR gate also needs the **tesseract binary** (`brew install tesseract`, §2) — no model
  download, but the gate is skipped until it's on `PATH`.
- **buffalo_l (InsightFace) is non-commercial-research licensed** — fine for development;
  swap to a permissive face model before any commercial use (doc 25 §6).
- `services/gen` (FLUX) is a **separate isolated venv** because it needs `numpy≥2`/`torch≥2.7`
  that conflict with the sidecar's `numpy<2`; the worker shells out to it. Also **Apple-Silicon
  only** (mflux is MLX-based).

> **Windows/Linux:** use the commands in **§7.3** — `make` isn't available, and the alignment
> model is faster-whisper instead of mlx-whisper. `make models`/`identity` work; the VLM runs via
> **Ollama** there (not `make vlm`, which fetches the Apple-only MLX weights), and only `gen`
> (FLUX) is Apple-only.

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

## 7. Windows / Linux — step by step (supported)

**Read first — what works and what doesn't.** Windows/Linux **generate finished videos with the
full verification cascade.** The MLX packages (Apple-only) are platform-gated, so `uv sync`
installs the cross-platform stack instead: **SigLIP** (matching), **Kokoro** (TTS),
**faster-whisper** (alignment / word-synced subtitles), **OCR** (Tesseract), **InsightFace +
DINOv2** (identity), and the **Qwen2.5-VL checklist via Ollama** (§7.4). The one step that stays
Apple-only:

- **FLUX generation** for abstract beats — off; those beats fall back to a styled **text card**
  (the pipeline's designed final fallback anyway).

So a Windows render = real footage matched by SigLIP, natural TTS, word-synced subtitles, and the
full OCR + identity + VLM verification — identical to a Mac except that abstract beats with no
match get a text card instead of a FLUX-generated image.

### 7.1 Install the prerequisites (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS         # Node 22 LTS
winget install Python.Python.3.12        # Python 3.12 (NOT 3.13)
winget install astral-sh.uv              # uv
winget install Git.Git GitHub.GitLFS
winget install Gyan.FFmpeg               # libass-enabled FFmpeg build
winget install UB-Mannheim.TesseractOCR  # OCR binary (add its folder to PATH)
corepack enable pnpm                     # pnpm (ships with Node)
```

**⚠️ Then CLOSE and REOPEN PowerShell** — `uv`, `ffmpeg`, and Node all modify PATH and the
change doesn't apply to the current shell (this is why `corepack` reports "not recognized").

Two known winget gotchas:
- **Node version.** `OpenJS.NodeJS.LTS` now installs **Node 24**, but this project targets
  **Node 22**. Node 24 + Next.js 15 is untested — pin 22 with **nvm-windows** to be safe:
  ```powershell
  winget install CoreyButler.NVMforWindows   # then reopen the shell
  nvm install 22.14.0
  nvm use 22.14.0
  ```
  (If a prior Node install fails with exit code `1603`, it's because one already exists — check
  `node -v`; if it's ≥22 you're fine, otherwise use nvm-windows above.)
- **pnpm.** If `corepack enable pnpm` still says "not recognized" after reopening the shell,
  install it directly: `npm install -g pnpm` (npm ships with Node).

Verify (in a fresh shell): `node -v` (v22.x), `pnpm -v`, `uv --version`,
`ffmpeg -filters | findstr ass` (must list the `ass`/`subtitles` filters).

### 7.2 Install dependencies (JS + Python)

```powershell
cd ScriptReel
pnpm install                     # JS deps for web + worker
cd services\ml
uv sync                          # ✅ now succeeds — installs the cross-platform models (no MLX)
cd ..\..
copy .env.example .env           # then fill it in (§4): OPENAI/PEXELS/PIXABAY keys + DATABASE_URL
```

`uv sync` will build a few native packages (torch, onnxruntime) — that needs the **Microsoft
Visual C++ Build Tools** if it errors on a missing compiler: `winget install
Microsoft.VisualStudio.2022.BuildTools` (select "Desktop development with C++"), then re-run.

> **After every `git pull`, re-run `uv sync`.** It prunes any stale Apple-only MLX packages an
> earlier install may have left behind (those crash on import on Windows) and picks up new deps
> like `httpx` for the Ollama VLM backend.

### 7.3 Download the models

`make` isn't on Windows, so call the fetch script directly (it puts weights in `data\models`):

```powershell
cd services\ml
uv run python -m scripts.fetch_models              # Kokoro TTS + SigLIP + faster-whisper (~1.3 GB) — REQUIRED
uv run python -m scripts.fetch_models --identity   # DINOv2 + InsightFace (~400 MB) — optional, runs on Windows
cd ..\..
```

Don't run `--vlm` here — that fetches the Apple-only MLX weights. On Windows the VLM step runs
through **Ollama** instead (§7.4). And `winget install UB-Mannheim.TesseractOCR` if you didn't in
§7.1 (the OCR gate needs the `tesseract` binary on PATH, or `TESSERACT_CMD` set — §2).

**Generative fallback (optional, needs an NVIDIA GPU).** Abstract beats with no stock/archive
match get an SDXL-Turbo image (Apple uses FLUX). This is a separate isolated venv:

```powershell
cd services\gen
uv sync                             # installs diffusers + a CUDA-12.8 torch build (Blackwell-ready)
uv run python -m gen --download     # SDXL-Turbo (~6.5 GB) → data\models
uv run python -m gen --check        # expect "OK gen ready (diffusers / stabilityai/sdxl-turbo)"
cd ..\..
```

If `--check` says *CUDA not available*, your torch isn't seeing the GPU — reinstall the cu128
build: `uv pip install --python .venv torch --index-url https://download.pytorch.org/whl/cu128`.
Without a working GPU the fallback degrades cleanly to a text card.

### 7.4 Set up the VLM checklist (Ollama)

The doc-25 VLM double-check runs Qwen2.5-VL through a local **Ollama** server on Windows/Linux —
the same model family the Mac runs via MLX, so no pipeline step is skipped. One-time:

```powershell
ollama pull qwen2.5vl:3b         # ~3.2 GB; Ollama auto-runs a server on http://localhost:11434
```

The sidecar finds `localhost:11434` automatically — nothing to configure. To use **LM Studio** or
a different model instead, set `VLM_BASE_URL` / `VLM_REMOTE_MODEL` in `.env`. If Ollama isn't
running the VLM gate degrades cleanly (the render still completes, just without the extra check).

> **Optional — run the LLM steps locally too.** Analyze, knowledge expansion, and media-fit
> verification default to OpenAI, but can run on Ollama instead: pull the models
> (`ollama pull qwen3:14b` for text + reuse `qwen2.5vl` for vision) and set `LLM_PROVIDER=ollama`
> in `.env` (defaults: `OLLAMA_MODEL=qwen3:14b`, `OLLAMA_VISION_MODEL=qwen2.5vl:7b`). Fully local,
> no OpenAI key needed. Reasoning models (deepseek-r1) are a poor fit — they're noisy for the
> structured JSON the analyzer needs.

### 7.5 Migrate the DB and run

```powershell
pnpm db:migrate                  # push migrations to Supabase Cloud
pnpm db:types
pnpm dev                         # web :3000 + worker + sidecar (:8484)
```

Open <http://localhost:3000/settings> — the sidecar card should be **green** (SigLIP, Kokoro,
faster-whisper, OCR, InsightFace, DINOv2). With Ollama running and `qwen2.5vl:3b` pulled (§7.4),
the VLM check is live too. Create a project, paste a script, and generate a real video.

> **First render is slower on Windows:** faster-whisper alignment runs on CPU (int8). If it's
> too slow, set a smaller model — `setx FASTER_WHISPER_MODEL Systran/faster-whisper-tiny` — or,
> with an NVIDIA GPU, `setx FASTER_WHISPER_DEVICE cuda` (needs the CUDA build of CTranslate2).

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
  degrades silently (by design) until `tesseract --version` works, or set `TESSERACT_CMD` (§2).
- **VLM check unavailable / cold (Windows/Linux)** → start Ollama and pull the model:
  `ollama pull qwen2.5vl:3b`. The sidecar re-probes every run, so no restart is needed; it
  degrades cleanly when absent. Set `VLM_BASE_URL` to use LM Studio or a remote server instead.
- **`mlx.core` DLL / "no Stream(gpu,1)" on Windows** → a stale Apple-only MLX package in the venv;
  the code no longer selects it, but `uv sync` after a `git pull` removes it for good.
- **Sidecar stuck at 0% after hours** → a wedged long-lived sidecar; restart `pnpm sidecar`.
- **`uv sync` fails building torch/onnxruntime on Windows** → install the MSVC C++ Build Tools
  (§7.2), then re-run. (MLX is auto-skipped off Apple Silicon — that's expected, not an error.)
- **Windows render is slow / no word-synced subtitles** → faster-whisper is CPU int8; use a
  smaller `FASTER_WHISPER_MODEL` (e.g. `Systran/faster-whisper-tiny`) or a CUDA GPU (§7.5).

---

## Quick reference — fresh Apple-Silicon Mac, start to finish

```bash
brew install node@22 pnpm uv git-lfs python@3.12 espeak-ng tesseract ffmpeg-full
git clone <repo> ScriptReel && cd ScriptReel
make setup                       # pnpm install + uv sync + .env
$EDITOR .env                     # add OPENAI/PEXELS/PIXABAY keys + DATABASE_URL
make models                      # REQUIRED core models (~3 GB)
make identity && make vlm        # doc-25 verify cascade (~2.6 GB) — optional, degrades if skipped
make gen-setup && make fetch-gen # doc-25 FLUX generative fallback (~6.5 GB) — optional
make db                          # migrations + types
pnpm dev                         # → http://localhost:3000
```

*(Only `make models` is required. The cascade models each add a verification/generation layer
and the pipeline degrades gracefully without them.)*
