import { createHash } from 'node:crypto';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '@scriptreel/config';
import { PipelineError } from '@scriptreel/core';
import * as db from '@scriptreel/db';

// Downloaded originals live in a shared, project-independent cache (doc 08). Keyed by
// (provider, provider_id, kind) so an asset chosen by two projects is fetched once.

export interface DownloadRequest {
  provider: string;
  providerId: string;
  kind: string; // 'video' | 'image'
  remoteUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  license?: string;
  author?: string;
  pageUrl?: string;
}

function extFor(kind: string): string {
  return kind === 'video' ? 'mp4' : 'jpg';
}

function cachePath(provider: string, providerId: string, kind: string): string {
  return join(paths.cacheDir, 'assets', provider, `${providerId}.${extFor(kind)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Download to the shared cache, or reuse an existing copy (warm cache → no network).
export async function downloadToCache(
  req: DownloadRequest,
  signal: AbortSignal,
): Promise<db.AssetCacheRow> {
  const cached = await db.getCachedAsset(req.provider, req.providerId, req.kind);
  if (cached && (await exists(cached.local_path))) {
    await db.touchCachedAsset(cached.id);
    return cached;
  }

  const outPath = cachePath(req.provider, req.providerId, req.kind);
  let bytes: Buffer;
  try {
    const res = await fetch(req.remoteUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    throw new PipelineError(
      'E_DOWNLOAD',
      'fetch',
      `download failed: ${req.provider}:${req.providerId}`,
      {
        cause,
      },
    );
  }
  if (bytes.length === 0) {
    throw new PipelineError(
      'E_DOWNLOAD',
      'fetch',
      `empty download: ${req.provider}:${req.providerId}`,
    );
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');

  return db.upsertCachedAsset({
    provider: req.provider,
    providerId: req.providerId,
    kind: req.kind,
    localPath: outPath,
    bytes: (await stat(outPath)).size,
    ...(req.width !== undefined ? { width: req.width } : {}),
    ...(req.height !== undefined ? { height: req.height } : {}),
    ...(req.duration !== undefined ? { duration: req.duration } : {}),
    ...(req.license !== undefined ? { license: req.license } : {}),
    ...(req.author !== undefined ? { author: req.author } : {}),
    ...(req.pageUrl !== undefined ? { pageUrl: req.pageUrl } : {}),
    checksum,
  });
}
