import {
  DUP_COSINE,
  DUP_PENALTY,
  MONOTONY_PENALTY,
  QUALITY_WEIGHTS,
  REUSE_PENALTY,
  SCORE_WEIGHTS,
  TAU_HI,
  TAU_LO,
} from './constants';
import type { MediaKind } from './providers';

// The matching algorithm (doc 09) — pure math only; the sidecar produces embeddings,
// the worker does I/O, this module scores and selects. Zero I/O (invariant 8).

// Cosine similarity. Vectors from the sidecar are L2-normalized, so this is a dot
// product, but we divide by norms anyway to stay correct for any input.
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CandidateFeatures {
  kind: MediaKind;
  isIllustration: boolean;
  width: number;
  height: number;
  durationSec: number | null; // videos only
  fps: number | null; // videos only
}

// Project-global scoring context. Per-beat duration is passed separately (it
// varies beat to beat, while these hold for the whole project).
export interface ScoreContext {
  targetHeight: number;
  targetAspect: number; // frame width / height
  mixedMode: boolean; // mediaPreference === 'mixed' → isVideo bonus applies
}

// resFit: 1 if candidate height ≥ target, else height/target (doc 09).
export function resFit(height: number, targetHeight: number): number {
  if (targetHeight <= 0) return 1;
  if (height >= targetHeight) return 1;
  return Math.max(0, height / targetHeight);
}

// durFit: videos 1 inside [beatDur, 4·beatDur], linear falloff to 0.3 outside;
// images fixed 0.8 (doc 09).
export function durFit(
  kind: MediaKind,
  candDurationSec: number | null,
  beatDurationSec: number,
): number {
  if (kind === 'image') return 0.8;
  const dur = candDurationSec ?? 0;
  if (beatDurationSec <= 0) return 0.3;
  const lo = beatDurationSec;
  const hi = 4 * beatDurationSec;
  if (dur >= lo && dur <= hi) return 1;
  if (dur < lo) return clamp(0.3 + (0.7 * dur) / lo, 0.3, 1); // ramps 0.3→1 as dur→lo
  // dur > hi: falls 1→0.3 over the next 4·beatDur, floored at 0.3
  return clamp(1 - (0.7 * (dur - hi)) / hi, 0.3, 1);
}

// fpsFit: 1 if ≥24 fps or image, else 0.5 (doc 09).
export function fpsFit(kind: MediaKind, fps: number | null): number {
  if (kind === 'image') return 1;
  return (fps ?? 0) >= 24 ? 1 : 0.5;
}

// orientFit: 1 − min(1, |candAR − targetAR| / targetAR) (doc 09).
export function orientFit(candAspect: number, targetAspect: number): number {
  if (targetAspect <= 0) return 1;
  return 1 - Math.min(1, Math.abs(candAspect - targetAspect) / targetAspect);
}

export function qualityScore(
  features: CandidateFeatures,
  ctx: ScoreContext,
  beatDurationSec: number,
): number {
  const res = resFit(features.height, ctx.targetHeight);
  const dur = durFit(features.kind, features.durationSec, beatDurationSec);
  const fps = fpsFit(features.kind, features.fps);
  return QUALITY_WEIGHTS.res * res + QUALITY_WEIGHTS.dur * dur + QUALITY_WEIGHTS.fps * fps;
}

export interface ScoreBreakdown {
  sim: number;
  quality: number;
  orientFit: number;
  videoBonus: number;
  illustrationPenalty: number;
  base: number; // weighted sum, before sequential (selection-time) penalties
}

