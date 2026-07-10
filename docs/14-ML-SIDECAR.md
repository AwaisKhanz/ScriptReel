# 14 — ML Sidecar (services/ml)

Stateless FastAPI app, Python **3.12**, managed by **uv** (`uv sync`, `uv run uvicorn app.main:app --port 8484`). Single worker process; internal `asyncio` locks per model so heavy ops serialize while light ops interleave. It only touches paths under `DATA_DIR` and `assets/`; the worker passes absolute paths. No DB, no provider APIs, no business rules.

## Endpoints

| Route | In | Out | Model |
|---|---|---|---|
| `GET /health` | — | `{ok, device, models: {name: 'loaded'|'cold'}, versions}` | — |
| `POST /tts` | `{text, voice, langCode, speed, outPath}` | `{path, durationSec}` | Kokoro `KPipeline(lang_code)` per language, cached |
| `POST /align` | `{audioPath, language, text}` | `{words: [{word, start, end}]}` | mlx-whisper large-v3-turbo (env `WHISPER_MODEL` overrides) |
| `POST /embed/text` | `{texts: string[]}` | `{vectors: number[][], dim}` | SigLIP 2 base text tower, MPS |
| `POST /embed/image` | `{paths: string[]}` (≤64) | `{vectors, dim, failed: string[]}` | SigLIP 2 base vision tower, MPS, batched |
| `POST /textcard` | `{phrase, emotion, aspect, theme, outPath}` | `{path}` | Pillow template @2× target res |
| `POST /genimage` *(P13)* | `{prompt, negative, aspect, seed?, outPath}` | `{path, seed}` | FLUX.1-schnell 4-bit via mflux, 4 steps |

Errors: JSON `{error: {code, message}}` with proper status; codes `E_MODEL_LOAD`, `E_TTS`, `E_ALIGN`, `E_EMBED`, `E_GEN`. Worker maps these into `PipelineError`s.

## Model management

- `HF_HOME={DATA_DIR}/models`. Lazy-load on first use; keep warm for process lifetime. `/health` reports cold/loaded so the UI settings screen can show model status and trigger warmup (`POST /warmup {models: []}` — also implement).
- Device: `mps` when `torch.backends.mps.is_available()` else `cpu`; mlx models always Metal. Log device at load.
- Memory discipline (M3 Pro 18 GB case): SigLIP base ≈ 0.8 GB, whisper-turbo ≈ 1.6 GB (fp16 mlx), Kokoro ≈ 0.4 GB — all resident is fine. FLUX 4-bit ≈ 9 GB: load on demand, **unload after 5 idle minutes** (explicit `del` + `gc` + mlx cache clear), and refuse to load if `psutil` free memory < 11 GB with code `E_GEN_MEM` (worker then skips ladder rung 4).

## Implementation notes per capability

- **TTS:** iterate `KPipeline(text, voice, speed)` generator, concatenate chunk audio, write 24 kHz WAV via soundfile, return exact `len(samples)/24000`. Japanese pipeline construction verifies unidic presence and returns a clear `E_TTS: unidic missing — run make setup-ja` otherwise.
- **Align:** `mlx_whisper.transcribe(audio, path_or_hf_repo=…, word_timestamps=True, language=lang, condition_on_previous_text=False)`; flatten segment words. Do not pass the script as prompt (biases timings); mapping happens in the worker.
- **Embed:** transformers `AutoModel`/`AutoProcessor` for SigLIP 2; images loaded with Pillow, RGB, processor-resized; output pooled embeds L2-normalized. Batch=16 on MPS.
- **Textcard:** canvas 2W×2H; theme background = design-token gradient for the given emotion (doc 17 provides a small JSON `assets/brand/textcard-themes.json`: bg gradient stops, text color, accent bar); `keyPhrase` set in Inter ExtraBold (or Noto per language), auto-shrink to fit 80% width, 2-line max, subtle grain overlay PNG at 6% opacity. Deterministic given inputs.
- **Genimage (P13):** mflux schnell, 4 steps, guidance default, size = aspect-mapped (1024×576 / 576×1024 / 768×768 then upscaled by normalize pass), fixed seed unless provided (reproducibility).

## Testing

`uv run pytest`: golden tiny-inputs per endpoint (1-sentence TTS duration sanity ±20%, embed cosine of identical image > 0.99, align returns monotonic times, textcard renders deterministic checksum). CI-less local: `make test-sidecar`.
