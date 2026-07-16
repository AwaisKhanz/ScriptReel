import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { THUMB_MAX_SIDE } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import sharp from 'sharp';
import { z } from 'zod';

// pnpm eval:fixtures — rebuild the labeled eval thumbs that fixtures/eval/labels.jsonl points at.
//
// labels.jsonl references data/cache/thumbs/{provider}/{id}.jpg, but data/cache is a machine-local
// render cache: it isn't committed and doesn't sync between machines. So a fresh clone — or a
// second dev box — cannot run `pnpm eval:matching` at all, because the thumbs simply aren't there.
// That makes the calibration baseline unreproducible, which matters because every scoring/model
// change is supposed to be measured against it (doc 21; CLAUDE.md: τ are model-specific, re-run the
// eval). This refetches each labeled asset from its provider by id and writes the thumb with the
// SAME convention as providers/thumbs.ts (384px max side, jpeg q82) so scores stay comparable.
//
// Idempotent: an existing thumb is left untouched, so re-running is free and never rewrites a
// fixture you've already labelled against.

const LabelSchema = z.object({
  thumbPath: z.string(),
  kind: z.enum(['video', 'image']),
});

// Only the fields we need to derive a thumb URL, mirroring providers/pexels.ts.
const PexelsVideoSchema = z.object({
  image: z.string(),
  video_pictures: z.array(z.object({ picture: z.string() })).nullish(),
});
const PexelsPhotoSchema = z.object({ src: z.object({ medium: z.string() }) });

interface Target {
  thumbPath: string; // as written in labels.jsonl (repo-relative)
  absPath: string;
  provider: string;
  providerId: string;
  kind: 'video' | 'image';
}

function parseTargets(raw: string): Target[] {
  const seen = new Map<string, Target>();
  for (const [i, line] of raw.split('\n').entries()) {
    const l = line.trim();
    if (!l || l.startsWith('//')) continue;
    const parsed = LabelSchema.safeParse(JSON.parse(l));
    if (!parsed.success) throw new Error(`labels.jsonl line ${i + 1}: ${parsed.error.message}`);
    const { thumbPath, kind } = parsed.data;
    if (seen.has(thumbPath)) continue;
    // .../thumbs/{provider}/{providerId}.jpg — the convention in providers/thumbs.ts.
    const m = /thumbs[/\\]([^/\\]+)[/\\](.+)\.jpg$/.exec(thumbPath);
    if (!m?.[1] || !m[2])
      throw new Error(
        `unrecognised thumbPath (expected .../thumbs/{provider}/{id}.jpg): ${thumbPath}`,
      );
    seen.set(thumbPath, {
      thumbPath,
      absPath: isAbsolute(thumbPath) ? thumbPath : resolve(rootDir, thumbPath),
      provider: m[1],
      providerId: m[2],
      kind,
    });
  }
  return [...seen.values()];
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

// The single-thumb URL for a Pexels asset, matching providers/pexels.ts:
// video → first preview frame (falling back to `image`); photo → src.medium.
async function pexelsThumbUrl(t: Target, apiKey: string): Promise<string> {
  const url =
    t.kind === 'video'
      ? `https://api.pexels.com/videos/videos/${t.providerId}`
      : `https://api.pexels.com/v1/photos/${t.providerId}`;
  const res = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`pexels ${t.kind} ${t.providerId} → HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (t.kind === 'video') {
    const v = PexelsVideoSchema.parse(json);
    return v.video_pictures?.[0]?.picture ?? v.image;
  }
  return PexelsPhotoSchema.parse(json).src.medium;
}

async function writeThumb(srcUrl: string, outPath: string): Promise<void> {
  const res = await fetch(srcUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`thumb download → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Identical to providers/thumbs.ts resizeToJpeg — keeps embeddings comparable.
  const jpeg = await sharp(buf)
    .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, jpeg);
}

async function main(): Promise<void> {
  const targets = parseTargets(
    await readFile(resolve(rootDir, 'fixtures/eval/labels.jsonl'), 'utf8'),
  );
  const unsupported = [...new Set(targets.map((t) => t.provider))].filter((p) => p !== 'pexels');
  if (unsupported.length > 0) {
    throw new Error(`only pexels fixtures can be rebuilt today; found: ${unsupported.join(', ')}`);
  }

  const missing: Target[] = [];
  for (const t of targets) if (!(await exists(t.absPath))) missing.push(t);
  console.log(
    `labels: ${targets.length} unique thumbs · present ${targets.length - missing.length} · missing ${missing.length}`,
  );
  if (missing.length === 0) {
    console.log('nothing to do — fixture is complete.');
    await db.closeDb();
    return;
  }

  // Keys live in the DB (provider_keys / the Settings UI), not .env — resolve them the same
  // way the pipeline does.
  const keys = await db.activeKeysFor('pexels');
  const apiKey = keys[0]?.creds.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('no active pexels API key — add one in Settings, then re-run');
  }

  let ok = 0;
  const failed: string[] = [];
  for (const t of missing) {
    try {
      await writeThumb(await pexelsThumbUrl(t, apiKey), t.absPath);
      ok += 1;
      console.log(`  ok   ${t.thumbPath}`);
    } catch (err) {
      failed.push(`${t.thumbPath}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  FAIL ${t.thumbPath}`);
    }
  }
  console.log(`\nrebuilt ${ok}/${missing.length}`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const f of failed) console.log(`  ${f}`);
    process.exitCode = 1;
  }
  await db.closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
