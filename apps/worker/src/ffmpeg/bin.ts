import { env } from '@scriptreel/config';

// ffmpeg-full is keg-only; FFMPEG_PATH points at it. ffprobe lives beside it. Match an
// optional `.exe` so `…\ffmpeg.exe` → `…\ffprobe.exe` on Windows (a bare `ffmpeg$` would miss
// the extension and leave FFPROBE pointing at ffmpeg). No FFMPEG_PATH ⇒ resolve both on PATH.
export const FFMPEG_BIN = env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE_BIN = env.FFMPEG_PATH
  ? env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  : 'ffprobe';
