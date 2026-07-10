# 20 — Roadmap

Fifteen phases, `0 → 14`, executed **in order**. One phase per Claude Code session, fresh context, read only the listed docs. A phase is done when a human has *seen* its exit criteria demonstrated — not when the code compiles. Every phase ends with `pnpm check` green.

---

### Phase 0 — Scaffold & environment
**Read:** 03, 04, 18, 19.
**Build:** pnpm+Turborepo monorepo per doc 18 layout; `apps/web` (Next 15, Tailwind v4 tokens from doc 17), `apps/worker` (boots, logs, exits cleanly), `services/ml` (FastAPI with `/health` + `/warmup` only, models lazily importable), `packages/{core,db,config}`; Biome + husky; `.env.example`; `fetch_models.py`; `supabase start` + empty migration; `pnpm dev` runs all three.
**Exit:** doc 19 §7 checklist passes end-to-end. Pinned versions appended to doc 04.

### Phase 1 — Contracts & data
**Read:** 05, 12, 02, 06 (§stage contract), 18.
**Build:** migrations `0001_init.sql` (+ `cancel_requested`), `0002_seed_music.sql`; generated db types; `packages/core`: `settings.ts` (defaults + zod), `timeline.ts`, `jobs.ts`, `errors.ts`, `voices.ts` stub, `buildTimeline.ts` (pure, no data yet), `invariant`; pg-boss install + worker registers `pipeline` queue with a no-op handler that walks 7 stages writing `pipeline_runs`; stage runner with `inputsHash`/manifest skip logic; `cli.ts` harness.
**Exit:** `pnpm stage --project <id> --fake` walks all seven stages, writes manifests, and a second run reports all seven `skipped`. `buildTimeline` property test passes doc 12 invariants on random inputs. Cancel flips status mid-walk.

### Phase 2 — Script analysis
**Read:** 07, 05, 18.
**Build:** `ScriptAnalyzer` interface + `GeminiAnalyzer` (structured output, temperature 0.3, chunking with 1-beat overlap) + `OllamaAnalyzer`; verbatim reconstruction check + repair; merge/split post-rules; beats persisted; analyze stage wired.
**Exit (quality bar, doc 07):** on golden scripts G1–G3, 100% verbatim reconstruction; ≥ 90% of beats within the pacing band; every `visualDescription` is English and filmable (human read-through); a forced schema error triggers exactly one reprompt then `E_LLM_SCHEMA`; Gemini 429 auto-falls-back to Ollama with `analyzer:'ollama'` in the manifest.

### Phase 3 — TTS & the narration clock
**Read:** 10, 14, 02, 17.
**Build:** sidecar `/tts` (KPipeline per lang, cached), `voices.ts` from the pinned model revision, worker tts stage (parallelism 2, pauses, concat → `vo.wav`, loudnorm to −16 LUFS, `narration` written per beat), `/api/voices` + `/api/voices/:id/sample` + prewarm, `baseWps` calibration.
**Exit:** `vo.wav` measured duration = Σ(beat durations) ± 30 ms; `ffprobe` shows 48 kHz post-normalize; integrated loudness within −16 ±1 LUFS; voice preview plays in < 300 ms warm; one voice per supported language auditioned by a human.

### Phase 4 — Alignment & subtitles
**Read:** 11, 14, 17 (§presets), 12.
**Build:** sidecar `/align`; token alignment to known script (normalize + Needleman-Wunsch/difflib), proportional fallback; `words.json`; ASS writer for all four presets × three aspects; CJK grouping; `render.ass` generation.
**Exit (doc 11):** on G1 (en) and G7 (hi), ≥ 95% of words within 120 ms of a hand-checked reference on a 20-word sample; `pop` karaoke highlights the correct word at 5 spot-checked timestamps in a burned test clip; `E_ALIGN` path produces watchable subtitles; every preset renders legibly at all three aspects.

### Phase 5 — Providers, cache & quota
**Read:** 08, 22, 05, 18.
**Build:** `MediaProvider` interface, `PexelsProvider`, `PixabayProvider`; normalized query hashing + 24 h disk cache; durable token buckets in `provider_usage`; thumbnail download to `cache/thumbs`; search stage (tier-1 only); `/api/quota`.
**Exit:** 50-beat script consumes ≤ the doc 22 budget; a second identical run makes **zero** network calls; simulated 429 waits for the window and never drops candidates; quota meters match server counters.

### Phase 6 — Matching & calibration
**Read:** 09, 14, 21.
**Build:** sidecar `/embed/text` + `/embed/image` (batched, MPS, disk-cached by thumb checksum); scorer in `packages/core` (pure); penalties (reuse, near-dup, provider run); selection; `eval:matching` script over the labeled set.
**Exit:** 30 hand-labeled beat↔thumb pairs scored; `τ_hi` set at the 90%-precision point, `τ_lo` at 70%, both written into `constants.ts` **and** doc 09; top-1 acceptance ≥ 55% on the eval set (this is a floor, not the goal — Phase 14 raises it); embedding a 40-thumb beat takes < 1.5 s warm.

