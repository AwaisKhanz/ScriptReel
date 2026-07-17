# HANDOFF — 2026-07-17 session → next session

**Read this first, then delete it when its "NEXT" section is done.** It is a session handoff, not a
spec. Anything here that turns out to be durable belongs in `docs/` or `CLAUDE.md` instead.

Written on a Mac; the next session runs on the owner's **Windows PC** (Ryzen 9 · RTX 5060 Ti 16 GB ·
32 GB DDR5). The previous session's memory files live under `~/.claude/projects/…/memory/` on the Mac
and **do not travel** — everything load-bearing is repeated here.

---

## NEXT — the one thing to do first

The owner has so400m loaded on the PC and a per-axis report was just added. Ask them to run:

```powershell
pnpm eval:matching --human-only     # with SIGLIP_MODEL=google/siglip2-so400m-patch14-384 still set
```

Embeddings are cached, so it is fast. You want the `axis comparison` block. base-224's, for contrast:

```
score ceiling 81.7% (60/218)   │ @80%: τ=0.341  clears 88/218
sim   ceiling 87.5% (16/218)   │ @80%: τ=0.133  clears 78/218
spec  ceiling 100.0% (6/218)   │ @80%: τ=0.086  clears 87/218
```

**The question:** on so400m, does raw `sim` beat `score` at *usable coverage*? Its within-beat AUC
does (0.756 vs 0.713) — but a ceiling reached by 6/218 candidates is not an operating point, it is a
τ that sends every beat to the fallback ladder. Compare the `@80% clears N/218` column, not the
ceilings.

- **If sim wins at comparable coverage** → so400m + sim-as-the-axis is a real config. That means
  `SCORE_WEIGHTS` (`packages/core/src/constants.ts`) drops/zeroes the quality+orient terms, and τ is
  **re-fitted on the new axis**. The shipped 0.341/0.311 are fitted on base-224 base-score cosines
  and DO NOT transfer (CLAUDE.md: "τ are model-specific").
- **If it does not** → the encoder question is closed. Next suspect is the **VLM gate's veto** (below).

**Then, regardless: render a video.** See "The thing nobody has done" below. It matters more than
any of this.

---

## STATE — what shipped today (9 commits, all on `main`, all pushed, 290 tests green)

| commit | what |
|---|---|
| `b5abf8d` | analyzer overhaul — see below |
| `f114e3e` | κ=0.160; eval:matching was scoring nothing and reporting PASS |
| `ee54b1a` | τ 0.360 → 0.338 (later superseded) |
| `8dea45d` | `eval:kappa --rest` — the labelling page for the remaining 142 |
| `89080b6` | **τ = 0.341 / 0.311** on 218 human labels — the current shipped values |
| `25e1520` | storyboard swap feature REMOVED |
| `f166bd2` | three web fixes (DB-outage lie, fake health dots, poisoned queue) |
| `9ff1c79` | per-axis ceiling + coverage in eval:matching |

### The analyzer overhaul (`b5abf8d`)
The owner's complaint: a sentence naming 5 things produced 2–3 shots; long beats held one image.
Causes, none of them prompt wording:
1. **The count was capped in four places** — the prompt said "2–4 ordered shots", the schema allowed
   6, `deriveMoments` then `.slice(0,4)`'d, and `MONTAGE_MAX_SEGMENTS` capped at 4 again. All removed.
   Screen time is now the only bound (`MONTAGE_HARD_MIN_SEG_SEC = 0.8`, applied in
   `planSemanticMontage` where the duration is known).
2. **The entity category enum had no value for everyday things** — structured outputs constrain the
   model to the enum, so "beet juice"/"kidneys"/"nitric oxide" had nowhere to land and a real script
   returned `entities: []` on all 9 beats. Added `food`/`plant`/`anatomy`/`substance`, which also
   closed a loop: `topics.ts` already had `food` and `medicine` topics (with **Wellcome** behind
   medicine) that no entity category could reach. Measured: 0/9 beats → 9/9.
3. **An entity with no shot is dead weight** — `search.ts` walks `shots` and resolves `shot.entity`,
   so an entity nothing points at is never sent to any archive. `ensureEntityShots` in the post-pass
   now guarantees every visualizable entity gets one. **This is the load-bearing fact about the
   analyzer: shot count decides whether an entity exists at all.**

