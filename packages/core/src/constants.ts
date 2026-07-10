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

// Media provider budgets + cache (doc 22 §budgets, doc 08). Enforced by QuotaGuard.
export const PEXELS_HOUR_BUDGET = 190; // of 200; 10 held back
export const PEXELS_MONTH_BUDGET = 19_000; // of 20,000
export const PIXABAY_MINUTE_BUDGET = 90; // of 100
export const RESEARCH_RESERVE = 30; // kept free for storyboard re-search
export const SEARCH_CACHE_TTL_H = 24; // Pixabay requires ≥24 h caching
export const PER_PAGE_VIDEO = 20;
export const PER_PAGE_PHOTO = 15;
export const MAX_CANDIDATES_PER_BEAT = 40;
export const THUMB_MAX_SIDE = 384; // SigLIP input efficiency
