import { type MotionSample, pickBestWindow } from './clip';
import { FRAME_SEC } from './constants';
import { invariant } from './errors';
import { type Timeline, TimelineSchema } from './timeline';

// Pure timeline builder (doc 12 §Builder). Narration is the clock: measured
// per-beat durations drive every visual duration, quantized to 1/30 s with the
// rounding accumulated into the final beat. No I/O, no data source — the worker
// (Phase 9) feeds it real numbers.

type StillKind = 'image' | 'generated' | 'textcard';

interface Provenance {
  provider?: string;
  providerId?: string;
  author?: string;
  pageUrl?: string;
}

export type BuildBeatMedia =
  | ({
      kind: 'video';
      path: string;
      sourceDurationSec?: number;
      // Per-frame motion sampled by the fetch stage (doc 23 §7). When present, the
      // in-point is the most dynamic window; absent ⇒ the geometric fallback below.
      motionSamples?: readonly MotionSample[];
    } & Provenance)
  | ({ kind: StillKind; path: string } & Provenance);

// In-point for a video beat (doc 23 §7). Prefer the motion-scored best window; fall
// back to the pre-23e heuristic (center the window, skip the first 10% — stock clips
// often start static) when no motion signal is available.
function chooseInPoint(
  source: number | undefined,
  durationSec: number,
  samples: readonly MotionSample[] | undefined,
): number {
  if (source === undefined || source <= durationSec) return 0;
  if (samples && samples.length > 0) return pickBestWindow(samples, source, durationSec);
  const skip = 0.1 * source;
  const centered = Math.max(0, skip + (source - skip - durationSec) / 2);
  return centered + durationSec > source ? Math.max(0, source - durationSec) : centered;
}

export interface BuildBeatInput {
  idx: number;
  text: string;
  narrationDurationSec: number;
  shotType?: string;
  emotion?: string;
  media: BuildBeatMedia;
}

export interface BuildTimelineInput {
  projectId: string;
  createdAt: string; // ISO — passed in (core is pure, no clock)
  render: {
    aspect: '16:9' | '9:16' | '1:1';
    width: number;
    height: number;
    preset: 'draft' | 'final';
  };
  narration: { audioPath: string; durationSec: number };
  beats: BuildBeatInput[];
  pauseSec: number;
  transitions: { style: 'crossfade' | 'cut' | 'smart'; crossfadeSec: number };
  music: Timeline['music'];
  subtitles: Timeline['subtitles'];
  credits: string;
}

// Ken Burns direction cycles across consecutive stills (doc 12 §Builder).
const KENBURNS_CYCLE = [
  { direction: 'in-tl', zoomFrom: 1.0, zoomTo: 1.08 },
  { direction: 'out-tr', zoomFrom: 1.08, zoomTo: 1.0 },
  { direction: 'in-br', zoomFrom: 1.0, zoomTo: 1.08 },
  { direction: 'out-bl', zoomFrom: 1.08, zoomTo: 1.0 },
] as const;

function provenanceOf(media: BuildBeatMedia): Provenance {
  const out: Provenance = {};
  if (media.provider !== undefined) out.provider = media.provider;
  if (media.providerId !== undefined) out.providerId = media.providerId;
  if (media.author !== undefined) out.author = media.author;
  if (media.pageUrl !== undefined) out.pageUrl = media.pageUrl;
  return out;
}

export function buildTimeline(input: BuildTimelineInput): Timeline {
  const { beats, narration, pauseSec, transitions } = input;
  const n = beats.length;
  invariant(n > 0, 'buildTimeline: no beats', 'compose');

  // Frame-quantized durations; last beat absorbs the rounding remainder.
  const totalFrames = Math.round(narration.durationSec / FRAME_SEC);
  const durFrames: number[] = [];
  let usedFrames = 0;
  for (let i = 0; i < n; i += 1) {
    if (i === n - 1) {
      durFrames.push(totalFrames - usedFrames);
    } else {
      const beat = beats[i];
      invariant(beat !== undefined, 'buildTimeline: beat index gap', 'compose');
      const raw = beat.narrationDurationSec + pauseSec; // pause attaches to the preceding beat
      const frames = Math.max(1, Math.round(raw / FRAME_SEC));
      durFrames.push(frames);
      usedFrames += frames;
    }
  }
  invariant(
    (durFrames[n - 1] ?? 0) >= 1,
    'buildTimeline: narration too short for the beat count',
    'compose',
  );

  let stillCount = 0;
  let startFrames = 0;
  const outBeats = beats.map((beat, i) => {
    const frames = durFrames[i] ?? 1;
    const startSec = startFrames * FRAME_SEC;
    const durationSec = frames * FRAME_SEC;
    startFrames += frames;

    const media = beat.media;
    const provenance = provenanceOf(media);

    if (media.kind === 'video') {
      const source = media.sourceDurationSec;
      const inPointSec = chooseInPoint(source, durationSec, media.motionSamples);
      const videoMedia = {
        kind: 'video' as const,
        path: media.path,
        inPointSec,
        ...(source !== undefined ? { sourceDurationSec: source } : {}),
        ...provenance,
      };
      return { idx: beat.idx, text: beat.text, startSec, durationSec, media: videoMedia };
    }

    const kb = KENBURNS_CYCLE[stillCount % KENBURNS_CYCLE.length];
    invariant(kb !== undefined, 'buildTimeline: ken-burns cycle index', 'compose');
    stillCount += 1;
    const stillMedia = {
      kind: media.kind,
      path: media.path,
      kenburns: { direction: kb.direction, zoomFrom: kb.zoomFrom, zoomTo: kb.zoomTo },
      ...provenance,
    };
    return { idx: beat.idx, text: beat.text, startSec, durationSec, media: stillMedia };
  });

  // Smart-mix: cut when shotType AND emotion match across the boundary, else crossfade.
  const defaultTransition = transitions.style === 'cut' ? 'cut' : 'crossfade';
  let perBoundary: ('crossfade' | 'cut')[] | undefined;
  if (transitions.style === 'smart' && n > 1) {
    perBoundary = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = beats[i];
      const b = beats[i + 1];
      const sameShot =
        a !== undefined && b !== undefined && a.shotType === b.shotType && a.emotion === b.emotion;
      perBoundary.push(sameShot ? 'cut' : 'crossfade');
    }
  }

  const raw = {
    version: 1,
    projectId: input.projectId,
    createdAt: input.createdAt,
    render: {
      aspect: input.render.aspect,
      width: input.render.width,
      height: input.render.height,
      fps: 30,
      preset: input.render.preset,
    },
    narration: { audioPath: narration.audioPath, durationSec: totalFrames * FRAME_SEC },
    music: input.music,
    subtitles: input.subtitles,
    beats: outBeats,
    transitions: {
      default: defaultTransition,
      crossfadeSec: transitions.crossfadeSec,
      ...(perBoundary !== undefined ? { perBoundary } : {}),
    },
    credits: { text: input.credits },
  };

  return TimelineSchema.parse(raw);
}
