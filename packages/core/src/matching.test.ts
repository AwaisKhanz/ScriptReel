import { describe, expect, it } from 'vitest';
import {
  baseScore,
  type CandidateFeatures,
  cosine,
  durFit,
  fpsFit,
  orientFit,
  resFit,
  type ScoreContext,
  type SelectionBeat,
  type SelectionCandidate,
  selectBeats,
  varietyPass,
} from './matching';

const ctx: ScoreContext = {
  targetHeight: 1080,
  targetAspect: 16 / 9,
  mixedMode: true,
};
const BEAT_DUR = 4;

function video(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    kind: 'video',
    isIllustration: false,
    width: 1920,
    height: 1080,
    durationSec: 8,
    fps: 30,
    ...overrides,
  };
}

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, handles zero vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('fit functions', () => {
  it('resFit saturates at target and degrades below', () => {
    expect(resFit(1080, 1080)).toBe(1);
    expect(resFit(2000, 1080)).toBe(1);
    expect(resFit(540, 1080)).toBeCloseTo(0.5, 6);
  });
  it('durFit rewards in-window videos and fixes images at 0.8', () => {
    expect(durFit('video', 8, 4)).toBe(1); // 4 ≤ 8 ≤ 16
    expect(durFit('video', 1, 4)).toBeLessThan(1); // too short
    expect(durFit('video', 100, 4)).toBe(0.3); // far too long, floored
    expect(durFit('image', null, 4)).toBe(0.8);
  });
  it('fpsFit: 1 for ≥24fps or image, 0.5 otherwise', () => {
    expect(fpsFit('video', 30)).toBe(1);
    expect(fpsFit('video', 15)).toBe(0.5);
    expect(fpsFit('image', null)).toBe(1);
  });
  it('orientFit peaks at matching aspect', () => {
    expect(orientFit(16 / 9, 16 / 9)).toBeCloseTo(1, 6);
    expect(orientFit(9 / 16, 16 / 9)).toBeLessThan(0.5);
  });
});

