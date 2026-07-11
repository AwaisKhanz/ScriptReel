import type { MotionSample } from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';

// Per-frame motion sampling for clip intelligence (doc 23 §7). One fast, downscaled
// pass: ffmpeg's `scdet` filter attaches a mean-absolute-frame-difference
// (`lavfi.scd.mafd`) to every frame — our motion signal — which `metadata=print`
// writes to stdout alongside each frame's `pts_time`. No new model; bounded compute.
const ANALYZE_WIDTH = 192; // tiny frames: the diff is cheap and motion is scale-robust
const ANALYZE_TIMEOUT_MS = 20_000;

// metadata=print stdout blocks look like:
//   frame:12  pts:12  pts_time:0.4
//   lavfi.scd.mafd=1.234
//   lavfi.scd.score=0.001
//   lavfi.scd.time=0.4
export function parseMotion(stdout: string): MotionSample[] {
  const out: MotionSample[] = [];
  let t: number | null = null;
  for (const line of stdout.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const mafd = line.match(/lavfi\.scd\.mafd=([\d.]+)/);
    if (mafd && t !== null) {
      out.push({ t, motion: Number(mafd[1]) });
      t = null; // consume this frame's time
    }
  }
  return out;
}

// Sample per-frame motion from a source video. Callers treat any throw as "no signal"
// and fall back to the geometric in-point (degrade, never die — doc 23 §8).
export async function analyzeMotion(src: string, signal?: AbortSignal): Promise<MotionSample[]> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      src,
      '-vf',
      `scale=${ANALYZE_WIDTH}:-2,scdet=s=0:t=0,metadata=print:file=-`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    { ...(signal ? { cancelSignal: signal } : {}), timeout: ANALYZE_TIMEOUT_MS },
  );
  return parseMotion(stdout);
}
