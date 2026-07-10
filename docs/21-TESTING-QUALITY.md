# 21 — Testing & Quality

Three layers: **pure unit tests** (fast, always run), **stage integration tests** (opt-in, hit the sidecar and disk, stub the network), and **golden-set human QA** (the only thing that actually measures whether the videos are good).

## Golden scripts (`fixtures/scripts/`)

| id | Script | Language | Aspect | Purpose |
|---|---|---|---|---|
| G1 | 45 s city-morning narrative | en-US | 16:9 | Baseline; used in every phase |
| G2 | 90 s SaaS product explainer | en-US | 16:9 | Corporate/abstract nouns, charts |
| G3 | 3 min history documentary | en-GB | 16:9 | Long-form, chunked analysis, serif preset |
| G4 | 30 s social hook ("5 habits…") | en-US | 9:16 | Fast pacing, `pop` karaoke, portrait crop |
| G5 | 60 s nature/travel | en-US | 1:1 | Square framing, image-heavy, Ken Burns |
| G6 | 60 s philosophy ("meaning of doubt") | en-US | 16:9 | **Ladder stress** — nothing is filmable |
| G7 | 60 s health explainer | hi | 9:16 | Devanagari subtitles, non-English voice, English queries |
| G8 | 45 s recipe | ja | 9:16 | CJK grouping, unidic path, char-based wps |

Each fixture ships with a frozen `expected/analyze.json` (beat count range, not exact text) and, for G1/G4/G7, a hand-checked `expected/words.json` sample of 20 words for drift measurement.

## Unit tests (vitest, `packages/core`)

- `buildTimeline`: property test over random beat durations — asserts every doc 12 invariant (contiguity, frame quantization, Σ durations = narration ± 1 frame, `perBoundary` length).
- `scoreCandidate`: monotonicity (higher `sim` never lowers rank at fixed penalties), reuse penalty actually demotes, near-dup collapse.
- `settings`: defaults parse; each setting change produces the expected invalidated-stage set (this is the table in doc 06 encoded as a test — if the table and code disagree, the test fails, not the docs).
- ASS writer: golden-file compare per preset × aspect (bytes stable across runs).
- Beat merge/split rules, emotion→theme map, query normalization/hashing, path guard for `/api/files` (fuzz `..`, encoded slashes, symlinks).

## Stage integration (`TEST_INTEGRATION=1`)

Providers stubbed with recorded JSON fixtures (`fixtures/providers/*.json`) — never hit the real API in tests. Sidecar runs for real (it's local and fast); a `SIDECAR_FAKE=1` mode returns deterministic vectors and 1-second WAVs for CI-less speed.

- analyze: schema failure → exactly one reprompt → `E_LLM_SCHEMA`.
- search: 24 h cache hit makes zero requests; 429 respects the window.
- tts: measured durations become `narration`; missing voice → clear error.
- fetch: short source loops to length; corrupt download → `E_NORMALIZE` → replacement.
- compose: `ffprobe` assertions; deliberately broken timeline → `E_TIMELINE_INVALID`.
- resume: kill after `score`, re-run, exactly the post-gate stages execute.

## Matching evaluation (`pnpm eval:matching`)

30 labeled beat↔thumbnail pairs (`fixtures/eval/labels.jsonl`, columns: beatDescription, thumbPath, label ∈ good|bad) drawn from G1–G6. Reports precision@1, the τ_hi/τ_lo operating points, and the score histogram. Run it whenever the formula, weights, or model changes; paste the numbers into the PR body.

Gates: **≥ 55% top-1 acceptance at Phase 6**, **≥ 70% at Phase 14** (doc 01's success metric). Acceptance = a labeled-good asset chosen as rank 1, or the ladder correctly declining to a conceptual/text-card fallback where all candidates are labeled bad.

## Subtitle drift

`pnpm test:drift <projectId>` compares `words.json` against the fixture's hand-checked sample: reports mean and p95 absolute offset. Gate: **p95 ≤ 120 ms**. Also asserts monotonic non-overlapping word intervals and that no cue exceeds 21 chars/s or 2 lines.

## Render assertions (automatic, every compose)

`ffprobe`: duration = narration ± 0.1 s · exactly 1 video (30 fps, exact W×H) + 1 audio (48 kHz) · `moov` at file head (faststart) · file size > 0 · integrated loudness within −16 ±1 LUFS (`ebur128` on a decode pass, Final preset only). Failure → `E_COMPOSE_VERIFY` with the probe dump attached.

## Human visual rubric (the real test)

Watch the whole video once, at speed, without pausing. Score 1–5:

1. **Relevance** — do the visuals mean what the words mean?
2. **Pacing** — do cuts land on thoughts, not mid-clause?
3. **Polish** — no jitter, no black frames, no repeated asset, consistent color/energy.
4. **Audio** — narration clear, music present but never competing, no clipping.
5. **Subtitles** — readable, in sync, never covering a face or the key subject.

Record scores in `fixtures/qa/<date>.md`. Ship gate: **≥ 4.0 mean across G1–G5, no individual score below 3.** A video that scores 5/5/5/5/5 but took the text-card fallback on half its beats has failed relevance — count fallbacks separately and keep them **< 20% of beats** on G1–G5 (G6 is exempt; that's the point of G6).

## Benchmarks (Phase 14, M3 Pro 18 GB, recorded here)

| Scenario | Target |
|---|---|
| 3-min script, cold cache, Final 1080p | ≤ 10 min |
| Same, warm cache (assets + embeddings) | ≤ 4 min |
| Draft 720p, warm | ≤ 2 min |
| `composeOnly` after subtitle change | ≤ 90 s |
| Single beat re-search + re-score | ≤ 8 s |
| Embedding 40 thumbs (warm SigLIP) | ≤ 1.5 s |
| Peak RSS (FLUX unloaded) | < 6 GB |

Record actual numbers next to targets; a regression > 25% on any row blocks a merge.

## What is deliberately not tested

Provider API contracts (they change; we own fixtures, not their servers), FFmpeg's own correctness, model quality in the abstract. We test *our* glue, *our* invariants, and *the finished video*.
