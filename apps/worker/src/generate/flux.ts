import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { execa } from 'execa';
import type { Logger } from 'pino';

// Generative fallback client (doc 25 §5-E, cascade E). The worker NEVER imports the
// generator: FLUX/mflux needs numpy>=2 + torch>=2.7 + transformers>=5, which conflict with
// the sidecar's pinned numpy<2 (mlx-whisper's numba). So it lives in its own isolated venv
// (services/gen) and we shell out to it as a subprocess — exactly like we shell out to
// ffmpeg.
//
// DEGRADE, NEVER DIE (invariant 7): generation is OPTIONAL and NOT set up by default. If
// the venv is missing, the model isn't downloaded, the subprocess errors, or it times out,
// generateImage returns null and the fallback ladder's Rung 4 drops through to the text
// card (which always succeeds). Until `make gen-setup && make fetch-gen` are run, the
// pipeline behaves exactly as it does today.

// The repo root holds services/gen (rootDir is where the .env lives — see config/env.ts).
const GEN_DIR = join(rootDir, 'services', 'gen');
const CHECK_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 180_000;

// Availability is probed once per worker process and cached. A `uv run … --check` that
// exits 0 means the venv installed AND the FLUX model is present in the local cache. Any
// spawn error (uv not on PATH, venv absent) ⇒ unavailable. Logged once, on the first probe.
let _available: boolean | null = null;

async function genAvailable(log: Logger): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const res = await execa(
      'uv',
      ['run', '--directory', GEN_DIR, 'python', '-m', 'gen', '--check'],
      { timeout: CHECK_TIMEOUT_MS, reject: false },
    );
    _available = res.exitCode === 0;
  } catch {
    _available = false; // uv not installed / spawn failure ⇒ generator unavailable
  }
  if (!_available) {
    log.info(
      'generative fallback unavailable — run `make gen-setup && make fetch-gen` to enable (Rung 4 falls to the text card)',
    );
  }
  return _available;
}

// Generate ONE image for an abstract/non-entity beat and return its path, or null on any
// failure (missing generator, subprocess error, timeout, no output file). Never throws.
export async function generateImage(args: {
  prompt: string;
  width: number;
  height: number;
  outPath: string;
  signal: AbortSignal;
  log: Logger;
}): Promise<string | null> {
  const { prompt, width, height, outPath, signal, log } = args;
  if (!(await genAvailable(log))) return null;
  try {
    const res = await execa(
      'uv',
      [
        'run',
        '--directory',
        GEN_DIR,
        'python',
        '-m',
        'gen',
        '--prompt',
        prompt,
        '--width',
        String(width),
        '--height',
        String(height),
        '--steps',
        '4',
        '--out',
        outPath,
      ],
      { ...(signal ? { cancelSignal: signal } : {}), timeout: GENERATE_TIMEOUT_MS, reject: false },
    );
    if (res.exitCode !== 0) {
      log.warn(
        { stderr: res.stderr },
        'generative fallback failed — falling through to the text card',
      );
      return null;
    }
    // A 0-exit with no (or empty) file still degrades — confirm the PNG actually landed.
    const st = await stat(outPath).catch(() => null);
    if (!st?.isFile() || st.size === 0) return null;
    return outPath;
  } catch (err) {
    log.warn({ err }, 'generative fallback errored — falling through to the text card');
    return null;
  }
}
