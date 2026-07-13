# ScriptReel — Setup Guide

Onboarding for a fresh machine. This is the top-level, cross-platform entry point;
`docs/19-SETUP-MACOS.md` is the deeper macOS reference and `docs/00-INDEX.md` maps the
full spec set.

---

## 0. Platform support — read this first

ScriptReel is an **Apple-Silicon-first** local pipeline. The ML sidecar uses **MLX** (Apple's
array framework) for Whisper alignment + the Qwen2.5-VL checklist, and the separate FLUX
generator (`services/gen`) uses **mflux** (also MLX) — all **Apple-Silicon-only** (M1/M2/M3/M4).

| Platform | Web + Worker | ML sidecar (TTS, SigLIP, align, OCR/identity/VLM) | FLUX gen |
|---|---|---|---|
| **macOS (Apple Silicon)** | ✅ supported | ✅ supported — the target platform | ✅ |
| **macOS (Intel)** | ✅ | ⚠️ no MLX → align + VLM won't run; the rest is CPU-slow | ❌ |
| **Windows 10/11** | ✅ | ❌ `uv sync` fails — `mlx`/`mlx-whisper`/`mlx-vlm` have no Windows build | ❌ |
| **Linux** | ✅ | ❌ same MLX blocker (WSL2 doesn't help — it's x86, not Apple Silicon) | ❌ |

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

> **Windows/Linux:** none of these can be downloaded, because the sidecar venv itself can't be
> created (`uv sync` fails on `mlx` — §0/§7). The model download commands run *inside* that venv.

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

## 7. Windows — step by step (honest state)

**Read first:** you can install and run the **web UI + worker** on Windows, but you **cannot
generate a finished video** there. The ML sidecar (`services/ml`) and the FLUX generator
(`services/gen`) depend on **MLX** — `mlx-whisper` (alignment), `mlx-vlm` (the VLM checklist),
and `mflux` (FLUX) — which is **Apple-Silicon-only**. `uv sync` fails on Windows, so the
sidecar venv can't be created, so there's no TTS, no SigLIP embeddings (the matching model),
no alignment, and none of the OCR/identity/VLM gates. Generation stops at the `score` stage.

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

### 7.2 Set up the project (you've already cloned it)

```powershell
cd ScriptReel
pnpm install                     # JS deps for web + worker — this WORKS on Windows
copy .env.example .env           # then fill it in (see §4): OPENAI/PEXELS/PIXABAY keys + DATABASE_URL
pnpm db:migrate                  # push migrations to Supabase Cloud (Node — works)
pnpm db:types                    # regenerate DB types
```

### 7.3 Run the parts that work

```powershell
# Do NOT run `cd services/ml; uv sync` — it fails on mlx (that's expected on Windows).
pnpm --filter @scriptreel/web dev       # the UI on http://localhost:3000  (works)
pnpm --filter @scriptreel/worker dev    # the pipeline worker (runs; stalls at `score` — no sidecar)
```

You can create projects, paste scripts, run **analyze** (GPT/cloud) and **search** (providers),
and browse the UI. The `/settings` health page will show the **sidecar as down** — that's
correct on Windows.

### 7.4 To actually generate videos on Windows — the cross-platform port

This is a **code change**, not a setup step, and it hasn't been done because the project
targets one machine (an M3 Pro). If you want it, ask and I'll scope it:

1. Platform-gate the MLX deps in `services/ml/pyproject.toml`
   (`mlx-whisper; sys_platform == 'darwin'`, same for `mlx-vlm`) so `uv sync` succeeds on
   Windows and installs the **non-MLX** models — SigLIP, Kokoro TTS, OCR (tesseract),
   InsightFace, DINOv2 — which are torch/onnx and DO run on Windows (CPU or CUDA).
2. Add a non-MLX **alignment** backend (e.g. `faster-whisper`) — or let alignment degrade
   (word-synced subtitles off; `E_ALIGN` is already a warning, not a failure).
3. The VLM gate already degrades when its model is absent (`available()` → false → skipped),
   so on Windows you'd simply lose that one verification layer.
4. The FLUX generative fallback stays Apple-only (mflux); abstract beats fall to the text card.

Net result of the port: **Windows could generate videos** (with stock/archive footage, TTS,
and text cards), minus word-synced subtitles + the VLM gate + FLUX. The degrade-never-die
design already does most of the work — it just needs the dependency markers + a subtitle
fallback. **The simplest path to a full-quality video today is an Apple-Silicon Mac.**

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
