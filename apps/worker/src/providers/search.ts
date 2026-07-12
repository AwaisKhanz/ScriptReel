import {
  type MediaProvider,
  PipelineError,
  type ProviderId,
  type RawCandidate,
  type SearchQuery,
} from '@scriptreel/core';
import type { Logger } from 'pino';
import { resolveAuth } from './auth';
import { NasaProvider } from './nasa';
import { OpenverseProvider } from './openverse';
import { PexelsProvider } from './pexels';
import { PixabayProvider } from './pixabay';
import type { QuotaGuard } from './quota-guard';
import { readSearchCache, writeSearchCache } from './search-cache';
import { WikidataCommonsProvider } from './wikidata-commons';
import { WikimediaProvider } from './wikimedia';

export interface SearchResult {
  candidates: RawCandidate[];
  cacheHit: boolean;
}

// The only path to a provider (invariant 6): SearchCache → QuotaGuard → one HTTP
// request → cache the raw response. Quota exhaustion and HTTP failures degrade the
// single request to empty (invariant 7); cancellation propagates.
export class SearchClient {
  private readonly providers: Record<ProviderId, MediaProvider>;

  constructor(
    private readonly guard: QuotaGuard,
    private readonly log: Logger,
  ) {
    this.providers = {
      pexels: new PexelsProvider(),
      pixabay: new PixabayProvider(),
      openverse: new OpenverseProvider(),
      nasa: new NasaProvider(),
      wikimedia: new WikimediaProvider(),
      'wikidata-commons': new WikidataCommonsProvider(),
    };
  }

  async search(query: SearchQuery, providerId: ProviderId): Promise<SearchResult> {
    // Entity resolution varies by `want` (a flag vs a map of the same name) — keep them
    // in distinct cache slots (doc 24 §4). Empty for ordinary stock requests.
    const variant = query.entity?.want ?? '';
    const cached = await readSearchCache(
      providerId,
      query.kind,
      query.orientation,
      query.query,
      variant,
    );
    if (cached) return { candidates: cached, cacheHit: true };

    try {
      const creds = await this.guard.reserve(providerId); // pooled credentials (doc 23)
      const auth = await resolveAuth(providerId, creds); // static key or refreshed OAuth token
      const candidates = await this.providers[providerId].search(query, auth);
      await writeSearchCache(
        providerId,
        query.kind,
        query.orientation,
        query.query,
        candidates,
        variant,
      );
      return { candidates, cacheHit: false };
    } catch (err) {
      if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
      if (
        err instanceof PipelineError &&
        (err.code === 'E_QUOTA_PEXELS' ||
          err.code === 'E_QUOTA_PIXABAY' ||
          err.code === 'E_QUOTA_OPENVERSE' ||
          err.code === 'E_QUOTA_NASA' ||
          err.code === 'E_QUOTA_WIKIMEDIA' ||
          err.code === 'E_QUOTA_WIKIDATA')
      ) {
        this.log.warn({ providerId, code: err.code }, 'quota exhausted — skipping request');
        return { candidates: [], cacheHit: false };
      }
      this.log.warn({ providerId, kind: query.kind, err }, 'provider search failed — skipping');
      return { candidates: [], cacheHit: false };
    }
  }
}
