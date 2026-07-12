import { describe, expect, it } from 'vitest';
import {
  type MomentInput,
  type MontageCandidate,
  type MotionSample,
  pickBestWindow,
  pickBestWindows,
  planMontage,
  planSameSourceMontage,
  planSemanticMontage,
  splitSegmentFrames,
} from './clip';

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

describe('pickBestWindows (same-source montage)', () => {
  it('returns non-overlapping windows, most dynamic first-served, sorted by time', () => {
    // motion peaks around t=5..7 and t=14..16 in a 20s source; need 2× 3s windows
    const motions = Array.from({ length: 20 }, (_, t) =>
      (t >= 5 && t <= 7) || (t >= 14 && t <= 16) ? 9 : 0.1,
    );
    const w = pickBestWindows(samples(motions), 20, 3, 2);
    expect(w).toHaveLength(2);
    expect(w[0]).toBeLessThan(w[1] ?? 0);
    expect(Math.abs((w[0] ?? 0) - (w[1] ?? 0))).toBeGreaterThanOrEqual(3); // disjoint
  });

  it('always returns exactly `count` starts, even without motion samples', () => {
    const w = pickBestWindows([], 30, 4, 3);
    expect(w).toHaveLength(3);
    // distinct starting points even with no signal (low-discrepancy spread)
    expect(new Set(w.map((x) => x.toFixed(2))).size).toBe(3);
  });

  it('degenerate source (no room) → zeros, never throws', () => {
    expect(pickBestWindows(samples([1, 1]), 2, 3, 2)).toEqual([0, 0]);
  });
});

