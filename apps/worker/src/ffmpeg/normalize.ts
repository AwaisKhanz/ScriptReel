import {
  KENBURNS_PRESCALE,
  LOOP_MAX,
  NORMALIZE_BITRATE,
  NORMALIZE_FILTER_TAIL,
  PipelineError,
  VIDEO_CODEC_HW,
} from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';

// Pass A per-beat normalization (doc 13): every source becomes a uniform W×H, 30 fps,
// yuv420p, SAR 1, silent clip of length L_i. Video is scaled/cropped/looped/held;
// stills get a Ken Burns move (pre-scaled 2× to kill zoompan jitter).

const ENCODE = ['-c:v', VIDEO_CODEC_HW, '-b:v', NORMALIZE_BITRATE, '-allow_sw', '1'] as const;

async function ff(args: string[], outPath: string): Promise<void> {
  try {
    await execa(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'warning', ...args]);
  } catch (cause) {
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
}

export async function normalizeVideo(p: NormalizeVideoParams): Promise<void> {
  const L = p.lengthSec;
  const vf = coverVf(p.width, p.height);
  const t = L.toFixed(3);

  if (p.sourceDurationSec >= L + 1e-3) {
    // Enough footage: seek so the beat's content is centered, backed up by the head pad.
    const startAt = clamp(p.inPointSec - p.headPadSec, 0, p.sourceDurationSec - L);
    await ff(
      ['-ss', startAt.toFixed(3), '-i', p.src, '-t', t, '-vf', vf, '-an', ...ENCODE, p.outPath],
      p.outPath,
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
        '-t',
        t,
        '-vf',
        vf,
        '-an',
        ...ENCODE,
        p.outPath,
      ],
      p.outPath,
    );
    return;
  }
  // Looping would repeat too often → play once, then hold the last frame (doc 13).
  const pad = Math.max(0, L - p.sourceDurationSec).toFixed(3);
  const heldVf = `${coverVf(p.width, p.height)},tpad=stop_mode=clone:stop_duration=${pad}`;
  await ff(['-i', p.src, '-t', t, '-vf', heldVf, '-an', ...ENCODE, p.outPath], p.outPath);
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
  return (
    `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=30,format=yuv420p`
  );
}

export interface NormalizeStillParams {
  src: string;
  kenburns: KenBurns;
  lengthSec: number;
  width: number;
  height: number;
  outPath: string;
}

export async function normalizeStill(p: NormalizeStillParams): Promise<void> {
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
  );
}
