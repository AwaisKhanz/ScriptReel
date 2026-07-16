import {
  FRAME_SEC,
  KENBURNS_PRESCALE,
  LOOP_MAX,
  NORMALIZE_BITRATE,
  NORMALIZE_FILTER_TAIL,
  PipelineError,
} from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';
import { getEncodeArgs } from './encoder';

// Pass A per-beat normalization (doc 13): every source becomes a uniform W×H, 30 fps,
// yuv420p, SAR 1, silent clip of length L_i. Video is scaled/cropped/looped/held;
// stills get a Ken Burns move (pre-scaled 2× to kill zoompan jitter).

// Encoder args (`-c:v …`) shared by every normalize call: the configured HW encoder, probed once
// and demoted to libx264 if it can't open (see ffmpeg/encoder.ts). Resolved at each function's
// start; the probe runs at most once (cached), so repeat calls are effectively free.
const encodeArgs = (): Promise<string[]> => getEncodeArgs(NORMALIZE_BITRATE);

async function ff(args: string[], outPath: string, signal?: AbortSignal): Promise<void> {
  try {
    await execa(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'warning', ...args], {
      ...(signal ? { cancelSignal: signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw new PipelineError('E_CANCELLED', 'fetch', 'cancelled');
    const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr) : '';
    const tail = stderr.split('\n').slice(-40).join('\n');
    throw new PipelineError('E_NORMALIZE', 'fetch', `normalize failed → ${outPath}\n${tail}`, {
      cause,
    });
  }
}

function coverVf(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${NORMALIZE_FILTER_TAIL}`;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface NormalizeVideoParams {
  src: string;
  inPointSec: number;
  headPadSec: number;
  lengthSec: number;
  sourceDurationSec: number;
  width: number;
  height: number;
  outPath: string;
  signal?: AbortSignal;
}

export async function normalizeVideo(p: NormalizeVideoParams): Promise<void> {
  const ENCODE = await encodeArgs();
  const L = p.lengthSec;
  // Ask for an exact FRAME COUNT, and clone the last frame if the source runs dry.
  //
  // `-t <seconds>` is not a length guarantee, and neither is `-frames:v` alone. A container's
  // reported duration rarely lands on the 30 fps grid (a real Pexels file probes at 14.639625 s),
  // so `sourceDurationSec - L` can place the window a hair past the last decodable frame and the
  // output lands one frame short. Measured on the real cache: 2 of 3 assets lost a frame when the
  // in-point clamped to the end; the one that survived had a frame-aligned duration (25.240). One
  // frame is inside the caller's tolerance, but a montage normalises each segment separately, so a
  // 2-segment beat loses 2 frames — 0.066 s — and fetch's `clip N duration < required` invariant
  // (rightly) rejects it. Narration is the clock: the clip must cover it exactly, not nearly.
  //
  // -frames:v pins the count; tpad supplies material if the stream ends early (it costs nothing
  // when it doesn't — tpad only emits after EOF). Both are required: -frames:v alone still yields
  // 120/121 because the frames genuinely are not there. Verified on the real cache, all branches.
  const frames = Math.max(1, Math.round(L / FRAME_SEC));
  // Cloned tail allowance. Generous on purpose — -frames:v is what actually bounds the output, so
  // this only has to be "enough", and L always is.
  const guard = `tpad=stop_mode=clone:stop_duration=${Math.max(1, L).toFixed(3)}`;
  const vf = `${coverVf(p.width, p.height)},${guard}`;
  const count = ['-frames:v', String(frames)];

  if (p.sourceDurationSec >= L + 1e-3) {
    // Enough footage: seek so the beat's content is centered, backed up by the head pad.
    const startAt = clamp(p.inPointSec - p.headPadSec, 0, p.sourceDurationSec - L);
    await ff(
      ['-ss', startAt.toFixed(3), '-i', p.src, ...count, '-vf', vf, '-an', ...ENCODE, p.outPath],
      p.outPath,
      p.signal,
    );
    return;
  }

  const loops = Math.ceil(L / Math.max(0.1, p.sourceDurationSec));
  if (loops <= LOOP_MAX) {
    await ff(
      [
        '-stream_loop',
        String(loops - 1),
        '-i',
        p.src,
        ...count,
        '-vf',
        vf,
        '-an',
        ...ENCODE,
        p.outPath,
      ],
      p.outPath,
      p.signal,
    );
    return;
  }
  // Looping would repeat too often → play once, then hold the last frame (doc 13). The tpad guard
  // above already does the holding; -frames:v decides where it stops.
  await ff(['-i', p.src, ...count, '-vf', vf, '-an', ...ENCODE, p.outPath], p.outPath, p.signal);
}

// Anchor corner (fraction of the pan range) per Ken Burns direction (doc 13).
const KB_ANCHOR: Record<string, [number, number]> = {
  'in-tl': [0.15, 0.15],
  'out-tr': [0.85, 0.15],
  'in-br': [0.85, 0.85],
  'out-bl': [0.15, 0.85],
};

export interface KenBurns {
  direction: string;
  zoomFrom: number;
  zoomTo: number;
}

function kenBurnsVf(kb: KenBurns, width: number, height: number, frames: number): string {
  const [fx, fy] = KB_ANCHOR[kb.direction] ?? [0.5, 0.5];
  const pw = width * KENBURNS_PRESCALE;
  const ph = height * KENBURNS_PRESCALE;
  // Linear zoom (no min()/max() → no commas to escape inside the filter option).
  const z = `${kb.zoomFrom}+(${kb.zoomTo}-${kb.zoomFrom})*on/${frames}`;
  const x = `(iw-iw/zoom)*${fx}`;
  const y = `(ih-ih/zoom)*${fy}`;
  // setsar=1 to match the video path's square pixels — zoompan can emit a hair-off SAR
  // (e.g. 5746:5745), and concat rejects any SAR mismatch between montage sub-clips.
  return (
    `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=30,setsar=1,format=yuv420p`
  );
}

export interface NormalizeStillParams {
  src: string;
  kenburns: KenBurns;
  lengthSec: number;
  width: number;
  height: number;
  outPath: string;
  signal?: AbortSignal;
}

export async function normalizeStill(p: NormalizeStillParams): Promise<void> {
  const ENCODE = await encodeArgs();
  const frames = Math.round(p.lengthSec * 30);
  const vf = kenBurnsVf(p.kenburns, p.width, p.height, frames);
  await ff(
    [
      '-loop',
      '1',
      '-framerate',
      '30',
      '-i',
      p.src,
      '-t',
      p.lengthSec.toFixed(3),
      '-vf',
      vf,
      '-an',
      ...ENCODE,
      p.outPath,
    ],
    p.outPath,
    p.signal,
  );
}

// Concatenate already-normalized, uniform sub-clips into one beat clip (doc 23 §7
// montage). Internal boundaries are hard cuts (the crossfade pads live only at the
// beat's outer edges, baked into the first/last sub-clip), so a plain concat filter —
// the same approach the assemble stage uses for cut-runs — is exact. Re-encoded so the
// output is a single uniform stream the composer treats like any other beat clip.
export async function concatClips(
  inputs: readonly string[],
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (inputs.length === 1 && inputs[0]) {
    // Nothing to join — a degenerate single-segment beat; the caller normalized directly.
    return;
  }
  const ENCODE = await encodeArgs();
  const args: string[] = [];
  for (const inp of inputs) args.push('-i', inp);
  const chain = inputs.map((_, i) => `[${i}:v]`).join('');
  const filter = `${chain}concat=n=${inputs.length}:v=1:a=0,${NORMALIZE_FILTER_TAIL}[v]`;
  await ff(
    [...args, '-filter_complex', filter, '-map', '[v]', '-an', ...ENCODE, outPath],
    outPath,
    signal,
  );
}
