# ScriptReel — Documentation Suite Index

**Project:** ScriptReel (working title — rename is a global find/replace)
**Type:** AI script-to-video generator. Local-first, free-stack, Apple Silicon optimized.
**Owner:** Awais / Oryntaa
**Doc version:** 1.0 — 2026-07-07
**Status:** Stack locked. Ready for Claude Code execution.

---

## How to use this suite with Claude Code

1. Read in this order before writing any code: `00 → 03 → 04 → 18 → 12 → 06`.
2. Execute `20-ROADMAP.md` phase by phase, **in order**. Never start a phase before the previous phase's exit criteria are met and demonstrated.
3. Every spec doc is authoritative for its domain. If two docs conflict, the more specific doc wins (e.g. `13-COMPOSITION-SPEC` beats `03-ARCHITECTURE` on FFmpeg details).
4. Numeric constants marked `[CALIBRATE]` are starting values, tuned during the phase that owns them. Do not treat them as final.
5. Anything not specified here is decided by `18-CODING-STANDARDS.md` conventions, then by simplest-correct implementation. Do not invent features.

## Document map

| # | File | Owns |
|---|------|------|
| 00 | INDEX | This file. Reading order, rules of engagement |
| 01 | PRODUCT-BRIEF | Vision, users, v1 scope, non-goals |
| 02 | FEATURES | Every feature and control, defaults, ranges |
| 03 | ARCHITECTURE | Processes, data flow, seams, directory layout |
| 04 | TECH-STACK | Locked versions, licenses, why each choice |
| 05 | DATA-MODEL | Postgres schema (Supabase local), enums, realtime |
| 06 | PIPELINE-SPEC | Stage state machine, jobs, progress, resume |
| 07 | SCRIPT-ANALYSIS | LLM beat segmentation: prompts, schemas, validation |
| 08 | MEDIA-SEARCH | Providers, endpoints, quotas, caching, credits |
| 09 | MATCHING-ALGORITHM | Candidate scoring, selection, fallback ladder |
| 10 | TTS-SPEC | Kokoro voices, chunking, loudness, previews |
| 11 | SUBTITLES-ALIGNMENT | Forced alignment, ASS styles, karaoke, CJK |
| 12 | TIMELINE-SCHEMA | The timeline JSON contract (brain ↔ renderer) |
| 13 | COMPOSITION-SPEC | FFmpeg graphs: normalize, Ken Burns, xfade, audio |
| 14 | ML-SIDECAR | Python FastAPI service, models, MPS/MLX |
| 15 | API-SPEC | Next.js routes and worker contracts |
| 16 | FRONTEND-SPEC | Pages, wizard, storyboard review, progress UX |
| 17 | DESIGN-SYSTEM | Tokens, Tailwind v4 theme, components, subtitle presets |
| 18 | CODING-STANDARDS | Monorepo layout, strict TS, errors, logging |
| 19 | SETUP-MACOS | M3 Pro environment: brew, models, env vars |
| 20 | ROADMAP | 15 phases (0–14) with exit criteria |
| 21 | TESTING-QUALITY | Golden scripts, stage tests, visual QA rubric |
| 22 | RISKS-LIMITS-LICENSES | Quota math, license table, mitigations |
| 23 | EXPANDED-SOURCING | Copyright-free archive providers, license gate, clip intelligence (post-v1) |
| — | `CLAUDE.md` (repo root) | Commands, invariants, working rules for Claude Code |

## Core invariants (memorize)

- **The timeline JSON (doc 12) is the only contract between analysis/matching ("brain") and FFmpeg ("renderer").** The renderer never calls an AI. The brain never calls FFmpeg (except asset probes).
- **Narration is the clock.** Measured voiceover durations drive every visual duration. Never the reverse.
- **Every stage is idempotent and resumable** from on-disk manifests (doc 06).
- **All external media is downloaded to the local cache before composition.** No hotlinking into renders.
- **English queries always** — search providers are English-indexed regardless of script language (doc 07).
- **Free-tier quotas are a hard budget** (doc 22). The search layer must never fire an uncached, unbudgeted request.
