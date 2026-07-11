import { PROGRESS_WEIGHTS } from './constants';
import { type PipelineStage, STAGES } from './jobs';

// Overall pipeline progress for the UI (doc 06 §Overall progress weighting):
// weighted sum of per-stage percent, weights sum to 100. done/skipped count as 100.
// Monotonic as long as stages only advance (never regress), and hits exactly 100
// when every stage is done or skipped.

export interface StageProgress {
  stage: PipelineStage;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  progress: number; // 0..100
}

export function overallProgress(runs: readonly StageProgress[]): number {
  const byStage = new Map(runs.map((r) => [r.stage, r]));
  let total = 0;
  for (const stage of STAGES) {
    const run = byStage.get(stage);
    const pct = !run
      ? 0
      : run.status === 'done' || run.status === 'skipped'
        ? 100
        : Math.max(0, Math.min(100, run.progress));
    total += PROGRESS_WEIGHTS[stage] * pct;
  }
  return Math.round(total / 100); // weights sum to 100 → 0..100
}
