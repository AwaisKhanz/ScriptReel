import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import { type RawCandidate, THUMB_MAX_SIDE } from '@scriptreel/core';
import { execa } from 'execa';
import sharp from 'sharp';
import { FFMPEG_BIN } from '../ffmpeg/bin';

// Thumbnail pipeline (doc 08 §Thumbnail pipeline). Download each candidate's thumb
// → cache/thumbs/{provider}/{id}.jpg, resize to 384px max side (SigLIP input).
// A failed thumb drops the candidate (caller filters nulls), never fails the stage.

function thumbPath(candidate: RawCandidate): string {
  return join(paths.cacheDir, 'thumbs', candidate.provider, `${candidate.providerId}.jpg`);
}

async function fetchBuffer(url: string, signal: AbortSignal): Promise<Buffer> {
  // Cancel on pipeline abort OR after 8 s — a hung CDN connection must not stall
  // the stage's bounded thumbnail pool (doc 07 invariant 7: degrade, never die).
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
  if (!res.ok) throw new Error(`thumb HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resizeToJpeg(input: Buffer, outPath: string): Promise<void> {
  const jpeg = await sharp(input)
    .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  await writeFile(outPath, jpeg);
}

// Pixabay video with no thumbnail field: extract frame 0 of the tiny variant.
async function thumbFromVideoFrame(videoUrl: string, outPath: string): Promise<void> {
  const scale = `scale='if(gt(iw,ih),${THUMB_MAX_SIDE},-2)':'if(gt(iw,ih),-2,${THUMB_MAX_SIDE})'`;
  await execa(
    FFMPEG_BIN,
    ['-v', 'error', '-nostdin', '-i', videoUrl, '-frames:v', '1', '-vf', scale, '-y', outPath],
    { timeout: 20_000 },
  );
}

// Returns the absolute thumb path, or null if it couldn't be produced.
export async function ensureThumb(
  candidate: RawCandidate,
  signal: AbortSignal,
): Promise<string | null> {
  const outPath = thumbPath(candidate);
  // Already cached by provider+id → reuse (re-runs stay truly network-free, doc 08).
  try {
    if ((await stat(outPath)).size > 0) return outPath;
  } catch {
    // not cached yet — download below
  }
  await mkdir(join(paths.cacheDir, 'thumbs', candidate.provider), { recursive: true });
  try {
    if (candidate.thumbUrl) {
      await resizeToJpeg(await fetchBuffer(candidate.thumbUrl, signal), outPath);
      return outPath;
    }
    const tinyUrl = candidate.meta?.tinyUrl;
    if (typeof tinyUrl === 'string' && tinyUrl.length > 0) {
      await thumbFromVideoFrame(tinyUrl, outPath);
      return outPath;
    }
    return null;
  } catch {
    return null; // drop the candidate; caller logs the count
  }
}
