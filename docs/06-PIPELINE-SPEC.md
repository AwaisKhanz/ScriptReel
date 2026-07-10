# 06 — Pipeline Spec

## Stage graph

```
analyze → search → score → [REVIEW GATE] → tts → align → fetch → compose → done
```

`tts` is independent of `search/score` and MAY run concurrently with them (worker runs `analyze`, then `Promise.all([searchThenScore, tts])`, then gate, then `align → fetch → compose`). `align` needs tts output; `fetch` needs final selections (post-review); `compose` needs everything.

## Job model (pg-boss)

One queue: `pipeline`. Payload `{ projectId, mode }` where `mode ∈ 'full' | 'continue' | 'composeOnly' | 'stage:<name>'`. Options: `retryLimit: 2`, `retryDelay: 30`, `expireInHours: 2`, singleton per project (`singletonKey: projectId`) so a project can never run twice concurrently. A second lightweight queue `beat-research` handles single-beat re-search from the storyboard (`{ projectId, beatId, visualDescription?, customQuery? }`).

The worker registers handlers at boot, `teamSize: 1` for `pipeline` (one video at a time on a laptop is correct; parallelism lives *inside* stages), `teamSize: 2` for `beat-research`.

## Stage contract

Every stage implements:

```ts
interface Stage {
  name: PipelineStage;
  inputsHash(ctx: ProjectCtx): Promise<string>;   // sha1 of everything that affects output
  run(ctx: ProjectCtx, report: (pct: number, detail?: string) => void): Promise<void>;
}
```

Rules:
1. **Idempotent.** Before running, compare `inputsHash` with `stages/{name}/manifest.json.inputsHash`. Match + artifacts present → mark `skipped`, move on. This is the whole resume mechanism.
2. **Manifest last.** Write all artifacts, then atomically write manifest (`tmp` + rename). A crash mid-stage leaves no valid manifest → clean re-run.
3. **Progress.** Call `report()` at least every 2 s of work; worker throttles DB writes to 500 ms. `detail` is a human string shown in UI.
4. **Errors.** Throw `PipelineError(code, stage, message, {cause, beatIdx?})` (doc 18). Worker marks run row `failed`, project `failed`, stores `{stage, code, message}`. Retries per pg-boss policy only for codes flagged `retryable` (network, 429-after-wait, ffmpeg-spawn).

## Inputs → hash map (what invalidates what)

| Stage | inputsHash over |
|---|---|
| analyze | script, language override, pacing |
| search | analyze manifest hash, mediaPreference, aspect (orientation), provider list |
| score | search manifest hash, aspect, mediaPreference |
| tts | analyze manifest hash (beat texts), voice, speed, beat pause |
| align | tts manifest hash, subtitle language |
| fetch | final per-beat selections (chosen candidate ids + forced textcards), aspect |
| compose | fetch + align manifests, timeline-affecting settings: subtitle preset/position, music (mood/track/level), transitions, quality preset, aspect |

Consequences (must hold): changing **subtitle style, music, or quality** re-runs `compose` only. Changing **aspect** re-runs `search? → no` — orientation filter changed, so `search, score, fetch, compose` (tts/align survive). Changing **voice/speed** re-runs `tts, align, compose` (visual selections survive; durations shift, timeline rebuilds in compose from fresh narration). Changing **script** nukes everything.

## Review gate

After `score` completes and `mode=full` with `reviewBeforeRender=on`: set project `awaiting_review`, complete the pg-boss job (do NOT hold the worker), and stop. UI's *Continue* posts `mode: 'continue'`, which enqueues a new job; stages before the gate skip via manifests. `reviewBeforeRender=off` → no gate.

Storyboard actions while gated: `choose candidate` updates `beats.chosen_candidate_id` (DB only — fetch hash changes automatically); `re-search beat` runs the `beat-research` job (search+score for one beat, appends candidates, re-ranks); `force text card` sets `beats.forced_textcard=true`.

## Stage summaries (detail lives in owning docs)

- **analyze** (doc 07): LLM → beats rows + `stages/analyze/beats.json`. Progress: per chunk.
- **search** (doc 08): tier-1 queries per beat via providers (cached, budgeted) → candidates rows + thumbs downloaded to cache. Progress: per beat.
- **score** (doc 09): sidecar embeds description + thumbs, ranks, applies penalties, selects, walks fallback ladder (escalation may call search tiers 2–3 within budget). Writes `chosen_candidate_id` + `stages/score/selection.json`.
- **tts** (doc 10): per-beat WAVs via sidecar, concatenate with pauses → `audio/vo.wav`; write measured `narration` per beat (start/duration — **the clock**).
- **align** (doc 11): sidecar word timestamps on `vo.wav`, token-align to script → `subs/words.json` + `subs/subs.ass` for current preset.
- **fetch** (doc 08/13): download chosen originals into `cache/assets`, then normalize each into `projects/{id}/clips/{idx}.mp4` at target geometry (parallelism 3). Progress: per beat, weighted by bytes.
- **compose** (doc 13): build `timeline.json` (doc 12) from DB + manifests, validate against schema, then run FFmpeg passes → `renders/{renderId}/final.mp4`, thumbnail, credits.txt; insert `renders` row.

## Overall progress weighting (UI)

`{analyze: 8, search: 14, score: 10, tts: 14, align: 6, fetch: 22, compose: 26}` — sums to 100; overall = Σ weight·stagePct. Stages `skipped` count as 100.

## Cancellation

`POST /api/projects/:id/cancel` → pg-boss `cancel` + a `cancelled` flag row the worker polls between beats/steps; FFmpeg child killed via execa signal. Project → `draft` with completed manifests intact (resume is free).

## Concurrency & resource rules

Inside stages: network downloads max 4 parallel; FFmpeg normalizations max 3 parallel (`-threads 0` each is fine on M3 Pro); sidecar calls serialized per capability (the sidecar itself queues; TTS and embedding may interleave). Only ever ONE `compose` final encode at a time.
