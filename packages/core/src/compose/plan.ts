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
