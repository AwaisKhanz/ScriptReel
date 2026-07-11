import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dirSizeBytes, freeDiskBytes, paths } from '@scriptreel/config';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cache buckets under DATA_DIR/cache (doc 16 Settings). 'assets' also carries
// asset_cache DB rows; the rest are pure disk.
const BUCKETS = ['assets', 'thumbs', 'search', 'voice-samples'] as const;
type Bucket = (typeof BUCKETS)[number];

export async function GET() {
  try {
    const sizes = await Promise.all(
      BUCKETS.map(async (b) => ({ bucket: b, bytes: await dirSizeBytes(join(paths.cacheDir, b)) })),
    );
    const free = await freeDiskBytes(paths.dataDir);
    return NextResponse.json({ buckets: sizes, free });
  } catch (error) {
    return NextResponse.json(
      { error: 'cache stat failed', detail: String(error) },
      { status: 502 },
    );
  }
}

const ClearSchema = z.object({ bucket: z.enum(BUCKETS) });

export async function POST(req: Request) {
  const parsed = ClearSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `bucket must be one of ${BUCKETS.join(', ')}` },
      {
        status: 400,
      },
    );
  }
  const bucket: Bucket = parsed.data.bucket;
  try {
    const dir = join(paths.cacheDir, bucket);
    const before = await dirSizeBytes(dir);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    let rows = 0;
    if (bucket === 'assets') rows = await db.deleteAllAssetCache();
    return NextResponse.json({ bucket, freed: before, rows });
  } catch (error) {
    return NextResponse.json({ error: 'clear failed', detail: String(error) }, { status: 502 });
  }
}