// Score before the sequential penalties, which depend on selection order (doc 09).
export function baseScore(
  sim: number,
  features: CandidateFeatures,
  ctx: ScoreContext,
  beatDurationSec: number,
): ScoreBreakdown {
  const quality = qualityScore(features, ctx, beatDurationSec);
  const candAspect = features.height > 0 ? features.width / features.height : ctx.targetAspect;
  const orient = orientFit(candAspect, ctx.targetAspect);
  const videoBonus = features.kind === 'video' && ctx.mixedMode ? SCORE_WEIGHTS.video : 0;
  const illustrationPenalty = features.isIllustration ? SCORE_WEIGHTS.illustration : 0;
  const base =
    SCORE_WEIGHTS.sim * sim +
    SCORE_WEIGHTS.quality * quality +
    SCORE_WEIGHTS.orient * orient +
    videoBonus -
    illustrationPenalty;
  return { sim, quality, orientFit: orient, videoBonus, illustrationPenalty, base };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ---- Greedy selection with thresholds (doc 09 §step 3) ----------------------

export interface SelectionCandidate {
  id: string;
  assetKey: string; // provider:providerId — reuse penalty keys on this
  author: string | null;
  features: CandidateFeatures;
  sim: number; // cosine(beat description, thumb)
  thumbEmbedding: readonly number[];
  // From a variable-quality archive/aggregator source (doc 23 §6). On a named-subject
  // beat these are cross-checked stricter — see acceptTop. Absent ⇒ trusted stock.
  isArchive?: boolean;
}

export interface SelectionBeat {
  beatIdx: number;
  beatDurationSec: number; // narration estimate (est_seconds); drives durFit
  candidates: readonly SelectionCandidate[];
  // The beat names a specific person/place (doc 23 §6.3). A weak archive match must
  // not stand in as the named subject; a confident one is preferred over generic stock.
  namedSubject?: boolean;
}

export interface RankedCandidate {
  id: string;
  score: number;
  rank: number;
}

// Which selection path resolved a beat (doc 09). 'primary' = tier-1 candidates cleared
// τ; the ladder rungs (Phase 7) escalate; 'none' = still unresolved (pre-ladder).
export type Rung =
  | 'primary'
  | 'broaden'
  | 'conceptual'
  | 'mood'
  | 'textcard'
  | 'forced_textcard'
  | 'none';

export interface BeatSelection {
  beatIdx: number;
  chosenId: string | null;
  rungUsed: Rung;
  weak: boolean;
  ranked: RankedCandidate[];
}

export interface SelectionThresholds {
  tauHi: number;
  tauLo: number;
}

interface SelectionState {
  chosenAssets: Set<string>;
  prevAuthor: string | null;
  prevThumb: readonly number[] | null;
}

// Score one beat's candidates against the running selection state, applying the
// order-dependent penalties (reuse, near-dup of the adjacent beat, author monotony).
function rankBeat(
  beat: SelectionBeat,
  ctx: ScoreContext,
  state: SelectionState,
  penaltyMult: number,
): RankedCandidate[] {
  const scored = beat.candidates.map((c) => {
    let score = baseScore(c.sim, c.features, ctx, beat.beatDurationSec).base;
    if (state.chosenAssets.has(c.assetKey)) score -= REUSE_PENALTY * penaltyMult;
    if (state.prevThumb && cosine(c.thumbEmbedding, state.prevThumb) > DUP_COSINE) {
      score -= DUP_PENALTY * penaltyMult;
    }
    if (c.author && state.prevAuthor && c.author === state.prevAuthor) {
      score -= MONOTONY_PENALTY * penaltyMult;
    }
    return { id: c.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i) => ({ id: s.id, score: s.score, rank: i }));
}

// Apply τ to a beat's ranked candidates with the named-subject cross-check (doc 23 §6).
// On a beat that names a specific person/place: (a) a confident archive match — the
// actual subject — is preferred over a generic stock stand-in, and (b) an archive
// asset is never accepted on the weak (τ_lo) tier, so a low-confidence stand-in can't
// pass as the named subject (the beat falls to the ladder instead). Generic beats and
// trusted stock keep the plain two-tier behaviour.
function acceptTop(
  ranked: readonly RankedCandidate[],
  beat: SelectionBeat,
  byId: Map<string, SelectionCandidate>,
  thresholds: SelectionThresholds,
): { chosenId: string | null; weak: boolean } {
  const top = ranked[0];
  if (!top) return { chosenId: null, weak: false };

  if (beat.namedSubject) {
    const archiveHit = ranked.find((r) => {
      const c = byId.get(r.id);
      return c?.isArchive && r.score >= thresholds.tauHi;
    });
    if (archiveHit) return { chosenId: archiveHit.id, weak: false };
  }

  if (top.score >= thresholds.tauHi) return { chosenId: top.id, weak: false };
  if (top.score >= thresholds.tauLo) {
    if (beat.namedSubject && byId.get(top.id)?.isArchive) {
      return { chosenId: null, weak: false }; // no weak archive stand-in for a named subject
    }
    return { chosenId: top.id, weak: true };
  }
  return { chosenId: null, weak: false };
}

// Greedy pass over beats in order (doc 09 §step 3). Below τ_lo → no choice here;
// the fallback ladder (Phase 7) takes over. Returns per-beat selections.
export function selectBeats(
  beats: readonly SelectionBeat[],
  ctx: ScoreContext,
  thresholds: SelectionThresholds = { tauHi: TAU_HI, tauLo: TAU_LO },
): BeatSelection[] {
  const state: SelectionState = { chosenAssets: new Set(), prevAuthor: null, prevThumb: null };
  const byId = new Map<string, SelectionCandidate>();
  for (const beat of beats) for (const c of beat.candidates) byId.set(c.id, c);

  const selections: BeatSelection[] = [];
  for (const beat of beats) {
    const ranked = rankBeat(beat, ctx, state, 1);
    const { chosenId, weak } = acceptTop(ranked, beat, byId, thresholds);
    if (chosenId) {
      const chosen = byId.get(chosenId);
      if (chosen) {
        state.chosenAssets.add(chosen.assetKey);
        state.prevAuthor = chosen.author;
        state.prevThumb = chosen.thumbEmbedding;
      }
    }
    selections.push({
      beatIdx: beat.beatIdx,
      chosenId,
      rungUsed: chosenId ? 'primary' : 'none',
      weak,
      ranked,
    });
  }
  return selections;
}

// Global variety pass (doc 09 §step 5). If one provider+author dominates > 60% of
// chosen beats, re-select those beats once with penalties doubled to spread variety.
// Single pass, no loop. Beats without a chosen asset are untouched.
export function varietyPass(
  beats: readonly SelectionBeat[],
  selections: readonly BeatSelection[],
  ctx: ScoreContext,
  thresholds: SelectionThresholds = { tauHi: TAU_HI, tauLo: TAU_LO },
): BeatSelection[] {
  const byId = new Map<string, SelectionCandidate>();
  const beatByIdx = new Map<number, SelectionBeat>();
  for (const beat of beats) {
    beatByIdx.set(beat.beatIdx, beat);
    for (const c of beat.candidates) byId.set(c.id, c);
  }
  const chosen = selections.filter((s) => s.chosenId);
  if (chosen.length === 0) return [...selections];

  const authorOf = (id: string | null): string | null =>
    id ? (byId.get(id)?.author ?? null) : null;
  const counts = new Map<string, number>();
  for (const s of chosen) {
    const a = authorOf(s.chosenId);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let dominantAuthor: string | null = null;
  let dominantCount = 0;
  for (const [author, count] of counts) {
    if (count > dominantCount) {
      dominantAuthor = author;
      dominantCount = count;
    }
  }
  if (!dominantAuthor || dominantCount / chosen.length <= 0.6) return [...selections];

  // Re-run selection with doubled penalties, keeping non-offending beats fixed so the
  // running state (reuse/monotony/dup) reflects what actually stays chosen.
  const state: SelectionState = { chosenAssets: new Set(), prevAuthor: null, prevThumb: null };
  const out: BeatSelection[] = [];
  for (const prev of selections) {
    const beat = beatByIdx.get(prev.beatIdx);
    const offending = prev.chosenId != null && authorOf(prev.chosenId) === dominantAuthor;
    let next = prev;
    if (beat && offending) {
      const ranked = rankBeat(beat, ctx, state, 2);
      const { chosenId, weak } = acceptTop(ranked, beat, byId, thresholds);
      next = {
        beatIdx: prev.beatIdx,
        chosenId,
        rungUsed: chosenId ? 'primary' : 'none',
        weak,
        ranked,
      };
    }
    if (next.chosenId) {
      const c = byId.get(next.chosenId);
      if (c) {
        state.chosenAssets.add(c.assetKey);
        state.prevAuthor = c.author;
        state.prevThumb = c.thumbEmbedding;
      }
    }
    out.push(next);
  }
  return out;
}
