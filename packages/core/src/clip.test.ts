import { describe, expect, it } from 'vitest';
import { type MotionSample, pickBestWindow } from './clip';

// Build 1 sample/sec with the given per-second motion values.
function samples(motions: number[]): MotionSample[] {
  return motions.map((motion, t) => ({ t, motion }));
}

describe('pickBestWindow', () => {
  it('starts on the most dynamic window, not the static intro', () => {
    // 10 s source, static first half, motion in the second half; need a 3 s window.
    const m = samples([0, 0, 0, 0, 0, 9, 9, 9, 0, 0]);
    const start = pickBestWindow(m, 10, 3);
    expect(start).toBeGreaterThanOrEqual(5);
    expect(start).toBeLessThanOrEqual(6);
  });

  it('never returns a window that overruns the source', () => {
    const m = samples([0, 0, 0, 0, 1, 2, 9, 9, 9, 9]); // motion at the very end
    const start = pickBestWindow(m, 10, 4);
    expect(start).toBeLessThanOrEqual(10 - 4); // maxStart = 6
  });

  it('returns 0 when the source is not longer than needed', () => {
    expect(pickBestWindow(samples([5, 5, 5]), 3, 3)).toBe(0);
    expect(pickBestWindow(samples([5, 5, 5]), 2, 5)).toBe(0);
  });

  it('returns 0 with no samples (fallback to top-of-clip)', () => {
    expect(pickBestWindow([], 10, 3)).toBe(0);
  });

  it('prefers the earliest start on a tie', () => {
    const m = samples([5, 5, 5, 5, 5, 5]); // uniform motion → earliest window wins
    expect(pickBestWindow(m, 6, 2)).toBe(0);
  });

  it('tolerates unsorted input', () => {
    const m: MotionSample[] = [
      { t: 6, motion: 9 },
      { t: 0, motion: 0 },
      { t: 5, motion: 9 },
      { t: 1, motion: 0 },
      { t: 7, motion: 9 },
      { t: 2, motion: 0 },
    ];
    const start = pickBestWindow(m, 10, 3);
    expect(start).toBeGreaterThanOrEqual(5);
  });
});
