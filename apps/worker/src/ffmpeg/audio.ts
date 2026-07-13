import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PipelineError } from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';

async function ff(args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await execa(FFMPEG_BIN, ['-v', 'error', '-nostdin', ...args], {
      ...(signal ? { cancelSignal: signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw new PipelineError('E_CANCELLED', 'tts', 'cancelled');
    throw new PipelineError('E_FFMPEG', 'tts', `ffmpeg failed: ${args.join(' ').slice(0, 120)}`, {
      cause,
    });
  }
}

function escapeConcatPath(path: string): string {
  // concat-demuxer `file '...'`: forward slashes work on Windows too and dodge backslash-as-
  // escape (no-op on POSIX); then escape any single quote in the path itself.
  return path.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

export interface NarrationPaths {
  voRawPath: string;
  voPath: string;
}

// Concatenate 24 kHz mono beat WAVs with `pauseSec` silence between them
// (concat demuxer), then loudness-normalize once to −16 LUFS @ 48 kHz (doc 10 §3-4).
export async function buildNarration(
  beatPaths: string[],
  pauseSec: number,
  audioDir: string,
  signal?: AbortSignal,
): Promise<NarrationPaths> {
  const silencePath = join(audioDir, 'silence.wav');
  const listPath = join(audioDir, 'concat.txt');
  const voRawPath = join(audioDir, 'vo_raw.wav');
  const voPath = join(audioDir, 'vo.wav');

  if (pauseSec > 0) {
    await ff(
      [
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=24000:cl=mono',
        '-t',
        pauseSec.toFixed(3),
        '-c:a',
        'pcm_s16le',
        '-y',
        silencePath,
      ],
      signal,
    );
  }

  const lines: string[] = [];
  beatPaths.forEach((path, i) => {
    lines.push(`file '${escapeConcatPath(path)}'`);
    if (pauseSec > 0 && i < beatPaths.length - 1) {
      lines.push(`file '${escapeConcatPath(silencePath)}'`);
    }
  });
  await writeFile(listPath, lines.join('\n'), 'utf8');

  // Re-encode to a uniform PCM stream while concatenating (inputs already match).
  await ff(
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-ac',
      '1',
      '-ar',
      '24000',
      '-c:a',
      'pcm_s16le',
      '-y',
      voRawPath,
    ],
    signal,
  );

  // Single-pass loudnorm preserves duration; 48 kHz for the final mux (doc 10 §4).
  await ff(
    [
      '-i',
      voRawPath,
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-y',
      voPath,
    ],
    signal,
  );

  return { voRawPath, voPath };
}
