import {
  MONTAGE_DIVERSITY_COSINE,
  MONTAGE_HARD_MIN_SEG_SEC,
  MONTAGE_MAX_SEGMENTS,
  MONTAGE_MIN_SEG_SEC,
  MONTAGE_MIX_RANK,
  MONTAGE_SAME_SOURCE_FACTOR,
  MONTAGE_TARGET_SEG_SEC,
} from './constants';
import { cosine } from './matching';

// Clip intelligence (doc 23 §7) — pure window selection. The worker samples per-frame
// motion (mean absolute frame difference) from a source video; this picks the most
// dynamic window to start on, so a clip doesn't open on a static intro or dead hold.
// Zero I/O (invariant 8). SigLIP is deliberately NOT used here: the 23d calibration
// showed raw cosine is a noisy separator, whereas motion is a clean anti-boring signal.

export interface MotionSample {
  t: number; // seconds from source start
  motion: number; // mean absolute frame difference vs the previous frame (≥ 0)
}

// Candidate window starts with their mean motion: a two-pointer sliding window over
// sample indices. Candidate starts are the sample times within [0, maxStart]; `[i, end)`
// holds the samples in [start, start+neededSec). O(n).
function windowMeans(
  samples: readonly MotionSample[],
  maxStart: number,
  neededSec: number,
): { start: number; mean: number }[] {
  // samples arrive in time order (ffmpeg emits frames sequentially); be defensive.
  const pts = samples.every((s, i) => i === 0 || s.t >= (samples[i - 1]?.t ?? 0))
    ? samples
    : [...samples].sort((a, b) => a.t - b.t);
  const out: { start: number; mean: number }[] = [];
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
    out.push({ start, mean: count > 0 ? sum / count : 0 });
    sum -= pts[i]?.motion ?? 0; // slide: sample i leaves the window
    count -= 1;
  }
  return out;
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
  let best = { start: 0, mean: -1 };
  for (const w of windowMeans(samples, maxStart, neededSec)) {
    if (w.mean > best.mean) best = w;
  }
  return Math.min(Math.max(best.start, 0), maxStart);
}

// The golden-ratio low-discrepancy sequence: occurrence 0 lands mid-span (the pre-23e
// centered default), later occurrences spread evenly without clustering.
function spreadFraction(occurrence: number): number {
  return (0.5 + 0.618033988749895 * occurrence) % 1;
}

// `count` window starts (sec, ascending) for repeated use of ONE source within a beat
// (same-source montage, doc 23 §7b): the most dynamic non-overlapping windows first,
// topped up with a deterministic low-discrepancy spread when the motion signal can't
// supply enough — so consecutive cuts from the same video always show different footage.
// Always returns exactly `count` starts (they may overlap only when the source is too
// short for `count` disjoint windows).
export function pickBestWindows(
  samples: readonly MotionSample[],
  sourceDurationSec: number,
  neededSec: number,
  count: number,
): number[] {
  const n = Math.max(1, Math.round(count));
  const maxStart = sourceDurationSec - neededSec;
  if (!(maxStart > 0) || !(neededSec > 0)) return new Array(n).fill(0);

  const chosen: number[] = [];
  const ranked = windowMeans(samples, maxStart, neededSec).sort((a, b) => b.mean - a.mean);
  for (const w of ranked) {
    if (chosen.length >= n) break;
    if (chosen.every((s) => Math.abs(s - w.start) >= neededSec)) chosen.push(w.start);
  }
  for (let occ = 0; chosen.length < n && occ < n * 8; occ += 1) {
    const start = maxStart * spreadFraction(occ);
    if (chosen.every((s) => Math.abs(s - start) >= neededSec)) chosen.push(start);
  }
  while (chosen.length < n) {
    chosen.push(maxStart * ((chosen.length + 0.5) / n)); // last resort: may overlap
  }
  return chosen.sort((a, b) => a - b);
}

