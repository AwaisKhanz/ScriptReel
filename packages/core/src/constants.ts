import type { PipelineStage } from './jobs';

// Render frame rate is fixed at 30 (doc 02 §3, doc 12).
export const FPS = 30;
export const FRAME_SEC = 1 / FPS;

// Overall progress weighting for the UI (doc 06); weights sum to 100.
export const PROGRESS_WEIGHTS: Readonly<Record<PipelineStage, number>> = {
  analyze: 8,
  search: 14,
  score: 10,
  tts: 14,
  align: 6,
  fetch: 22,
  compose: 26,
};

// Narration pacing — words/sec (chars/sec for CJK). [CALIBRATE] owned by Phase 3
// (doc 10 baseWps); doc 07 uses these for the analyze duration estimate.
export const BASE_WPS: Readonly<Record<string, number>> = {
  'en-US': 2.7,
  'en-GB': 2.7,
  es: 2.9,
  fr: 2.8,
  hi: 2.5,
  it: 2.9,
  'pt-BR': 2.8,
  ja: 5.5,
  zh: 4.5,
};
export const DEFAULT_WPS = 2.7;
export const CJK_LANGUAGES = ['ja', 'zh'] as const;

// Merge/split thresholds for the analyze post-pass (doc 07 §post-pass).
export const MERGE_MIN_SEC = 2.5;
export const SPLIT_MAX_SEC = 12;

// Media provider budgets + cache (doc 22 §budgets, doc 08). These are the real
// documented free-tier limits and act only as the pre-test estimate — the per-key
// "Test" action reads each key's TRUE limit live from the provider (x-ratelimit-*
// headers / Openverse rate_limit endpoint), which can be higher (doc 23 §4).
export const PEXELS_HOUR_BUDGET = 200; // Pexels free: 200 req/hour
export const PEXELS_MONTH_BUDGET = 20_000; // Pexels free: 20,000 req/month
export const PIXABAY_MINUTE_BUDGET = 100; // Pixabay free: 100 req / 60 s
export const OPENVERSE_DAY_BUDGET = 10_000; // Openverse registered (OAuth) tier ≈ 10k/day; anon ≈ 100/day
export const NASA_HOUR_BUDGET = 1_000; // NASA images-api has no published cap; self-imposed polite ceiling
export const WIKIMEDIA_HOUR_BUDGET = 1_000; // Commons API has no hard key cap; self-imposed polite ceiling
export const RESEARCH_RESERVE = 30; // kept free for storyboard re-search
export const SEARCH_CACHE_TTL_H = 24; // Pixabay requires ≥24 h caching
export const PER_PAGE_VIDEO = 20;
export const PER_PAGE_PHOTO = 15;
export const MAX_CANDIDATES_PER_BEAT = 40;
export const STORYBOARD_CANDIDATES = 5; // swap alternates shown per beat (keep it scannable)
export const THUMB_MAX_SIDE = 384; // SigLIP input efficiency

// Matching / scoring weights (doc 09 §step 2). Fixed formula terms.
export const SCORE_WEIGHTS = {
  sim: 0.62,
  quality: 0.14,
  orient: 0.1,
  video: 0.04, // motion premium, mixed mode only
  illustration: 0.05, // subtracted
} as const;
export const QUALITY_WEIGHTS = { res: 0.5, dur: 0.3, fps: 0.2 } as const;

// Sequential selection penalties (doc 09 §step 2). Applied during greedy selection.
export const REUSE_PENALTY = 0.15; // same asset already chosen this project
export const DUP_PENALTY = 0.1; // near-duplicate of the adjacent beat
export const MONOTONY_PENALTY = 0.04; // same author as the previous chosen beat
export const DUP_COSINE = 0.92; // thumb cosine above this = visual near-duplicate

// Montage planning (doc 23 §7). A beat long enough to hold several visuals is split
// into a mini-sequence of diverse clips instead of one static hold — the anti-boring
// lever. [CALIBRATE 23e]
export const MONTAGE_TARGET_SEG_SEC = 3.0; // aim for ~3 s per montage segment
export const MONTAGE_MAX_SEGMENTS = 3; // never fragment a beat past this
export const MONTAGE_MIN_SEG_SEC = 1.8; // a segment shorter than this feels like a flash
export const MONTAGE_DIVERSITY_COSINE = 0.85; // segments must differ (thumb cosine ≤ this)
// Kind mixing (photo ⇄ video) inside a montage: when every segment so far is one kind,
// prefer the best other-kind candidate if it ranks within this window for the slot —
// rank-based (no absolute sim threshold), so it needs no re-calibration. [CALIBRATE 23e]
export const MONTAGE_MIX_RANK = 5;

// Greedy selection thresholds in base-score space. SigLIP cosine ranges are
// model-specific — these were CALIBRATED in Phase 6 from 30 labeled pairs (G1–G3)
// with siglip2-base-patch16-224: τ_hi = 90%-precision point, τ_lo = 70%-precision
// point (`pnpm eval:matching`, precision@1 = 100%). Re-run and re-fit on any model
// or formula change (doc 09 §step 3, doc 21). Scores compress near ~0.30 because the
// non-sim quality/orient terms are ~constant for HD stock video.
export const TAU_HI = 0.322; // [CALIBRATE Phase 6] choose outright
export const TAU_LO = 0.314; // [CALIBRATE Phase 6] choose but flag 'weak'
export const TAU_MOOD = 0.28; // [CALIBRATE Phase 7] mood-tier accept < τ_lo
