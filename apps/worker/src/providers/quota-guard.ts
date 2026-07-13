import { env } from '@scriptreel/config';
import {
  PipelineError,
  PROVIDER_QUOTA_CODE,
  PROVIDER_WINDOWS,
  type ProviderCredentials,
  type ProviderId,
  truncateWindow,
  usageKeyFor,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { Logger } from 'pino';

// Durable, per-KEY token accounting in provider_usage (doc 08 + doc 23 key pool).
// Reserves one request across a provider's pool of keys and returns the winning
// key's credentials; rotates to the next key when one is at budget. Throws E_QUOTA_*
// only when every key is exhausted (SearchClient then degrades to empty).
export class QuotaGuard {
  constructor(private readonly log: Logger) {}

  async reserve(provider: ProviderId): Promise<ProviderCredentials> {
    const keys = await this.keysFor(provider);
    if (keys.length === 0) {
      // No API key configured for this provider — a clean skip, NOT quota exhaustion. Add one in
      // Settings to enable it; the search stage just uses the other providers (invariant 7).
      this.log.warn(
        { provider },
        `${provider}: no API key configured — add one in Settings to use it`,
      );
      throw new PipelineError(PROVIDER_QUOTA_CODE[provider], 'search', `${provider}: no API key`);
    }
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
      if (ok) return key.creds;
    }
    this.log.warn({ provider, keys: keys.length }, 'all keys at budget — skipping request');
    throw new PipelineError(
      PROVIDER_QUOTA_CODE[provider],
      'search',
      `${provider}: all keys at budget`,
    );
  }

  // Pooled DB keys first; else the single .env key (backward compatible); else
  // anonymous for keyless providers. No credentials → provider unavailable.
  private async keysFor(
    provider: ProviderId,
  ): Promise<{ id: string; creds: ProviderCredentials }[]> {
    const pooled = await db.activeKeysFor(provider);
    if (pooled.length > 0) return pooled;
    if (provider === 'pexels' && env.PEXELS_API_KEY) {
      return [{ id: 'env', creds: { apiKey: env.PEXELS_API_KEY } }];
    }
    if (provider === 'pixabay' && env.PIXABAY_API_KEY) {
      return [{ id: 'env', creds: { apiKey: env.PIXABAY_API_KEY } }];
    }
    if (
      provider === 'openverse' ||
      provider === 'nasa' ||
      provider === 'wikimedia' ||
      provider === 'wikidata-commons' ||
      provider === 'met' ||
      provider === 'internet-archive' ||
      provider === 'inaturalist' ||
      provider === 'usgs' ||
      provider === 'library-of-congress'
    ) {
      return [{ id: 'anon', creds: {} }]; // Openverse anon / NASA + Wikimedia + Wikidata + Met + IA + iNaturalist + USGS + LoC keyless
    }
    return [];
  }
}
