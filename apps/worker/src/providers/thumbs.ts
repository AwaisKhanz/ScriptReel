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
// Videos may carry several preview frames (doc 25 §4) → {id}_{i}.jpg, see ensureFrames.

function thumbDir(candidate: RawCandidate): string {
  return join(paths.cacheDir, 'thumbs', candidate.provider);
}

function thumbPath(candidate: RawCandidate): string {
  return join(thumbDir(candidate), `${candidate.providerId}.jpg`);
}

function framePath(candidate: RawCandidate, i: number): string {
  return join(thumbDir(candidate), `${candidate.providerId}_${i}.jpg`);
}

// Already cached with content → reuse so re-runs stay network-free (doc 08).
async function isCached(outPath: string): Promise<boolean> {
  try {
    return (await stat(outPath)).size > 0;
  } catch {
    return false;
  }
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

// The original single-thumbnail path (doc 08): provider thumb, else a frame grab from
// the tiny video variant (Pixabay). Returns the absolute thumb path, or null on failure.
async function ensureSingleThumb(
  candidate: RawCandidate,
  signal: AbortSignal,
): Promise<string | null> {
  const outPath = thumbPath(candidate);
  if (await isCached(outPath)) return outPath;
  await mkdir(thumbDir(candidate), { recursive: true });
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

// Download + resize one preview-frame URL to outPath, reusing an already-cached file.
// Returns outPath on success, null on any failure — one bad frame never fails the set.
async function cacheFrame(
  url: string,
  outPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (await isCached(outPath)) return outPath;
  try {
    await resizeToJpeg(await fetchBuffer(url, signal), outPath);
    return outPath;
  } catch {
    return null;
  }
}

// Download + resize an arbitrary image URL to an explicit outPath (doc 25 §5-C) — used
// for entity reference images the identity gate embeds. Same download/resize/cache path
// as cacheFrame, but the caller names the destination (references/<slug>.jpg) and ensures
// its directory. Returns outPath on success, null on any failure (never throws —
// invariant 7). Reuses an already-cached file so re-runs stay network-free.
export async function cacheImageTo(
  url: string,
  outPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (await isCached(outPath)) return outPath;
  try {
    await mkdir(join(outPath, '..'), { recursive: true });
    await resizeToJpeg(await fetchBuffer(url, signal), outPath);
    return outPath;
  } catch {
    return null;
  }
}

// Returns the absolute thumb path, or null if it couldn't be produced (doc 08). Kept as
// the single-thumb API for callers that don't need multi-frame (ladder, beat-research).
export async function ensureThumb(
  candidate: RawCandidate,
  signal: AbortSignal,
): Promise<string | null> {
  return ensureSingleThumb(candidate, signal);
}

// Multi-frame candidate representation (doc 25 §4). When a provider supplies ≥2 preview
// frames (Pexels `video_pictures`), cache each so the score stage can judge the video on
// its best-matching frame; `primary` (the middle ≈50% frame) is the representative stored
// as the candidate's thumb_path. Falls back to the single-thumb path when fewer than 2
// frames are available or succeed, so every candidate degrades to one thumb. null ⇒ drop.
export async function ensureFrames(
  candidate: RawCandidate,
  signal: AbortSignal,
): Promise<{ primary: string; frames: string[] } | null> {
  const urls = candidate.frameUrls ?? [];
  if (urls.length >= 2) {
    await mkdir(thumbDir(candidate), { recursive: true });
    const frames: string[] = [];
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      if (!url) continue;
      const path = await cacheFrame(url, framePath(candidate, i), signal);
      if (path) frames.push(path);
    }
    if (frames.length >= 2) {
      const mid = frames[Math.floor(frames.length / 2)];
      if (mid) return { primary: mid, frames };
    }
    // <2 frames succeeded — fall through to the single-thumb path.
  }
  const thumb = await ensureSingleThumb(candidate, signal);
  return thumb ? { primary: thumb, frames: [thumb] } : null;
}
