import { env } from '@scriptreel/config';
import {
  PipelineError,
  PROVIDER_QUOTA_CODE,
  PROVIDER_WINDOWS,
  type ProviderId,
  truncateWindow,
  usageKeyFor,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { Logger } from 'pino';

// Durable, per-KEY token accounting in provider_usage (doc 08 + doc 23 key pool).
// Reserves one request across a provider's pool of keys and returns the key/token to
// use; rotates to the next key when one is at budget. Throws E_QUOTA_* only when
// every key is exhausted (the SearchClient then degrades that request to empty).
export class QuotaGuard {
  constructor(private readonly log: Logger) {}

  async reserve(provider: ProviderId): Promise<string> {
    const keys = await this.keysFor(provider);
    const windows = PROVIDER_WINDOWS[provider];
    const now = new Date();
    for (const key of keys) {
      let ok = true;
      for (const w of windows) {
        const r = await db.reserveQuota(
          usageKeyFor(w.key, key.id),
          truncateWindow(now, w.unit),
          w.budget,
        );
        if (r === null) {
          ok = false;
          break;
        }
      }
      if (ok) return key.secret;
    }
    this.log.warn({ provider, keys: keys.length }, 'all keys at budget — skipping request');
    throw new PipelineError(
      PROVIDER_QUOTA_CODE[provider],
      'search',
      `${provider}: all keys at budget`,
    );
  }

  // Pooled DB keys first; else the single .env key (backward compatible); else
  // anonymous for Openverse. No key at all → provider unavailable.
  private async keysFor(provider: ProviderId): Promise<{ id: string; secret: string }[]> {
    const pooled = await db.activeKeysFor(provider);
    if (pooled.length > 0) return pooled;
    if (provider === 'pexels' && env.PEXELS_API_KEY) {
      return [{ id: 'env', secret: env.PEXELS_API_KEY }];
    }
    if (provider === 'pixabay' && env.PIXABAY_API_KEY) {
      return [{ id: 'env', secret: env.PIXABAY_API_KEY }];
    }
    if (provider === 'openverse') return [{ id: 'anon', secret: '' }]; // anonymous 200/day
    return [];
  }
}
