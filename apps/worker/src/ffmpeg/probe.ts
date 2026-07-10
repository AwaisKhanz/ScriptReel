import { PipelineError } from '@scriptreel/core';
import { execa } from 'execa';
import { FFPROBE_BIN } from './bin';

export interface AudioProbe {
  durationSec: number;
  sampleRate: number;
}

export async function probeAudio(path: string): Promise<AudioProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execa(FFPROBE_BIN, [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate:format=duration',
      '-of',
      'json',
      path,
    ]));
  } catch (cause) {
    throw new PipelineError('E_INVARIANT', 'worker', `ffprobe failed on ${path}`, { cause });
  }
  const json = JSON.parse(stdout) as {
    streams?: { sample_rate?: string }[];
    format?: { duration?: string };
  };
  return {
    durationSec: Number(json.format?.duration ?? 0),
    sampleRate: Number(json.streams?.[0]?.sample_rate ?? 0),
  };
}