Verify with `pnpm eval:analyze [G8 G9 G10]` (real gpt-4o over golden fixtures; G8 beet/medical,
G9 Voyager/space, G10 five-item lists). Never tune the prompt without a before/after.

### Calibration (`89080b6`) — the important context
- **τ_hi = 0.341 @80%, τ_lo = 0.311 @70%**, fitted on **218 hand-labelled pairs** (`--human-only`).
- **90% precision DOES NOT EXIST on the base-score axis.** Ceiling is 81.7%. Every historical τ
  (0.322, 0.360, 0.338) was fitted to an unreachable target and reported as if it had been hit.
  eval:matching now prints the ceiling so this cannot recur.
- **κ = 0.361** over 188 hand-labelled pairs — the model judge that produced the original 192 labels
  is *biased, not noisy*: it calls 43 pairs bad that the human calls good vs 18 the other way
  (2.4:1; reproduces at every n). It wants literal subject presence; the human accepts thematic fit.
- **Direction matters**: a mislabelled-bad pair is a phantom false-positive at every threshold, so
  precision(τ) reads low and any fit against model labels **climbs**. A too-high τ_hi is NOT the safe
  error — it rejects candidates the viewer would accept and drops the beat to the ladder, i.e. to
  generic stock. τ=0.360 cleared only 23/218.
- **Settled, do not re-litigate:** §1.1 contrastive → null on the full human set (stays benched).
  §3.9 caption ranker → null. so400m → no improvement on the shipped config.

### The swap removal (`25e1520`)
Owner's call: the selector picks, nothing overrides it. Deleted the PATCH/research routes, the
`beat-research` stage, `BEAT_RESEARCH_QUEUE`, six db write/authz helpers, `STORYBOARD_CANDIDATES`,
and the Storyboard's dialog + action row. The gate remains: preview the real stitched clip → approve.
`forced_textcard` survives as an inert column (nothing writes it; removing needs a migration).

**Consequence:** this closed the only human-feedback channel. Doc 25 §3.13 wanted the review gate as
the label source; with no swap there is no swap signal. Labels now come only from deliberate
`pnpm eval:kappa` sessions.

---

## TRAPS — each of these cost real time today

1. **`pnpm eval:fixtures` before ANY eval.** `labels.jsonl` points into `data/cache`, an LRU *render*
   cache that evicts the labelled thumbs. A missing thumb used to embed as `[]` and score a silent 0
   — every base score the constant 0.266, every ROC-AUC **exactly 0.500**, zero-width CIs — and the
   run still printed `precision@1 = 76.7% PASS`. It now hard-fails. **Tell-tale of a bad run: any AUC
   of exactly 0.500, or a zero-width bootstrap CI.**
2. **Sidecar: `pnpm --filter @scriptreel/ml start`, NEVER `dev`.** `dev` adds `--reload`; the watcher
   restarts the process on any file touch and killed three 4.5 GB downloads mid-flight.
3. **Never set `HF_HOME`.** `services/ml/app/main.py:55` does `os.environ.setdefault(...)` — it
   computes the correct path itself, and any exported value *wins over* the correct one. An
   `HF_HOME` left in a PowerShell session sent the sidecar to the wrong directory and re-downloaded
   4.5 GB twice.
4. **A model load blocks the sidecar's event loop** — `/health` goes unresponsive for 1–2 min on the
   first `/embed` after a model swap. That is the load, not a crash. (It is also a real bug: model
   loads run on the asyncio loop; inference is correctly threaded.)
5. **Never fit or conclude on a stratified subset.** τ=0.338 was fitted on 80 labels of which 50 were
   a κ round drawn 25-good/25-bad **by model label** — precision(τ) depends on prevalence, so the fit
   inherited a class balance chosen by the instrument under test. Died within hours of 138 more
   labels. The same subset produced a phantom "§1.1 is a real +0.0398 gain" that is null on 218.
6. **Windows on `main` directly** — the owner wants everything committed to `main` and pushed. No
   feature branches.

---

## THE THING NOBODY HAS DONE

**Render a video.** Nothing has been driven end-to-end since: the analyzer rewrite, four new entity
categories (Wellcome now reachable for medical beats), two τ changes, and the swap removal.
`SCORE_CALIBRATION` changed, so every cached selection is already invalidated and the next run
re-scores from scratch.

