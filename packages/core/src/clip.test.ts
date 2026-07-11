import { describe, expect, it } from 'vitest';
import { type MotionSample, pickBestWindow, splitSegmentFrames } from './clip';

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

describe('splitSegmentFrames', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('splits equally and sums exactly', () => {
    const f = splitSegmentFrames(240, [1, 1, 1]); // 8s @30 → 3 segments
    expect(sum(f)).toBe(240);
    expect(f).toEqual([80, 80, 80]);
  });

  it('respects weights and still sums exactly', () => {
    const f = splitSegmentFrames(200, [1, 3]); // 1:3 → ~50 / ~150
    expect(sum(f)).toBe(200);
    expect(f[1]).toBeGreaterThan(f[0] ?? 0);
  });

  it('absorbs rounding remainder without dropping frames', () => {
    const f = splitSegmentFrames(100, [1, 1, 1]); // 100/3 doesn't divide
    expect(sum(f)).toBe(100);
    expect(f.every((x) => x >= 1)).toBe(true);
  });

  it('every segment gets at least one frame', () => {
    const f = splitSegmentFrames(4, [1, 1, 1, 1]);
    expect(f).toEqual([1, 1, 1, 1]);
    expect(sum(f)).toBe(4);
  });

  it('zero/negative weights fall back to equal share', () => {
    const f = splitSegmentFrames(90, [0, 0, 0]);
    expect(sum(f)).toBe(90);
    expect(f).toEqual([30, 30, 30]);
  });

  it('single segment returns the whole span', () => {
    expect(splitSegmentFrames(150, [1])).toEqual([150]);
  });
});
