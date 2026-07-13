import { env } from '@scriptreel/config';
import { VIDEO_CODEC_HW } from '@scriptreel/core';

// Platform-appropriate H.264 encoder for the normalize (Pass A) and compose (Pass B/C) passes.
// macOS uses the VideoToolbox HW encoder — which needs `-allow_sw 1` so it may fall back to
// software — but that encoder and flag exist ONLY on Apple: on Windows/Linux ffmpeg rejects
// `h264_videotoolbox` / `allow_sw` ("Unrecognized option 'allow_sw'"). So default to the universal
// libx264 software encoder off Apple. Override with VIDEO_ENCODER (e.g. `h264_nvenc` on an NVIDIA
// GPU) and we attach the right preset per known encoder family; an unknown value rides with just
// the bitrate. Chosen once at module load.
const ENCODER = env.VIDEO_ENCODER ?? (process.platform === 'darwin' ? VIDEO_CODEC_HW : 'libx264');

// The `-c:v … -b:v …` (+ encoder-specific) args shared by every normalize/compose ffmpeg call.
export function hwEncodeArgs(bitrate: string): string[] {
  if (ENCODER === 'h264_videotoolbox') {
    return ['-c:v', ENCODER, '-b:v', bitrate, '-allow_sw', '1'];
  }
  if (ENCODER === 'libx264') {
    return ['-c:v', ENCODER, '-preset', 'medium', '-b:v', bitrate];
  }
  if (ENCODER.endsWith('_nvenc')) {
    return ['-c:v', ENCODER, '-preset', 'p5', '-b:v', bitrate];
  }
  return ['-c:v', ENCODER, '-b:v', bitrate];
}
