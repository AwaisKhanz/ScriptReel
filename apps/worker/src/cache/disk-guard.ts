import { rm } from 'node:fs/promises';
import { freeDiskBytes, paths } from '@scriptreel/config';
import { PipelineError, type PipelineStage } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { Logger } from 'pino';

// Keep at least this much free on the DATA_DIR filesystem. A render's downloads +
// normalized clips + final mp4 fit comfortably under a GB; below the floor we evict
// the shared asset cache (LRU) before giving up with E_DISK_FULL (doc 14 disk guard).
export const MIN_FREE_DISK_BYTES = 1_000_000_000; // 1 GB

// Ensure ~`need` bytes are free before a disk-heavy stage. Evicts least-recently-used
// cached assets to reclaim space first; throws E_DISK_FULL (a hard, non-retryable
// failure — the user must free space) only if the floor still can't be met.
export async function ensureDiskSpace(
  stage: PipelineStage,
  log: Logger,
  need = MIN_FREE_DISK_BYTES,
): Promise<void> {
  let free = await freeDiskBytes(paths.dataDir);
  if (free >= need) return;

  log.warn(
    { freeMB: Math.round(free / 1e6), needMB: Math.round(need / 1e6) },
    'low disk — evicting asset cache',
  );
  let evicted = 0;
  for (let round = 0; round < 20 && free < need; round += 1) {
    const lru = await db.assetCacheLRU(50);
    if (lru.length === 0) break;
    const ids: string[] = [];
    for (const asset of lru) {
      await rm(asset.local_path, { force: true }).catch(() => {});
      ids.push(asset.id);
      evicted += asset.bytes ?? 0;
    }
    await db.deleteAssetCacheByIds(ids);
    free = await freeDiskBytes(paths.dataDir);
  }

  if (evicted > 0)
    log.info(
      { evictedMB: Math.round(evicted / 1e6), freeMB: Math.round(free / 1e6) },
      'asset cache evicted',
    );
  if (free < need) {
    throw new PipelineError(
      'E_DISK_FULL',
      stage,
      `only ${Math.round(free / 1e6)} MB free on ${paths.dataDir} (need ${Math.round(need / 1e6)} MB) — free up disk and retry`,
    );
  }
}
