import { describe, expect, it } from 'vitest';
import { STAGES } from './jobs';
import { overallProgress, type StageProgress } from './progress';

const runs = (overrides: Partial<Record<string, Partial<StageProgress>>> = {}): StageProgress[] =>
  STAGES.map((stage) => ({
    stage,
    status: 'pending' as const,
    progress: 0,
    ...overrides[stage],
  }));

describe('overallProgress', () => {
  it('is 0 when nothing has started and 100 when all done/skipped', () => {
    expect(overallProgress(runs())).toBe(0);
    expect(
      overallProgress(runs(Object.fromEntries(STAGES.map((s) => [s, { status: 'done' }])))),
    ).toBe(100);
  });

  it('counts skipped as complete', () => {
    const all = Object.fromEntries(STAGES.map((s) => [s, { status: 'skipped' as const }]));
    expect(overallProgress(runs(all))).toBe(100);
  });

  it('is monotonic as stages advance', () => {
    let prev = -1;
    const state: Record<string, Partial<StageProgress>> = {};
    for (const stage of STAGES) {
      for (const pct of [25, 50, 75, 100]) {
        state[stage] = { status: pct === 100 ? 'done' : 'running', progress: pct };
        const now = overallProgress(runs(state));
        expect(now).toBeGreaterThanOrEqual(prev);
        prev = now;
      }
    }
    expect(prev).toBe(100);
  });

  it('weights fetch+compose heaviest (doc 06)', () => {
    const early = runs({ analyze: { status: 'done' } }); // weight 8
    const late = runs({ compose: { status: 'running', progress: 50 } }); // weight 26 → 13
    expect(overallProgress(late)).toBeGreaterThan(overallProgress(early));
  });
});