Every number in this file is a **proxy**. 218 labels on 30 hand-picked, mostly stock-servable beats
is not a video. `fixtures/golden/G9.txt` (Voyager — entity-heavy, archive-routed) is the case the
sourcing redesign targets. Watch for: montage cadence at ~1 s cuts, whether Wellcome/NASA assets
actually beat stock, and whether beats still hold one image.

---

## BACKLOG — confirmed by reading the code, deferred by the owner

Highest-value first. #1's old top entry (semantic montage overriding a forced text card) is **moot**
now that nothing sets `forced_textcard`.

**Silently wrong output**
- `subtitlePosition` is a live UI control that does nothing — absent from compose's `inputsHash` (so
  the stage skips and marks `done` with the OLD file) *and* never reaches `buildAss`.
- **Crossfade rounding drift**: `compose/plan.ts:24` rounds the half-fade to whole frames but
  `composePlan`/ffmpeg use the raw `crossfadeSec`. Only 0.4 and 0.6 are safe; settings allows
  0.3–0.6 continuous. Latent because every test pins 0.4 — the one value where it is invisible.
  At 0.5 across 20 beats it drifts ~633 ms and trips `E_COMPOSE_VERIFY`.

**Breaks under failure**
- **`VLM_TIMEOUT_S` drift**: sidecar is 300 s/item (`vlm.py:59`), client budget is 420 s for 3 items
  (`client.ts:232`, derived when the sidecar was 120 s). On the exact Windows/Ollama eviction case
  commit `24aeed8` fixed, the client aborts → gate silently skips.
- `research/route.ts` used `&&` where its comment said "either" — **gone with the swap removal**.

**Invariant violations**
- `analysis/knowledge.ts` calls Wikidata/Wikipedia **outside QuotaGuard + SearchCache** (invariant 6).
  The hand-rolled 429 backoff at `knowledge.ts:57` exists *because* the guard was bypassed. Doc 25 §3
  already specifies the cache key.
- **QuotaGuard never rolls back a partial multi-window reservation** (`quota-guard.ts:35`): if
  `pexels:hour` reserves and `pexels:month` is at budget, the hour counter stays incremented for a
  request never made. Also: doc 08 promises pacing ("QuotaGuard sleeps between bursts") that **does
  not exist** — it throws immediately.
- **License gate missing from `ladder.ts:138`** (`beat-research.ts` is gone). Latent — the ladder
  only plans Pexels/Pixabay today — but it is a live tripwire the moment an archive is routed there.
- `usgs.ts:57` / `nasa.ts:67` hardcode `license: 'public domain'` without reading any rights field.
  Most likely route to non-free media in the system.
- **SearchCache poisons itself**: providers that `return []` on a transient 500 get their emptiness
  cached for 24 h; providers that `throw` retry next run. Same failure, opposite outcome, no rule.

**Next investigation (if the encoder question closes)**
- **Validate the VLM gate's veto.** It asks "is the subject present?" — the same question a vision
  judge agreed with the human on at only **κ=0.361** — and it has **veto** power (`!subjectPresent`
  → candidate dropped). If Qwen2.5-VL shares that bias it is silently deleting clips the owner would
  pick, which is the same mechanism that pushed τ too high. The 218 labels can settle it.
- **The score formula may be dilution.** The rank-1 margin is **0.0070** (mean top1−top2) while
  OCR/identity/VLM penalties are 0.05–0.25 — **7–35× the margin**. Any penalty firing does not nudge
  the ranking, it obliterates it. `constants.ts:172-183` predicted this; it is now measured.
- **InsightFace runs on CPU** even on the 5060 Ti — `face.py:55` hardcodes `CPUExecutionProvider` and
  `pyproject.toml` pins `onnxruntime`, not `onnxruntime-gpu`. Small, real win.

---

## HARDWARE NOTES (the PC)

- Blackwell (sm_120) is **already handled**: both `services/ml` and `services/gen` pull torch from the
  cu128 index. Verified.
- 16 GB dedicated VRAM comfortably holds SigLIP + Qwen2.5-VL-7B resident together — the M3 Pro's
  18 GB shared cannot.
- The Windows symlink warning from `huggingface_hub` is expected and harmless; `main.py:58-90`
  already patches `are_symlinks_supported` to dodge a WinError 1314 download race. Do not enable
  Developer Mode on its account.