// Split a beat's frame count across N montage segments by weight (doc 23 §7). Each
// segment gets ≥ 1 frame and Σ === totalFrames exactly, so the concatenated sub-clips
// fill the beat's narration span to the frame. Weights ≤ 0 fall back to equal share.
// Requires totalFrames ≥ weights.length (the caller only montages beats long enough).
export function splitSegmentFrames(totalFrames: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n <= 1) return [Math.max(1, Math.round(totalFrames))];
  const total = Math.max(n, Math.round(totalFrames));
  const clean = weights.map((w) => (w > 0 ? w : 0));
  const wsum = clean.reduce((a, b) => a + b, 0);
  const frames = clean.map((w) =>
    Math.max(1, Math.round((total * (wsum > 0 ? w : 1 / n)) / (wsum > 0 ? wsum : 1))),
  );
  // Reconcile rounding to hit `total` exactly, always keeping every segment ≥ 1.
  let diff = total - frames.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    let idx = 0;
    if (diff > 0) {
      for (let i = 1; i < n; i += 1) if ((frames[i] ?? 0) > (frames[idx] ?? 0)) idx = i;
      frames[idx] = (frames[idx] ?? 0) + 1;
      diff -= 1;
    } else {
      idx = -1;
      for (let i = 0; i < n; i += 1) {
        if ((frames[i] ?? 0) > 1 && (idx < 0 || (frames[i] ?? 0) > (frames[idx] ?? 0))) idx = i;
      }
      if (idx < 0) break; // everything is at 1 — cannot shrink further
      frames[idx] = (frames[idx] ?? 0) - 1;
      diff += 1;
    }
  }
  return frames;
}

export interface MontageCandidate {
  id: string;
  kind: 'video' | 'image';
  score: number;
  thumbEmbedding: readonly number[];
  durationSec?: number | null; // videos: provider-reported length (same-source montage)
}

export interface SegmentPlanItem {
  candidateId: string;
  weight: number;
  // Which visual moment this segment illustrates (semantic plans only) — lets the
  // media-fit verifier check the shot against its exact sub-phrase (doc 23 §6).
  momentIdx?: number;
}

// How many segments a beat of this length should hold (doc 23 §7): ~one per
// MONTAGE_TARGET_SEG_SEC, capped, and never shorter than MONTAGE_MIN_SEG_SEC each.
function montageTarget(beatDurationSec: number): number {
  return Math.min(
    MONTAGE_MAX_SEGMENTS,
    Math.max(1, Math.round(beatDurationSec / MONTAGE_TARGET_SEG_SEC)),
    Math.floor(beatDurationSec / MONTAGE_MIN_SEG_SEC),
  );
}

// Kind mixing (doc 23 §7b): a montage that is all-video (or all-photo) so far takes
// the best other-kind candidate for the next slot instead, provided it ranks within
// MONTAGE_MIX_RANK of the slot's best-first ordering. Rank-based — no absolute sim
// threshold to calibrate — so a strong photo joins a video sequence (and vice versa),
// giving the photo+video texture of an edited documentary rather than wall-to-wall
// stock video.
function pickWithKindMix(
  eligible: readonly MontageCandidate[], // best-first for this slot
  picked: readonly MontageCandidate[],
): MontageCandidate | null {
  const top = eligible[0];
  if (!top) return null;
  const firstKind = picked[0]?.kind;
  const monotone = firstKind !== undefined && picked.every((p) => p.kind === firstKind);
  if (!monotone || top.kind !== firstKind) return top;
  const other = eligible.slice(0, MONTAGE_MIX_RANK).find((c) => c.kind !== firstKind);
  return other ?? top;
}

// Documentary bias for SEMANTIC shots (doc 23 §7b): a moment renders as a STILL image
// (photo + slow zoom) unless a video clearly out-matches every image — premium
// explainer b-roll is mostly precise stills, and stills are what archives supply for
// factual subjects. Rank-window scaled to the pool so tiny pools can't force a barely
// related image over a well-matched video.
function pickImageFirst(eligible: readonly MontageCandidate[]): MontageCandidate | null {
  const top = eligible[0];
  if (!top || top.kind === 'image') return top ?? null;
  const window = Math.min(MONTAGE_MIX_RANK, Math.ceil(eligible.length / 2));
  const image = eligible.slice(0, window).find((c) => c.kind === 'image');
  return image ?? top;
}

