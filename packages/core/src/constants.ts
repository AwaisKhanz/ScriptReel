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
  es: 2.6,
  fr: 2.5,
  hi: 2.4,
  it: 2.6,
  'pt-BR': 2.6,
  ja: 5.5,
  zh: 5.0,
};
export const DEFAULT_WPS = 2.7;
export const CJK_LANGUAGES = ['ja', 'zh'] as const;

// Merge/split thresholds for the analyze post-pass (doc 07 §post-pass).
export const MERGE_MIN_SEC = 2.5;
export const SPLIT_MAX_SEC = 12;
