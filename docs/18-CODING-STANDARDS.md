# 18 — Coding Standards

## Repo layout

```
scriptreel/
├── apps/
│   ├── web/                 # Next.js 15 — UI + API routes only
│   │   ├── app/(routes)/…   # dashboard, projects/[id], settings
│   │   ├── app/api/…        # doc 15
│   │   ├── components/      # doc 16 inventory
│   │   └── lib/             # query client, realtime hook, fetchers
│   └── worker/              # Node 22 — pg-boss consumer
│       └── src/
│           ├── index.ts             # boot, queues, graceful shutdown
│           ├── pipeline/            # stage runner + 7 stages, one file each
│           ├── providers/           # pexels.ts, pixabay.ts, rate-limiter.ts
│           ├── sidecar/             # typed client for doc 14
│           ├── ffmpeg/              # normalize.ts, compose.ts, probe.ts
│           └── cli.ts               # `pnpm stage <name> --project <id>` harness
├── services/ml/             # Python 3.12 FastAPI sidecar (uv)
├── packages/
│   ├── core/                # zod schemas, types, constants, pure functions
│   │                        #   settings.ts timeline.ts jobs.ts errors.ts
│   │                        #   voices.ts emotion.ts scoring.ts buildTimeline.ts
│   ├── db/                  # postgres.js client, generated types, queries
│   └── config/              # env.ts (zod), paths.ts (DATA_DIR resolution)
├── supabase/migrations/
├── assets/{fonts,music,brand}/
├── docs/                    # this suite
├── data/                    # DATA_DIR, gitignored
└── CLAUDE.md
```

Rules: `packages/core` has **zero I/O** (no fs, no fetch, no db) — it is pure and unit-testable, and that is why `buildTimeline` and `scoreCandidate` live there. `apps/web` may import `core`, `db`, `config`. `apps/worker` may import all three. Nothing imports from an app. No barrel `index.ts` re-export files except each package's public root.

## TypeScript

`strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. `"moduleResolution": "bundler"`. ESM everywhere (`"type": "module"`).

- **No `any`.** `unknown` + a zod parse at every boundary (HTTP body, provider response, LLM output, sidecar response, `JSON.parse` of a manifest). If it crossed a process boundary, it is `unknown` until proven otherwise.
- **No non-null `!`** except immediately after an explicit check with a comment. Prefer `invariant(cond, msg)` from `core` (throws `PipelineError('E_INVARIANT')`).
- Types over interfaces for data; `z.infer<typeof X>` over hand-written duplicates. One source of truth per shape, always the schema.
- No enums — use `as const` unions (`export const STAGES = [...] as const; type Stage = typeof STAGES[number]`).
- Discriminated unions over optional-field soup, especially `TimelineBeat['media']`.
- Filenames `kebab-case.ts`; React components `PascalCase.tsx`; hooks `use-*.ts`.

## Errors

```ts
export class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly stage: PipelineStage | 'api' | 'worker',
    message: string,
    readonly opts: { cause?: unknown; beatIdx?: number; details?: unknown } = {},
  ) { super(message, { cause: opts.cause }); this.name = 'PipelineError'; }
  get retryable() { return RETRYABLE.has(this.code); }
}
```

| Code | Where | Retryable | User-facing sentence (doc 16 maps these) |
|---|---|---|---|
| `E_ENV` | boot | no | A required environment variable is missing. |
| `E_LLM_SCHEMA` | analyze | no | The model returned an unusable beat list. Try re-running analysis. |
| `E_LLM_QUOTA` | analyze | yes (after backoff) | Gemini's free limit is reached. Falls back to Ollama if configured. |
| `E_PROVIDER_HTTP` | search | yes | A stock provider is unreachable. Retrying. |
| `E_QUOTA_PEXELS` / `E_QUOTA_PIXABAY` | search | yes-on-window | Hourly limit reached; searches resume at {time}. |
| `E_NO_CANDIDATES` | score | no | No usable media found for a beat — a text card was used. *(warning, not failure)* |
| `E_TTS_FAIL_BEAT` | tts | no | Narration failed on beat {n}. Try another voice. |
| `E_ALIGN` | align | no | Word timing failed; subtitles use estimated timing. *(warning)* |
| `E_DOWNLOAD` | fetch | yes | A media download failed. Retrying. |
| `E_NORMALIZE` | fetch | no | A clip could not be converted. It was replaced. |
| `E_TIMELINE_INVALID` | compose | no | Internal timeline check failed — this is a bug; copy diagnostics. |
| `E_FFMPEG` | compose | yes (once) | Rendering failed. Last FFmpeg lines are in diagnostics. |
| `E_COMPOSE_VERIFY` | compose | no | The finished file failed its checks. |
| `E_SIDECAR_DOWN` | any | yes | The ML service isn't running. Start it with `pnpm sidecar`. |
| `E_GEN_MEM` | score | no | Not enough free memory for image generation; skipped. *(warning)* |
| `E_DISK_FULL` | fetch/compose | no | Out of disk space in DATA_DIR. |
| `E_CANCELLED` | any | no | Cancelled. |
| `E_INVARIANT` | any | no | Internal check failed — copy diagnostics. |

**Warnings ≠ failures.** `E_NO_CANDIDATES`, `E_ALIGN`, `E_GEN_MEM`, `E_NORMALIZE` are recorded in the stage manifest's `warnings[]` and shown as amber chips; the pipeline continues. A video that degrades gracefully is the product's whole thesis (doc 01). Never `catch {}` — either handle, wrap into `PipelineError` with `cause`, or let it fly.

## Logging

`pino` in the worker, one child logger per stage: `log.child({ projectId, stage })`. Levels: `debug` = per-beat mechanics, `info` = stage boundaries + decisions ("beat 7: ladder rung 3 → conceptual query"), `warn` = degradations, `error` = PipelineError. **Redact** `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL` via pino `redact` and never interpolate a URL containing `key=`. Log durations for every stage and every FFmpeg invocation (`{ ms, argv }` — argv without secrets). No emoji, no `console.log` outside `cli.ts`.

## Subprocesses & async

- `execa(bin, args[], {…})` — **argument arrays only**, never a shell string, never user text concatenated into a filter graph without going through `packages/core`'s escaping helper (`ass` paths need `:` and `\` escaped for the `subtitles=` filter).
- Every child gets a timeout and is killed on cancel (`AbortSignal` threaded from the stage runner).
- No floating promises (`@typescript-eslint/no-floating-promises` as an error). Bounded concurrency via `p-limit` with the doc 06 numbers — never `Promise.all` over an unbounded array of network or FFmpeg calls.
- All fs writes that others read: write to `*.tmp`, `fsync`, `rename`. Manifests last (doc 06).

## Testing

Vitest for TS, pytest for the sidecar. `packages/core` targets 90% line coverage (it's pure — no excuses); stages get integration tests behind `TEST_INTEGRATION=1` using a tiny fixture script and stubbed providers. Property test: `buildTimeline` output satisfies the doc 12 invariants for random beat durations. Details in doc 21.

## Tooling & workflow

Biome (lint+format, tabs off, single quotes, 100 cols) — one command, no eslint/prettier split. Husky pre-commit: `biome check --write && tsc -b && vitest related`. Conventional commits (`feat(worker): …`). Turborepo tasks: `dev`, `build`, `check` (tsc + biome + tests), `db:migrate`, `sidecar`.

**Claude Code phase discipline:** one phase per session, fresh context. Read `CLAUDE.md` + the docs listed for that phase in doc 20 and nothing else. Do not start the next phase in the same session. Do not implement anything a phase doesn't ask for — the roadmap's ordering is load-bearing.