describe('baseScore', () => {
  it('is monotonic in sim (higher sim never lowers the score)', () => {
    const f = video();
    let prev = Number.NEGATIVE_INFINITY;
    for (const sim of [-0.2, 0, 0.1, 0.3, 0.5, 0.9]) {
      const s = baseScore(sim, f, ctx, BEAT_DUR).base;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
  it('applies the video bonus only in mixed mode', () => {
    const f = video();
    const mixed = baseScore(0.5, f, ctx, BEAT_DUR).base;
    const notMixed = baseScore(0.5, f, { ...ctx, mixedMode: false }, BEAT_DUR).base;
    expect(mixed).toBeGreaterThan(notMixed);
  });
  it('penalizes illustrations', () => {
    const plain = baseScore(0.5, video(), ctx, BEAT_DUR).base;
    const illo = baseScore(0.5, video({ isIllustration: true }), ctx, BEAT_DUR).base;
    expect(illo).toBeLessThan(plain);
  });
});

function candidate(
  id: string,
  sim: number,
  emb: number[],
  overrides: Partial<SelectionCandidate> = {},
): SelectionCandidate {
  return {
    id,
    assetKey: id,
    author: null,
    features: video(),
    sim,
    thumbEmbedding: emb,
    ...overrides,
  };
}

describe('selectBeats thresholds', () => {
  const th = { tauHi: 0.28, tauLo: 0.2 };
  it('chooses the top candidate above τ_hi, flags weak between, declines below τ_lo', () => {
    // base ≈ 0.62·sim + 0.14·quality + 0.10·orient + 0.04(video). For a 1920×1080/30fps/8s
    // video in a 4s beat, the non-sim terms ≈ 0.28, so sim drives the threshold crossing.
    const beats: SelectionBeat[] = [
      { beatIdx: 0, beatDurationSec: BEAT_DUR, candidates: [candidate('hi', 0.9, [1, 0, 0])] },
      { beatIdx: 1, beatDurationSec: BEAT_DUR, candidates: [candidate('lo', -0.1, [0, 1, 0])] },
    ];
    const sel = selectBeats(beats, ctx, th);
    expect(sel[0]?.chosenId).toBe('hi');
    expect(sel[0]?.weak).toBe(false);
    // A very negative sim drops below τ_lo → no choice (ladder territory).
    const belowLo: SelectionBeat[] = [
      { beatIdx: 0, beatDurationSec: BEAT_DUR, candidates: [candidate('x', -0.6, [1, 0, 0])] },
    ];
    expect(selectBeats(belowLo, ctx, th)[0]?.chosenId).toBeNull();
  });
});

describe('named-subject cross-check (doc 23 §6)', () => {
  const th = { tauHi: 0.28, tauLo: 0.2 };
  // base ≈ 0.62·sim + 0.28 for the video fixture: sim=-0.05 → weak band, sim≥0 → strong.
  const WEAK = -0.05;
  const STRONG = 0.1;

  const named = (candidates: SelectionCandidate[]): SelectionBeat => ({
    beatIdx: 0,
    beatDurationSec: BEAT_DUR,
    candidates,
    namedSubject: true,
  });

  it('rejects a weak-tier archive stand-in on a named-subject beat', () => {
    const sel = selectBeats(
      [named([candidate('arc', WEAK, [1, 0, 0], { isArchive: true })])],
      ctx,
      th,
    );
    expect(sel[0]?.chosenId).toBeNull(); // falls through to the ladder, not a stand-in
  });

  it('still accepts a weak stock candidate on a named beat (only archives are gated)', () => {
    const sel = selectBeats([named([candidate('stock', WEAK, [1, 0, 0])])], ctx, th);
    expect(sel[0]?.chosenId).toBe('stock');
    expect(sel[0]?.weak).toBe(true);
  });

  it('accepts a weak archive candidate on a generic (unnamed) beat', () => {
    const generic: SelectionBeat = {
      beatIdx: 0,
      beatDurationSec: BEAT_DUR,
      candidates: [candidate('arc', WEAK, [1, 0, 0], { isArchive: true })],
    };
    expect(selectBeats([generic], ctx, th)[0]?.chosenId).toBe('arc');
  });

  it('prefers a confident archive match over a higher-scoring stock stand-in', () => {
    const sel = selectBeats(
      [
        named([
          candidate('stock', 0.2, [1, 0, 0]), // higher base score
          candidate('arc', STRONG, [0, 1, 0], { isArchive: true }), // clears τ_hi
        ]),
      ],
      ctx,
      th,
    );
    expect(sel[0]?.chosenId).toBe('arc'); // the actual named subject wins
    expect(sel[0]?.weak).toBe(false);
  });
});

describe('sequential penalties', () => {
  const th = { tauHi: -10, tauLo: -10 }; // force a choice every beat, isolate ranking

  it('reuse penalty demotes an already-chosen asset', () => {
    // beat0 chooses asset "A". beat1 offers A again (higher sim) vs fresh B (lower sim).
    // The 0.15 reuse penalty on A (×0.62·Δsim=0.031 gap) flips the ranking to B.
    const beats: SelectionBeat[] = [
      { beatIdx: 0, beatDurationSec: BEAT_DUR, candidates: [candidate('A', 0.8, [1, 0, 0])] },
      {
        beatIdx: 1,
        beatDurationSec: BEAT_DUR,
        candidates: [
          candidate('A2', 0.85, [1, 0, 0], { assetKey: 'A' }),
          candidate('B', 0.8, [0, 1, 0], { assetKey: 'B' }),
        ],
      },
    ];
    const sel = selectBeats(beats, ctx, th);
    expect(sel[1]?.chosenId).toBe('B'); // A2 demoted below B by the reuse penalty
  });

  it('near-dup penalty demotes a visual near-duplicate of the previous beat', () => {
    // beat0 chosen thumb ≈ [1,0,0]. beat1: near-dup of it (cosine≈1) vs a distinct thumb.
    const beats: SelectionBeat[] = [
      { beatIdx: 0, beatDurationSec: BEAT_DUR, candidates: [candidate('P', 0.8, [1, 0, 0])] },
      {
        beatIdx: 1,
        beatDurationSec: BEAT_DUR,
        candidates: [
          candidate('dup', 0.83, [0.999, 0.001, 0]), // cosine≈1 with P > 0.92 → penalized
          candidate('fresh', 0.8, [0, 0, 1]),
        ],
      },
    ];
    const sel = selectBeats(beats, ctx, th);
    expect(sel[1]?.chosenId).toBe('fresh');
  });

  it('monotony penalty demotes a repeat of the previous author', () => {
    const beats: SelectionBeat[] = [
      {
        beatIdx: 0,
        beatDurationSec: BEAT_DUR,
        candidates: [candidate('a0', 0.8, [1, 0, 0], { author: 'Ann' })],
      },
      {
        beatIdx: 1,
        beatDurationSec: BEAT_DUR,
        candidates: [
          candidate('same', 0.81, [0, 1, 0], { author: 'Ann' }),
          candidate('other', 0.8, [0, 0, 1], { author: 'Bob' }),
        ],
      },
    ];
    const sel = selectBeats(beats, ctx, th);
    expect(sel[1]?.chosenId).toBe('other');
  });
});

describe('varietyPass', () => {
  it('re-selects beats when one author dominates > 60% of choices', () => {
    const th = { tauHi: -10, tauLo: -10 };
    // 3 beats, each with an "Ann" option and a "Bob" option. The sim gap
    // (0.62·0.08 ≈ 0.05) survives the single monotony penalty (0.04) so the first
    // pass picks Ann everywhere (100% > 60%), but not the doubled penalty (0.08),
    // so the variety pass must move at least one beat off Ann.
    // Orthogonal one-hot thumbs (dim 8) so no near-dup penalties fire — only the
    // author-monotony penalty is in play, isolating the variety behavior.
    const oneHot = (k: number): number[] => Array.from({ length: 8 }, (_, j) => (j === k ? 1 : 0));
    const beat = (i: number): SelectionBeat => ({
      beatIdx: i,
      beatDurationSec: BEAT_DUR,
      candidates: [
        candidate(`ann${i}`, 0.9, oneHot(2 * i), { author: 'Ann', assetKey: `ann${i}` }),
        candidate(`bob${i}`, 0.82, oneHot(2 * i + 1), { author: 'Bob', assetKey: `bob${i}` }),
      ],
    });
    const beats = [beat(0), beat(1), beat(2)];
    const first = selectBeats(beats, ctx, th);
    expect(first.every((s) => s.chosenId?.startsWith('ann'))).toBe(true);
    const varied = varietyPass(beats, first, ctx, th);
    const annCount = varied.filter((s) => s.chosenId?.startsWith('ann')).length;
    expect(annCount).toBeLessThan(3);
  });
});
