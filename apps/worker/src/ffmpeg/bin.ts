import { env } from '@scriptreel/config';

// ffmpeg-full is keg-only; FFMPEG_PATH points at it. ffprobe lives beside it.
export const FFMPEG_BIN = env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE_BIN = env.FFMPEG_PATH
  ? env.FFMPEG_PATH.replace(/ffmpeg$/, 'ffprobe')
  : 'ffprobe';