// Plan a beat's visual montage (doc 23 §7) from its scored candidates. Anchors on the
// chosen clip, then adds the highest-scoring alternates that are visually DISTINCT from
// what's already picked (thumb cosine ≤ MONTAGE_DIVERSITY_COSINE), so the sequence looks
// varied rather than three near-identical shots — mixing photo and video (kind-mix rule
// above). Segment count is bounded so each holds ≥ MONTAGE_MIN_SEG_SEC. Returns null
// (⇒ single visual, unchanged) when the beat is too short or its candidates are all
// near-duplicates of the chosen one. Equal weights.
export function planMontage(
  chosenId: string,
  candidates: readonly MontageCandidate[],
  beatDurationSec: number,
  diversityCosine: number = MONTAGE_DIVERSITY_COSINE,
): SegmentPlanItem[] | null {
  const target = montageTarget(beatDurationSec);
  if (target < 2) return null;

  const chosen = candidates.find((c) => c.id === chosenId);
  if (!chosen) return null;

  const picked: MontageCandidate[] = [chosen];
  const rest = candidates.filter((c) => c.id !== chosenId).sort((a, b) => b.score - a.score);
  while (picked.length < target) {
    const eligible = rest.filter(
      (c) =>
        !picked.includes(c) &&
        picked.every((p) => cosine(c.thumbEmbedding, p.thumbEmbedding) <= diversityCosine),
    );
    const next = pickWithKindMix(eligible, picked);
    if (!next) break;
    picked.push(next);
  }
  if (picked.length < 2) return null;
  return picked.map((c) => ({ candidateId: c.id, weight: 1 }));
}

// Last rung of the montage ladder (doc 23 §7b): when every alternate is a near-dupe,
// cut the chosen video itself into `target` different windows — one long good source
// used as several distinct shots (buildTimeline hands each occurrence its own
// motion-picked, non-overlapping in-point). Needs real spare footage, so a short
// source stays a single clip.
export function planSameSourceMontage(
  chosenId: string,
  candidates: readonly MontageCandidate[],
  beatDurationSec: number,
): SegmentPlanItem[] | null {
  const target = montageTarget(beatDurationSec);
  if (target < 2) return null;
  const chosen = candidates.find((c) => c.id === chosenId);
  if (chosen?.kind !== 'video') return null;
  const source = chosen.durationSec ?? 0;
  if (source < beatDurationSec * MONTAGE_SAME_SOURCE_FACTOR) return null;
  return Array.from({ length: target }, () => ({ candidateId: chosenId, weight: 1 }));
}

export interface MomentInput {
  embedding: readonly number[]; // the moment phrase embedding (from the sidecar)
  weight: number; // relative duration (e.g. the phrase's word count)
}

// Semantic montage (doc 23 §7b): assign each ordered visual moment its best-matching,
// visually-distinct candidate, IMAGE-FIRST (documentary bias — pickImageFirst above).
// For each moment in turn, rank the unused, non-duplicate candidates by cosine(moment
// phrase, thumb); a well-ranked image beats a video top. A moment with no distinct
// match is dropped. Returns an ordered plan (≥2 assigned) or null — the caller then
// falls back to planMontage.
export function planSemanticMontage(
  moments: readonly MomentInput[],
  candidates: readonly MontageCandidate[],
  beatDurationSec: number,
): SegmentPlanItem[] | null {
  // The analyzer's shot count IS the cadence here — five named foods are five cuts, and the
  // 2.5 s blind-fill target would show two of them. The only real limit is screen time: trim
  // to what fits at MONTAGE_HARD_MIN_SEG_SEC, below which a shot flickers instead of reading.
  // (This bound belongs here, not in deriveMoments, because only the caller knows the duration.)
  const maxSegments = Math.max(1, Math.floor(beatDurationSec / MONTAGE_HARD_MIN_SEG_SEC));
  const used = new Set<string>();
  const picked: MontageCandidate[] = [];
  const momentIdxs: number[] = [];
  const weights: number[] = [];
  for (let mi = 0; mi < moments.length && picked.length < maxSegments; mi += 1) {
    const m = moments[mi];
    if (!m) continue;
    const eligible = candidates
      .filter(
        (c) =>
          !used.has(c.id) &&
          picked.every(
            (p) => cosine(c.thumbEmbedding, p.thumbEmbedding) <= MONTAGE_DIVERSITY_COSINE,
          ),
      )
      .map((c) => ({ c, sim: cosine(m.embedding, c.thumbEmbedding) }))
      .sort((a, b) => b.sim - a.sim)
      .map((e) => e.c);
    const best = pickImageFirst(eligible);
    if (best) {
      used.add(best.id);
      picked.push(best);
      momentIdxs.push(mi);
      weights.push(m.weight);
    }
  }
  if (picked.length < 2) return null;
  return picked.map((p, i) => ({
    candidateId: p.id,
    weight: weights[i] ?? 1,
    momentIdx: momentIdxs[i] ?? i,
  }));
}