### Phase 7 — Fallback ladder & text cards
**Read:** 09 (§ladder), 14, 17 (§textcard themes), 02.
**Build:** ladder rungs 1–3 + 5 (broaden → conceptual → mood → text card), emotion→theme map, sidecar `/textcard`, `forced_textcard` handling, `E_NO_CANDIDATES` as a *warning*.
**Exit:** on G6 (deliberately abstract script) every beat resolves, with zero empty beats and no literal mismatches a human calls wrong; text cards are legible at 9:16; rung taken is logged per beat.

### Phase 8 — Fetch & normalize
**Read:** 08, 13 (§normalize), 03.
**Build:** asset download with `asset_cache` dedupe + checksum; per-beat normalization to `clips/{idx}.mp4` at exact `W×H@30` (scale/crop, loop/hold for short sources, Ken Burns baked for stills/textcards with the anti-jitter pre-scale); parallelism 3; `E_DOWNLOAD`/`E_NORMALIZE` handling with replacement.
**Exit:** every clip's ffprobe reports exact geometry, 30 fps, duration ≥ needed + crossfade padding; a 44-beat fetch completes < 90 s warm cache; visual check: no Ken Burns jitter at 1080p.

### Phase 9 — Timeline & composition
**Read:** 12, 13, 17.
**Build:** `buildTimeline` fed by real data; schema + invariant validation; pass-A concat/xfade chain; pass-B subtitles + music + sidechain duck + loudnorm + encode presets; thumbnail; `credits.txt`; post-render ffprobe assertions; `renders` row with frozen timeline.
**Exit:** G1 renders at all three aspects, Draft and Final; A/V drift ≤ 100 ms at the end; no black frames at boundaries; audible ducking; `E_COMPOSE_VERIFY` fires when the duration assertion is deliberately broken.

### Phase 10 — Orchestration
**Read:** 06, 15, 18.
**Build:** the real `pipeline` handler (analyze → parallel [search→score] ∥ tts → gate → align → fetch → compose), `beat-research` queue, review gate + `continue`, cancel, progress weighting + throttled `report()`, retries per `retryable`, `composeOnly` mode, warnings surfaced into manifests.
**Exit:** kill the worker mid-`fetch`; restart; the run resumes from manifests and finishes. `composeOnly` after a subtitle change re-renders in < 90 s. Cancel during compose leaves a clean `draft` project. Overall progress is monotonic and hits 100 at done.

### Phase 11 — Web shell & wizard
**Read:** 16, 17, 15, 02.
**Build:** dashboard, 3-step wizard with summary rail, voice preview, live subtitle preview canvas, aspect toggle, music picker; `useProjectRealtime`; progress view (stepper, log tail, cancel); settings screen (health, models, cache, quotas); all four states per surface.
**Exit:** a script goes from paste → generating → done without touching the CLI; progress updates arrive < 1 s after the worker writes them; the subtitle preview matches the burned output at all three aspects (side-by-side screenshot check); refreshing mid-run loses nothing.

### Phase 12 — Storyboard & re-render
**Read:** 16, 15, 09, 06.
**Build:** BeatCard grid with hover previews, swap drawer (optimistic), re-search dialog with quota guard, force-text-card, approve-and-render footer; result view with player, credits modal, render history, re-render panel with invalidation preview.
**Exit:** swapping a beat then continuing re-runs exactly `fetch`+`compose` (verified in `pipeline_runs`); re-search of one beat costs ≤ 4 provider requests; changing music re-runs `compose` only; the invalidation preview never lies.

### Phase 13 — Generative fallback *(optional, flagged)*
**Read:** 14, 09, 04.
**Build:** sidecar `/genimage` (mflux, FLUX.1-schnell 4-bit, 4 steps, seeded, idle-unload, `E_GEN_MEM` guard); ladder rung 4; settings toggle visible only when the model is present.
**Exit:** a generated beat renders with Ken Burns; memory returns to baseline within 5 idle minutes; disabling the toggle or removing the model degrades silently to text cards; generation adds ≤ 20 s per beat.

### Phase 14 — Quality, performance, packaging
**Read:** 21, 22, 19, 01.
**Build:** full golden-set run (G1–G8), matching eval re-run, benchmark table, cache eviction by `last_used_at`, disk guard (`E_DISK_FULL` pre-checks), diagnostics copy, `make setup` one-liner, README with a 60-second start, attribution/licensing pass.
**Exit (product bar, doc 01):** top-1 acceptance ≥ 70% on the eval set; ≥ 4/5 average on the human rubric for G1–G5; warm E2E ≤ 6 min Draft / ≤ 10 min Final for a 3-minute script; peak RSS < 6 GB with FLUX unloaded; a fresh clone reaches a rendered video following only doc 19.

---

## Parked (v2, do not build)

Timeline editor UI · cloud/multi-user deployment · voice cloning (Chatterbox) · saliency-aware cropping · music generation · 4K · Openverse/Wikimedia/NASA providers · face-aware reframing · subtitle translation · scheduled batch rendering.
