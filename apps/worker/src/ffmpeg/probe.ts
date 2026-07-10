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

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!num) return 0;
  return den ? num / den : num;
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execa(FFPROBE_BIN, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,r_frame_rate,duration:format=duration',
      '-of',
      'json',
      path,
    ]));
  } catch (cause) {
    throw new PipelineError('E_INVARIANT', 'worker', `ffprobe failed on ${path}`, { cause });
  }
  const json = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; r_frame_rate?: string; duration?: string }[];
    format?: { duration?: string };
  };
  const s = json.streams?.[0];
  return {
    width: Number(s?.width ?? 0),
    height: Number(s?.height ?? 0),
    fps: parseFps(s?.r_frame_rate),
    durationSec: Number(s?.duration ?? json.format?.duration ?? 0),
  };
}
