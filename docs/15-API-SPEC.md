# 15 — API Spec (Next.js route handlers ↔ worker)

All routes live in `apps/web/app/api/**/route.ts`, run on the **Node runtime** (`export const runtime = 'nodejs'`), and obey three rules:

1. **Routes never do pipeline work.** They validate, touch Postgres, enqueue pg-boss jobs, and return. Max response time budget: 150 ms (except file streaming and voice-sample synthesis).
2. **Zod at the edge.** Every body/query parsed with a schema from `packages/core/src/api-schemas.ts`; the inferred types are the client's types too (no duplicate interfaces).
3. **One error envelope.** `{ error: { code, message, details? } }` with codes from doc 18. Success = the resource, unwrapped.

Status codes: `200` ok · `201` created · `202` accepted (job enqueued) · `400` validation · `404` unknown id · `409` illegal state transition (e.g. generate while `running`) · `429` provider quota exhausted (surfaced from `provider_usage`) · `500` unexpected.

## Projects

| Method | Route | Body / query | Behavior |
|---|---|---|---|
| POST | `/api/projects` | `{script, title?, settings?}` | Insert `projects` (status `draft`), settings merged over defaults, `settings_hash` computed. → `201 {project}` |
| GET | `/api/projects` | `?limit&cursor` | Cards: id, title, status, duration, latest render thumbnail |
| GET | `/api/projects/:id` | — | `{project, runs[], beats[], renders[]}` (beats without candidates) |
| PATCH | `/api/projects/:id` | `{title?, script?, settings?}` | `409` unless status ∈ {`draft`,`done`,`failed`,`awaiting_review`}. Recomputes `settings_hash`. Does **not** delete stage artifacts — invalidation is by hash (doc 06) |
| DELETE | `/api/projects/:id` | — | Cascade rows; `rm -rf DATA_DIR/projects/{id}` (never touches `cache/`) |
| POST | `/api/projects/:id/generate` | `{mode?: 'full'}` | `409` if `queued|running`. Upsert 7 `pipeline_runs` rows as `pending`, status → `queued`, `pgboss.send('pipeline', {projectId, mode:'full'}, {singletonKey: projectId})`. → `202 {runs}` |
| POST | `/api/projects/:id/continue` | — | Only from `awaiting_review`. Enqueue `{mode:'continue'}` → `202` |
| POST | `/api/projects/:id/cancel` | — | Set `projects.cancel_requested = now()`, `pgboss.cancel(jobId)`. Worker observes between steps (doc 06). → `202` |
| POST | `/api/projects/:id/rerender` | `{subtitlePreset?, subtitlePosition?, music?, qualityPreset?, aspect?}` | Patch settings, then enqueue the **narrowest** mode: aspect changed → `mode:'full'` (manifests skip what survives); anything else → `mode:'composeOnly'`. → `202 {invalidatedStages[]}` — the UI shows exactly what will re-run |

`cancel_requested timestamptz` is the one column doc 05 gains here; add it in the same migration.

## Beats & storyboard

| Method | Route | Body | Behavior |
|---|---|---|---|
| GET | `/api/projects/:id/beats` | `?withCandidates=true` | Beats ordered by `idx`, each with top-8 candidates by `rank` (thumb URL via `/api/files`), chosen id, score |
| PATCH | `/api/beats/:beatId` | `{chosenCandidateId}` \| `{forcedTextcard: boolean}` | Only while `awaiting_review`. Validates candidate belongs to beat. Changing selection silently invalidates `fetch`+`compose` via hash |
| POST | `/api/beats/:beatId/research` | `{visualDescription?, customQuery?}` | `429` if Pexels/Pixabay budget below reserve (doc 22). Enqueue `beat-research` → `202 {jobId}`. UI polls the beat row / listens on realtime |

## Assets, voices, music

- `GET /api/voices?language=en-US` → `packages/core/src/voices.ts` filtered; `{id, displayName, gender, language, sampleUrl}`.
- `GET /api/voices/:id/sample` → streams `cache/voice-samples/{id}.wav`; on miss, calls sidecar `POST /tts` with the voice's `sampleText` (doc 10), writes cache, streams. `Cache-Control: public, max-age=31536000, immutable`. This is the only route allowed to block ~2 s.
- `GET /api/music` → `music_tracks` rows (+ `?mood=`).
- `POST /api/music/upload` → multipart, ≤ 20 MB, `audio/mpeg|audio/wav` sniffed by magic bytes (not extension), stored `DATA_DIR/uploads/music/{uuid}.{ext}`, inserted as a `music_tracks` row with `license='user-provided'`. Reject anything ffprobe can't decode.

## Files (the only path that serves DATA_DIR)

`GET /api/files/[...path]` — resolves `path.resolve(DATA_DIR, ...segments)` and **rejects unless the resolved path starts with `DATA_DIR` + `/`** (blocks `..`, symlink escapes via `fs.realpath` check). Serves with correct `Content-Type`, `ETag` (mtime+size), and **HTTP Range** support (required for `<video>` seeking). Only `projects/**`, `cache/thumbs/**`, `cache/voice-samples/**`, `assets/music/**` are allowed prefixes; everything else `404`.

## Health & quota

`GET /api/health` runs four checks in parallel with a 2 s timeout each, returns `{ok, checks: {db, sidecar, ffmpeg, keys}}`:
- `db`: `select 1` + pg-boss schema present.
- `sidecar`: `GET {SIDECAR_URL}/health` → passes through `models` + `device`.
- `ffmpeg`: `execa(FFMPEG_PATH ?? 'ffmpeg', ['-version'])`, parse major ≥ 7, assert `--enable-libass` in the build flags.
- `keys`: which of `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `GEMINI_API_KEY`/Ollama reachability are present. Never return key values.

`GET /api/quota` → `{pexels: {hourUsed, hourLimit, monthUsed, monthLimit}, pixabay: {minuteUsed, minuteLimit}}` from `provider_usage`. Drives the settings-screen meters and the storyboard's re-search button state.

## Worker contracts (pg-boss)

```ts
// packages/core/src/jobs.ts
export const PipelineJob = z.object({
  projectId: z.string().uuid(),
  mode: z.enum(['full', 'continue', 'composeOnly']).default('full'),
});
export const BeatResearchJob = z.object({
  projectId: z.string().uuid(), beatId: z.string().uuid(),
  visualDescription: z.string().max(300).optional(), customQuery: z.string().max(120).optional(),
});
```

The **web never writes `pipeline_runs.status`** beyond the initial `pending` upsert, and never writes `beats.narration`, `candidates`, or `renders`. The **worker never writes `projects.settings`**. Violating this split is how progress UIs start lying.

## Client conventions

TanStack Query keys: `['project', id]`, `['beats', id]`, `['quota']`, `['voices', lang]`. Realtime row updates (doc 05) call `queryClient.setQueryData` directly — no refetch storms. Mutations that enqueue jobs invalidate `['project', id]` only after the `202` returns.
