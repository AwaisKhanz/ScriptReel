import { FRAME_SEC } from '../constants';
import type { Timeline } from '../timeline';

// Per-clip length plan (doc 13 §xfade timing). Each normalized clip is padded so a
// crossfade at a boundary straddles it symmetrically: L_i = d_i + f_left/2 + f_right/2,
// where a side gets f/2 only when the adjacent boundary crossfades (cut → 0). Pure and
// frame-aligned; the half-fade is rounded to whole frames so clip lengths stay exact.

export interface ClipPlanEntry {
  idx: number;
  durationSec: number; // d_i — the beat's on-screen time (frame-quantized)
  headPadSec: number; // f_left/2
  tailPadSec: number; // f_right/2
  lengthSec: number; // L_i = d_i + headPad + tailPad
}

function boundaryIsCrossfade(timeline: Timeline, boundary: number): boolean {
  const { transitions } = timeline;
  const kind = transitions.perBoundary?.[boundary] ?? transitions.default;
  return kind === 'crossfade';
}

export function halfFadeSec(crossfadeSec: number): number {
  return Math.round(crossfadeSec / 2 / FRAME_SEC) * FRAME_SEC;
}

export function clipPlan(timeline: Timeline): ClipPlanEntry[] {
  const n = timeline.beats.length;
  const halfPad = halfFadeSec(timeline.transitions.crossfadeSec);
  return timeline.beats.map((beat, i) => {
    const headPadSec = i > 0 && boundaryIsCrossfade(timeline, i - 1) ? halfPad : 0;
    const tailPadSec = i < n - 1 && boundaryIsCrossfade(timeline, i) ? halfPad : 0;
    return {
      idx: beat.idx,
      durationSec: beat.durationSec,
      headPadSec,
      tailPadSec,
      lengthSec: beat.durationSec + headPadSec + tailPadSec,
    };
  });
}

// Assembly plan (doc 13 §xfade + §Pass B). Cut-joined runs of clips become
// concatenated segments; crossfade boundaries split segments and get an xfade
// between them. Because each padded clip already carries f/2 on its crossfaded
// sides, the total after all xfades equals Σ d_i exactly.
export interface ComposeSegment {
  clipIndices: number[]; // positions into timeline.beats (== ffmpeg input order)
  paddedLengthSec: number; // Σ L_i over the segment's clips
}

export interface ComposePlan {
  segments: ComposeSegment[];
  crossfadeSec: number;
  fadeOffsets: number[]; // xfade offset before segment k+1: Σ_{i≤k} P_i − (k+1)·f
}

export function composePlan(timeline: Timeline): ComposePlan {
  const lengths = clipPlan(timeline).map((e) => e.lengthSec);
  const f = timeline.transitions.crossfadeSec;
  const n = timeline.beats.length;

  const segments: ComposeSegment[] = [];
  let current: number[] = [0];
  for (let b = 0; b < n - 1; b += 1) {
    if (boundaryIsCrossfade(timeline, b)) {
      segments.push(makeSegment(current, lengths));
      current = [b + 1];
    } else {
      current.push(b + 1);
    }
  }
  segments.push(makeSegment(current, lengths));

  const fadeOffsets: number[] = [];
  let cumulative = 0;
  for (let k = 0; k < segments.length - 1; k += 1) {
    const seg = segments[k];
    cumulative += seg ? seg.paddedLengthSec : 0;
    fadeOffsets.push(cumulative - (k + 1) * f);
  }
  return { segments, crossfadeSec: f, fadeOffsets };
}

function makeSegment(clipIndices: number[], lengths: number[]): ComposeSegment {
  return {
    clipIndices,
    paddedLengthSec: clipIndices.reduce((sum, i) => sum + (lengths[i] ?? 0), 0),
  };
}
