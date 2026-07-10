import {
  type ComposePlan,
  NORMALIZE_BITRATE,
  PipelineError,
  VIDEO_CODEC_HW,
} from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';

// Compose Pass B (visual assembly) + Pass C (subtitles/audio/encode), doc 13.

async function ff(args: string[], stage: string): Promise<void> {
  try {
    await execa(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'warning', ...args]);
  } catch (cause) {
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
): Promise<void> {
  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const f = plan.crossfadeSec.toFixed(3);
  const parts: string[] = [];

  // Each segment → a labeled video stream (concat when it holds >1 clip).
  const segLabels = plan.segments.map((seg, k) => {
    if (seg.clipIndices.length === 1) {
      const label = `s${k}`;
      parts.push(`[${seg.clipIndices[0]}:v]null[${label}]`);
      return label;
    }
    const ins = seg.clipIndices.map((i) => `[${i}:v]`).join('');
    const label = `s${k}`;
    parts.push(`${ins}concat=n=${seg.clipIndices.length}:v=1:a=0[${label}]`);
    return label;
  });

  let vout = segLabels[0] ?? 's0';
  for (let k = 0; k < segLabels.length - 1; k += 1) {
    const next = segLabels[k + 1];
    const label = `x${k}`;
    parts.push(
      `[${vout}][${next}]xfade=transition=fade:duration=${f}:offset=${plan.fadeOffsets[k]?.toFixed(3)}[${label}]`,
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
      '-c:v',
      VIDEO_CODEC_HW,
      '-b:v',
      NORMALIZE_BITRATE,
      '-allow_sw',
      '1',
      outPath,
    ],
    'Pass B (assemble)',
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
  if (p.assPath) vFilters.push(`subtitles=${p.assPath}:fontsdir=${p.fontsDir}`);
  const videoChain = `[0:v]${vFilters.length ? vFilters.join(',') : 'null'}[v]`;

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
      ? [
          '-c:v',
          VIDEO_CODEC_HW,
          '-b:v',
          p.aspect === '9:16' ? '12M' : '10M',
          '-profile:v',
          'high',
          '-allow_sw',
          '1',
        ]
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
  );
}

// Poster frame at 15% of the timeline (doc 13).
export async function makeThumbnail(
  finalPath: string,
  atSec: number,
  outPath: string,
): Promise<void> {
  await ff(
    ['-ss', atSec.toFixed(3), '-i', finalPath, '-frames:v', '1', '-vf', 'scale=640:-2', outPath],
    'thumbnail',
  );
}