describe('planSameSourceMontage', () => {
  const cand = (
    id: string,
    kind: 'video' | 'image',
    durationSec: number | null,
  ): MontageCandidate => ({ id, kind, score: 0.5, thumbEmbedding: [1, 0, 0], durationSec });

  it('cuts a long chosen video into multiple windows of itself', () => {
    const plan = planSameSourceMontage('v', [cand('v', 'video', 26)], 8);
    expect(plan).not.toBeNull();
    expect((plan ?? []).length).toBeGreaterThanOrEqual(2);
    expect((plan ?? []).every((p) => p.candidateId === 'v')).toBe(true);
  });

  it('refuses when the source has no spare footage or is an image', () => {
    expect(planSameSourceMontage('v', [cand('v', 'video', 9)], 8)).toBeNull(); // < 1.5×
    expect(planSameSourceMontage('i', [cand('i', 'image', null)], 8)).toBeNull();
  });

  it('refuses for beats too short to montage', () => {
    expect(planSameSourceMontage('v', [cand('v', 'video', 30)], 3)).toBeNull();
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

describe('planMontage', () => {
  const cand = (
    id: string,
    score: number,
    e: number[],
    kind: 'video' | 'image' = 'video',
  ): MontageCandidate => ({ id, kind, score, thumbEmbedding: e });

  it('montages a long beat into diverse segments, chosen first', () => {
    const cands = [
      cand('a', 0.9, [1, 0, 0]),
      cand('b', 0.85, [0, 1, 0]),
      cand('c', 0.8, [0, 0, 1]),
    ];
    const plan = planMontage('a', cands, 9);
    expect(plan).not.toBeNull();
    expect(plan?.[0]?.candidateId).toBe('a'); // chosen leads
    expect((plan ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for a beat too short to hold two segments', () => {
    expect(planMontage('a', [cand('a', 0.9, [1, 0, 0]), cand('b', 0.8, [0, 1, 0])], 3)).toBeNull();
  });

  it('returns null when every alternate is a near-duplicate of the chosen', () => {
    const cands = [
      cand('a', 0.9, [1, 0, 0]),
      cand('b', 0.85, [1, 0, 0]),
      cand('c', 0.8, [0.99, 0.01, 0]),
    ];
    expect(planMontage('a', cands, 9)).toBeNull();
  });

  it('caps segment count at MONTAGE_MAX_SEGMENTS', () => {
    const cands = [
      cand('a', 0.9, [1, 0, 0]),
      cand('b', 0.85, [0, 1, 0]),
      cand('c', 0.8, [0, 0, 1]),
      cand('d', 0.75, [0.7, 0, 0.7]),
    ];
    expect((planMontage('a', cands, 30) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('returns null when the chosen candidate is not in the pool', () => {
    expect(planMontage('x', [cand('a', 0.9, [1, 0, 0])], 9)).toBeNull();
  });
});

describe('montage kind mixing (photo ⇄ video)', () => {
  const c = (
    id: string,
    kind: 'video' | 'image',
    score: number,
    e: number[],
  ): MontageCandidate => ({ id, kind, score, thumbEmbedding: e });

  it('diverse montage pulls in the best image when every pick so far is video', () => {
    const cands = [
      c('v1', 'video', 0.9, [1, 0, 0]), // chosen
      c('v2', 'video', 0.85, [0, 1, 0]), // top alternate by score
      c('i1', 'image', 0.8, [0, 0, 1]), // image within the rank window
    ];
    const plan = planMontage('v1', cands, 9);
    expect(plan?.map((p) => p.candidateId)).toContain('i1');
  });

  it('semantic shots are image-first: a well-ranked image beats the video top', () => {
    const cands = [
      c('v1', 'video', 0.5, [1, 0, 0]),
      c('v2', 'video', 0.5, [0, 1, 0]),
      c('v3', 'video', 0.5, [0, 0, 1]),
      c('i1', 'image', 0.5, [0, 0.9, 0.44]),
    ];
    const moments = [
      { embedding: [1, 0, 0], weight: 1 }, // → v1 (no image ranks in the window)
      { embedding: [0, 1, 0], weight: 1 }, // v2 tops, but i1 ranks 2nd → image wins
    ];
    const plan = planSemanticMontage(moments, cands);
    expect(plan?.map((p) => p.candidateId)).toEqual(['v1', 'i1']);
    expect(plan?.map((p) => p.momentIdx)).toEqual([0, 1]);
  });

  it('no other-kind candidate available → keeps the top pick (no forced mix)', () => {
    const cands = [
      c('v1', 'video', 0.9, [1, 0, 0]),
      c('v2', 'video', 0.8, [0, 1, 0]),
      c('v3', 'video', 0.7, [0, 0, 1]),
    ];
    const plan = planMontage('v1', cands, 9);
    expect(plan?.length).toBeGreaterThanOrEqual(2); // still montages, all video
  });
});

describe('planSemanticMontage', () => {
  const cand = (id: string, e: number[]): MontageCandidate => ({
    id,
    kind: 'image',
    score: 0.5,
    thumbEmbedding: e,
  });
  const moment = (e: number[], weight = 1): MomentInput => ({ embedding: e, weight });

  it('assigns each moment its best-matching distinct candidate, in order', () => {
    const cands = [cand('morning', [1, 0, 0]), cand('subway', [0, 1, 0]), cand('gate', [0, 0, 1])];
    const plan = planSemanticMontage([moment([0, 1, 0]), moment([0, 0, 1])], cands);
    expect(plan?.map((p) => p.candidateId)).toEqual(['subway', 'gate']);
  });

  it('carries the moment weights through', () => {
    const cands = [cand('a', [1, 0, 0]), cand('b', [0, 1, 0])];
    const plan = planSemanticMontage([moment([1, 0, 0], 3), moment([0, 1, 0], 5)], cands);
    expect(plan?.map((p) => p.weight)).toEqual([3, 5]);
  });

  it('drops a moment with no distinct match (all candidates already used)', () => {
    const cands = [cand('a', [1, 0, 0])];
    // two moments both map best to 'a'; only one can be assigned → < 2 → null
    expect(planSemanticMontage([moment([1, 0, 0]), moment([1, 0, 0])], cands)).toBeNull();
  });

  it('returns null when fewer than two moments can be assigned', () => {
    expect(planSemanticMontage([moment([1, 0, 0])], [cand('a', [1, 0, 0])])).toBeNull();
  });
});
