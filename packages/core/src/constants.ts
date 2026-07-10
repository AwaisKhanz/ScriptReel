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
