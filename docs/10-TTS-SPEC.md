# 10 — TTS Spec (Kokoro-82M)

## Engine

Kokoro-82M (Apache-2.0) in the sidecar via the `kokoro` PyPI package (`KPipeline`), G2P via misaki. 24 kHz mono output. Runs faster than realtime on M3 Pro CPU; MPS where torch supports it. One pipeline instance per language code, lazily created and kept warm (doc 14).

## Languages & voices (54 total)

| Language | Kokoro code | Voices (prefix) | Default voice | Notes |
|---|---|---|---|---|
| English (US) | `a` | 20 (`af_*`, `am_*`) | `af_heart` | Highest quality tier |
| English (UK) | `b` | 8 (`bf_*`, `bm_*`) | `bf_emma` | |
| Spanish | `e` | 3 (`ef_dora`, `em_alex`, `em_santa`) | `ef_dora` | |
| French | `f` | 1 (`ff_siwis`) | `ff_siwis` | |
| Hindi | `h` | 4 (`hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi`) | `hf_alpha` | |
| Italian | `i` | 2 (`if_sara`, `im_nicola`) | `if_sara` | |
| Portuguese (BR) | `p` | 3 (`pf_dora`, `pm_alex`, `pm_santa`) | `pf_dora` | |
| Japanese | `j` | 5 (`jf_*`, `jm_kumo`) | `jf_alpha` | Requires `python -m unidic download` (~1 GB, one-time; doc 19) |
| Mandarin | `z` | 8 (`zf_*`, `zm_*`) | `zf_xiaobei` | misaki[zh] |

`packages/core/src/voices.ts` is the canonical list: `{id, language, gender, displayName, sampleText}`. Build it in Phase 3 from the upstream VOICES.md of the pinned model revision; treat non-English voices as "good, not flagship" in UI copy (quality genuinely varies — set expectations honestly).

## Synthesis flow (tts stage)

1. For each beat (parallelism 2): `POST /tts {text, voice, speed, langCode}` → sidecar returns `{path, durationSec}` (WAV written under the project's `audio/beats/`). Kokoro internally splits long text; sidecar concatenates its chunks into one beat WAV.
2. Worker computes the master clock: `start[0]=0; start[i] = start[i-1] + dur[i-1] + pauseSec` (settings, default 0.15). Persist `beats.narration = {audioPath, durationSec, startSec}`.
3. Concatenate beat WAVs with `pauseSec` silence gaps → `audio/vo_raw.wav` (ffmpeg `concat` demuxer + `anullsrc` gaps, or sox-free pure-ffmpeg approach with `adelay`+`amix` — use concat demuxer, simplest).
4. Loudness-normalize **once** here: `ffmpeg -i vo_raw.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 audio/vo.wav` (48 kHz for the final mux). *All downstream timing (alignment, timeline) uses `vo.wav`.* Beat `startSec/durationSec` remain valid because loudnorm preserves duration (single-pass; verify with ffprobe assertion ±50 ms in tests, doc 21).

## Rate constants (for pre-TTS estimates only; measured durations always win)

`baseWps`: en 2.7, es 2.9, fr 2.8, hi 2.5, it 2.9, pt 2.8 words/s at speed 1.0; ja/zh use chars/s: ja 5.5, zh 4.5. `[CALIBRATE Phase 3]` by measuring golden narrations; used only for UI estimates and analyze-stage merge/split.

## Voice preview

`GET /api/voices/:id/sample` → if `cache/voice-samples/{id}.wav` missing, sidecar synthesizes the voice's `sampleText` (a fixed friendly sentence per language) once and caches. Settings UI plays instantly thereafter. Pre-warm all samples for the selected language in the background when the language changes.

## Edge cases

- Numbers/symbols: rely on misaki normalization; golden scripts include prices, years, percentages per language (doc 21).
- Empty/whitespace beat after analysis post-pass: impossible by construction (min length enforced) — assert anyway.
- Beat synthesis failure: retry once; then fail the stage with `E_TTS_FAIL_BEAT` and beatIdx (fatal — narration is the clock; no silent-gap hacks).
- Very short beats (< 2.5 s) were merged in analysis; Kokoro handles the rest fine.

## Future seam

`TtsEngine` interface (`synthesize(text, voiceRef, speed) → {path, duration}`) — an ElevenLabs adapter later gets word timestamps free, letting `align` become a no-op for that engine. Do not leak Kokoro specifics above the interface.
