import { env } from '@scriptreel/config';
import { VIDEO_CODEC_HW } from '@scriptreel/core';
import { execa } from 'execa';
import { FFMPEG_BIN } from './bin';

// Platform-appropriate H.264 encoder for the normalize (Pass A) and compose (Pass B/C) passes.
// macOS uses the VideoToolbox HW encoder — which needs `-allow_sw 1` so it may fall back to
// software — but that encoder and flag exist ONLY on Apple: on Windows/Linux ffmpeg rejects
// `h264_videotoolbox` / `allow_sw` ("Unrecognized option 'allow_sw'"). So default to the universal
// libx264 software encoder off Apple. Override with VIDEO_ENCODER (e.g. `h264_nvenc` on an NVIDIA
// GPU) and we attach the right preset per known encoder family; an unknown value rides with just
// the bitrate.
const CONFIGURED =
  env.VIDEO_ENCODER ?? (process.platform === 'darwin' ? VIDEO_CODEC_HW : 'libx264');

// The `-c:v … -b:v …` (+ encoder-specific) args for one encoder at a target bitrate.
function argsFor(encoder: string, bitrate: string): string[] {
  if (encoder === 'h264_videotoolbox') {
    return ['-c:v', encoder, '-b:v', bitrate, '-allow_sw', '1'];
  }
  if (encoder === 'libx264') {
    return ['-c:v', encoder, '-preset', 'medium', '-b:v', bitrate];
  }
  if (encoder.endsWith('_nvenc')) {
    return ['-c:v', encoder, '-preset', 'p5', '-b:v', bitrate];
  }
  return ['-c:v', encoder, '-b:v', bitrate];
}

// A hardware encoder can be *named* by ffmpeg yet fail to open at runtime — e.g. `h264_nvenc` on a
// too-old NVIDIA driver ("Driver does not support the required nvenc API version"), or a GPU that
// isn't present/usable. libx264 (software) always works. So before the first real encode we probe
// the configured encoder with a 1-frame throwaway job; if it can't open we demote to libx264 for
// the rest of the process (invariant 7 — degrade, never die: a driver mismatch must not fail the
// whole render). Cached so we probe at most once; a dev restart re-probes and picks up a driver
// update. macOS VideoToolbox passes the probe via `-allow_sw 1`, so Apple behaviour is unchanged.
let resolved: string | null = null;
let probe: Promise<string> | null = null;

async function encoderOpens(encoder: string): Promise<boolean> {
  try {
    await execa(
      FFMPEG_BIN,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:r=30',
        '-frames:v',
        '1',
        '-an',
        ...argsFor(encoder, '8M'),
        '-f',
        'null',
        '-',
      ],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveEncoder(): Promise<string> {
  if (resolved) return resolved;
  if (!probe) {
    probe = (async (): Promise<string> => {
      // libx264 is the universal software encoder — never needs probing.
      if (CONFIGURED === 'libx264') return 'libx264';
      if (await encoderOpens(CONFIGURED)) return CONFIGURED;
      console.warn(
        `[encoder] "${CONFIGURED}" could not open (GPU/driver unavailable) — falling back to ` +
          'libx264 (CPU). Update your GPU driver or set VIDEO_ENCODER=libx264 to silence this.',
      );
      return 'libx264';
    })();
  }
  resolved = await probe;
  return resolved;
}

// Encoder args for the normalize/compose ffmpeg passes, with the configured hardware encoder
// verified once and demoted to libx264 if it can't actually open. Async because the one-time probe
// shells out to ffmpeg; the result is cached, so repeat calls just format the args (effectively
// free). Every call site awaits this instead of hardcoding the encoder.
export async function getEncodeArgs(bitrate: string): Promise<string[]> {
  return argsFor(await resolveEncoder(), bitrate);
}

// Does this ffmpeg stderr say the encoder could not OPEN (as opposed to a bad file, bad args, …)?
// A hardware encoder can pass the startup probe and still fail later: NVENC needs VRAM to create a
// CUDA context, and on a 16 GB card the sidecar (SigLIP + DINOv2 + InsightFace) plus Ollama's
// vision model for the media-fit gate can leave nothing free — measured mid-run at 15174/16311 MiB.
// Ollama keeps a model resident for ~5 min after use, so fetch starts encoding while score's VRAM
// is still held and NVENC reports "No capable devices found" / CUDA_ERROR_ALREADY_MAPPED. The probe
// is a point-in-time answer to a question whose answer changes.
export function isEncoderOpenFailure(stderr: string): boolean {
  return /No capable devices|Could not open encoder|cuCtxCreate|OpenEncodeSessionEx|Error while opening encoder|Cannot load nvcuda/i.test(
    stderr,
  );
}

// Give up on the hardware encoder for the rest of this process and use libx264. Called when an
// encode actually fails to open — the render must not die because another process took the VRAM
// (invariant 7). Not reversible on purpose: once the GPU has proven unreliable under real load,
// flapping back would just fail the next beat.
export function demoteToSoftware(reason: string): boolean {
  if (resolved === 'libx264') return false; // already demoted — the failure is something else
  console.warn(
    `[encoder] "${resolved ?? CONFIGURED}" failed to open mid-run (${reason}) — demoting to ` +
      'libx264 (CPU) for the rest of this process. Usually VRAM: the sidecar + Ollama can fill a ' +
      '16 GB card. OLLAMA_MAX_LOADED_MODELS=1 and a shorter keep_alive free it sooner.',
  );
  resolved = 'libx264';
  probe = Promise.resolve('libx264');
  return true;
}

// Test-only: forget the probed encoder so a changed env/driver is re-evaluated.
export function _resetEncoderProbe(): void {
  resolved = null;
  probe = null;
}
