import { type ComposePlan, NORMALIZE_BITRATE, PipelineError } from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';
import { getEncodeArgs } from './encoder';

// Compose Pass B (visual assembly) + Pass C (subtitles/audio/encode), doc 13.

// Escape a filesystem path for use INSIDE an ffmpeg filter argument (e.g. `subtitles=`).
// On Windows a raw `C:\dir\subs.ass` breaks the filter parser — the drive `:` reads as the
// option separator and `\` as an escape. Forward slashes work on Windows too. The drive `:` must
// stay a literal, but ffmpeg unescapes `-filter_complex` in TWO passes (filtergraph split, then
// per-filter option split): a single `\:` is consumed by the first pass, so the second pass splits
// on the now-bare `:` ("No option name near …"). Doubling the backslash (`\\:`) leaves one escape
// standing for each pass. On POSIX paths (no `\`, no `:`) both replaces are a no-op.
function ffFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

async function ff(args: string[], stage: string, signal?: AbortSignal): Promise<void> {
  try {
    await execa(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'warning', ...args], {
      ...(signal ? { cancelSignal: signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw new PipelineError('E_CANCELLED', 'compose', 'cancelled');
    const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr) : '';
    throw new PipelineError(
      'E_FFMPEG',
      'compose',
      `${stage} failed:\n${stderr.split('\n').slice(-40).join('\n')}`,
      {
        cause,
      },
    );
  }
}

// Pass B — concat cut-runs into segments, xfade between segments (doc 13 §Pass B).
export async function assembleVisual(
  clipPaths: string[],
  plan: ComposePlan,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const f = plan.crossfadeSec.toFixed(3);
  const parts: string[] = [];

  // Each segment → a labeled video stream (concat when it holds >1 clip). settb=AVTB
  // pins every segment to a common timebase (1/1000000): xfade rejects inputs whose
  // timebases differ, and a chained xfade's output otherwise picks up a different tb
  // than the raw segment it's crossfaded with (the 3rd+ transition fails without this).
  const segLabels = plan.segments.map((seg, k) => {
    if (seg.clipIndices.length === 1) {
      const label = `s${k}`;
      parts.push(`[${seg.clipIndices[0]}:v]settb=AVTB[${label}]`);
      return label;
    }
    const ins = seg.clipIndices.map((i) => `[${i}:v]`).join('');
    const label = `s${k}`;
    parts.push(`${ins}concat=n=${seg.clipIndices.length}:v=1:a=0,settb=AVTB[${label}]`);
    return label;
  });

  let vout = segLabels[0] ?? 's0';
  for (let k = 0; k < segLabels.length - 1; k += 1) {
    const next = segLabels[k + 1];
    const label = `x${k}`;
    // settb=AVTB after each xfade so the next xfade sees a matching timebase.
    parts.push(
      `[${vout}][${next}]xfade=transition=fade:duration=${f}:offset=${plan.fadeOffsets[k]?.toFixed(3)},settb=AVTB[${label}]`,
    );
    vout = label;
  }

  await ff(
    [
      ...inputs,
      '-filter_complex',
      parts.join(';'),
      '-map',
      `[${vout}]`,
      ...(await getEncodeArgs(NORMALIZE_BITRATE)),
      outPath,
    ],
    'Pass B (assemble)',
    signal,
  );
}

const DUCK = 'sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350:makeup=1';

export interface PassCParams {
  videoNoSub: string;
  voPath: string;
  music: { path: string; gainDb: number; fadeOutSec: number } | null;
  assPath: string | null;
  fontsDir: string;
  durationSec: number;
  width: number;
  height: number;
  aspect: string;
  preset: 'draft' | 'final';
  outPath: string;
  signal?: AbortSignal;
}

function draftDims(width: number, height: number): [number, number] {
  const round2 = (x: number): number => Math.round(x / 2) * 2;
  return [round2((width * 2) / 3), round2((height * 2) / 3)];
}

// Pass C — burn subtitles, mix VO + sidechain-ducked music, encode (doc 13 §Pass C).
export async function encodeFinal(p: PassCParams): Promise<void> {
  const T = p.durationSec.toFixed(3);
  const inputs = ['-i', p.videoNoSub, '-i', p.voPath];
  if (p.music) inputs.push('-stream_loop', '-1', '-i', p.music.path);

  const vFilters: string[] = [];
  if (p.preset === 'draft') {
    const [dw, dh] = draftDims(p.width, p.height);
    vFilters.push(`scale=${dw}:${dh}`);
  }
  if (p.assPath)
    vFilters.push(`subtitles=${ffFilterPath(p.assPath)}:fontsdir=${ffFilterPath(p.fontsDir)}`);
  // Pin 8-bit 4:2:0 before H.264. With libx264 (which advertises 4:2:2/4:4:4 support) the subtitles
  // filter otherwise negotiates up to 4:4:4, which `-profile:v high` rejects ("high profile doesn't
  // support 4:4:4"); it also keeps output broadly playable. VideoToolbox on macOS only advertises
  // 4:2:0 so this never surfaced there — make it explicit for every encoder. Always last.
  vFilters.push('format=yuv420p');
  const videoChain = `[0:v]${vFilters.join(',')}[v]`;

  let audioChain: string;
  if (p.music) {
    const fadeStart = Math.max(0, p.durationSec - p.music.fadeOutSec).toFixed(3);
    audioChain =
      `[2:a]atrim=0:${T},volume=${p.music.gainDb}dB,afade=t=out:st=${fadeStart}:d=${p.music.fadeOutSec.toFixed(3)}[m];` +
      `[m][1:a]${DUCK}[md];` +
      `[md][1:a]amix=inputs=2:duration=first:normalize=0[a]`;
  } else {
    audioChain = '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]';
  }

  const encode =
    p.preset === 'final'
      ? [...(await getEncodeArgs(p.aspect === '9:16' ? '12M' : '10M')), '-profile:v', 'high']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26'];

  await ff(
    [
      ...inputs,
      '-filter_complex',
      `${videoChain};${audioChain}`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      ...encode,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      p.outPath,
    ],
    'Pass C (encode)',
    p.signal,
  );
}

// Poster frame at 15% of the timeline (doc 13).
export async function makeThumbnail(
  finalPath: string,
  atSec: number,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await ff(
    ['-ss', atSec.toFixed(3), '-i', finalPath, '-frames:v', '1', '-vf', 'scale=640:-2', outPath],
    'thumbnail',
    signal,
  );
}
