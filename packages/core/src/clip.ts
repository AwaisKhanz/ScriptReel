// Clip intelligence (doc 23 §7) — pure window selection. The worker samples per-frame
// motion (mean absolute frame difference) from a source video; this picks the most
// dynamic window to start on, so a clip doesn't open on a static intro or dead hold.
// Zero I/O (invariant 8). SigLIP is deliberately NOT used here: the 23d calibration
// showed raw cosine is a noisy separator, whereas motion is a clean anti-boring signal.

export interface MotionSample {
  t: number; // seconds from source start
  motion: number; // mean absolute frame difference vs the previous frame (≥ 0)
}

// Start (sec) of the most dynamic window of length `neededSec` within a source of
// `sourceDurationSec`, chosen by highest average motion over the window. Falls back to
// 0 when there is no room to move, no samples, or a degenerate length — matching the
// pre-23e behaviour of starting at the top. Deterministic; ties keep the earliest start.
export function pickBestWindow(
  samples: readonly MotionSample[],
  sourceDurationSec: number,
  neededSec: number,
): number {
  const maxStart = sourceDurationSec - neededSec;
  if (!(maxStart > 0) || samples.length === 0 || !(neededSec > 0)) return 0;

  // samples arrive in time order (ffmpeg emits frames sequentially); be defensive.
  const pts = samples.every((s, i) => i === 0 || s.t >= (samples[i - 1]?.t ?? 0))
    ? samples
    : [...samples].sort((a, b) => a.t - b.t);

  // Two-pointer sliding window over sample indices. Candidate starts are the sample
  // times within [0, maxStart]; `[i, end)` holds the samples in [start, start+neededSec).
  // Each iteration grows `end` forward, scores the mean, then drops sample `i` so the
  // next start begins just after it — O(n).
  let best = { start: 0, mean: -1 };
  let end = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const start = pts[i]?.t ?? 0;
    if (start > maxStart) break; // no full window fits past here
    while (end < pts.length && (pts[end]?.t ?? 0) < start + neededSec) {
      sum += pts[end]?.motion ?? 0;
      count += 1;
      end += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    if (mean > best.mean) best = { start, mean };
    sum -= pts[i]?.motion ?? 0; // slide: sample i leaves the window
    count -= 1;
  }
  return Math.min(Math.max(best.start, 0), maxStart);
}
