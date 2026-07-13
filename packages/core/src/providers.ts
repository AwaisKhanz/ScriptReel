import type { EntityCategory, ShotWant } from './analysis';
import {
  EUROPEANA_HOUR_BUDGET,
  FLICKR_HOUR_BUDGET,
  INATURALIST_HOUR_BUDGET,
  INTERNET_ARCHIVE_HOUR_BUDGET,
  LIBRARY_OF_CONGRESS_HOUR_BUDGET,
  MET_HOUR_BUDGET,
  NASA_HOUR_BUDGET,
  OPENVERSE_DAY_BUDGET,
  PEXELS_HOUR_BUDGET,
  PEXELS_MONTH_BUDGET,
  PIXABAY_MINUTE_BUDGET,
  SMITHSONIAN_HOUR_BUDGET,
  USGS_HOUR_BUDGET,
  WIKIDATA_HOUR_BUDGET,
  WIKIMEDIA_HOUR_BUDGET,
} from './constants';
import { sha1Hex } from './hash';
import type { RequestAuth } from './provider-auth';
import type { SubtitleAspect } from './subtitles/presets';

// Media provider seam (doc 08). Types + pure helpers live here; the HTTP impls
// (PexelsProvider/PixabayProvider) live in the worker. Every call goes through
// QuotaGuard then SearchCache — no path may hit a provider directly.

export type ProviderId =
  | 'pexels'
  | 'pixabay'
  | 'openverse'
  | 'nasa'
  | 'wikimedia'
  | 'wikidata-commons'
  | 'met'
  | 'internet-archive'
  | 'inaturalist'
  | 'usgs'
  | 'library-of-congress'
  | 'flickr'
  | 'europeana'
  | 'smithsonian';
export type MediaKind = 'video' | 'image';
export type Orientation = 'landscape' | 'portrait' | 'square';

// Authoritative-resolution context (doc 24 §4): present on a request when we're resolving
// a specific entity to its real Commons/NASA asset. `wikidata-commons` reads it; other
// providers ignore it. `want` also enters the cache key so a flag and a map of the same
// entity don't collide.
export interface EntitySearchContext {
  canonical: string;
  category: EntityCategory;
  instanceOf: string;
  want: ShotWant;
}

export interface SearchQuery {
  query: string;
  kind: MediaKind;
  orientation: Orientation;
  perPage: number;
  entity?: EntitySearchContext;
}

export interface RawCandidate {
  provider: ProviderId;
  providerId: string;
  kind: MediaKind;
  width: number;
  height: number;
  duration?: number;
  thumbUrl: string;
  // Provider-supplied preview-frame image URLs for a video, spread across the clip and in
  // clip order; empty/absent ⇒ single-thumb behavior. Lets the score stage judge a video
  // on its best-matching frame instead of one thumbnail (doc 25 §4 multi-frame candidates).
  frameUrls?: string[];
  downloadUrl: string;
  pageUrl: string;
  author: string;
  license: string;
  meta?: Record<string, unknown>;
}

export interface MediaProvider {
  id: ProviderId;
  // one HTTP request max; `auth` is already resolved (a key or a refreshed OAuth
  // token) by the worker's auth resolver — providers just apply it (doc 23).
  search(query: SearchQuery, auth: RequestAuth): Promise<RawCandidate[]>;
}

// SearchCache key (doc 08): sha1(provider + kind + orientation + normalize(query)).
export function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function searchCacheKey(
  provider: string,
  kind: string,
  orientation: string,
  query: string,
  variant = '', // e.g. a shot's `want` — keeps flag vs map of the same entity distinct
): string {
  const suffix = variant ? `|${variant}` : ''; // conditional → non-entity keys stay byte-identical
  return sha1Hex(`${provider}|${kind}|${orientation}|${normalizeSearchQuery(query)}${suffix}`);
}

// Trailing atmosphere/time words carry mood, not subject — strip them before
// reducing a literal query to its head noun phrase (doc 09 §ladder rung 1).
const ATMOSPHERE_WORDS = new Set([
  'dusk',
  'dawn',
  'sunset',
  'sunrise',
  'morning',
  'evening',
  'night',
  'daylight',
  'light',
  'golden',
  'hour',
  'bokeh',
  'cinematic',
  'moody',
  'soft',
  'ambient',
  'background',
  'atmosphere',
  'mood',
  'closeup',
  'macro',
]);

// Rule-based query broadening for the fallback ladder (doc 09 rung 1): drop trailing
// atmosphere words, then reduce toward the head noun phrase. Returns up to `max`
// progressively broader forms, never the original. "rusty farm gate dusk" → ["farm
// gate", "gate"].
export function broadenQuery(query: string, max = 2): string[] {
  let words = normalizeSearchQuery(query)
    .split(' ')
    .filter((w) => w.length > 0);
  while (words.length > 1 && ATMOSPHERE_WORDS.has(words[words.length - 1] ?? '')) {
    words = words.slice(0, -1);
  }
  const candidates: string[] = [];
  if (words.length >= 3) candidates.push(words.slice(-2).join(' '));
  candidates.push(words.slice(-1).join(' '));

  const seen = new Set([normalizeSearchQuery(query)]);
  const out: string[] = [];
  for (const c of candidates) {
    if (c.length > 0 && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.slice(0, max);
}

export function orientationForAspect(aspect: SubtitleAspect): Orientation {
  switch (aspect) {
    case '9:16':
      return 'portrait';
    case '1:1':
      return 'square';
    default:
      return 'landscape';
  }
}

export function targetHeightForAspect(aspect: SubtitleAspect): number {
  return aspect === '9:16' ? 1920 : 1080;
}

// Tier-1 request plan per beat (doc 08 §what the search stage requests).
export interface PlannedRequest {
  provider: ProviderId;
  kind: MediaKind;
  query: string;
  entity?: EntitySearchContext; // set for authoritative entity resolution (doc 24 §5)
}

export function planTier1Requests(
  literal: readonly string[],
  mediaPreference: 'videos' | 'mixed' | 'photos',
  sources: readonly ProviderId[] = [],
): PlannedRequest[] {
  const l0 = literal[0] ?? '';
  const l1 = literal[1] ?? l0;
  const requests: PlannedRequest[] = [
    { provider: 'pexels', kind: 'video', query: l0 },
    { provider: 'pixabay', kind: 'video', query: l1 },
  ];
  if (mediaPreference === 'mixed' || mediaPreference === 'photos') {
    requests.push({ provider: 'pixabay', kind: 'image', query: l0 });
    // Openverse: universal copyright-free CC/PD image reach (doc 23), image-only.
    requests.push({ provider: 'openverse', kind: 'image', query: l0 });
  }
  if (mediaPreference === 'photos') {
    requests.push({ provider: 'pexels', kind: 'image', query: l1 });
  }
  // Topic/era-routed specialized archives (see topics.ts::routeTopicSources — the caller resolves
  // which sources a beat warrants). Each fires on the beat literal, gated by its OWN media kind so
  // image archives (nasa/wikimedia/met) serve mixed/photos and the video archive (internet-archive)
  // serves mixed/videos. An id with no archive kind (a base/stock provider) is ignored here.
  for (const id of sources) {
    const kind = ARCHIVE_KIND[id];
    if (!kind) continue;
    const wanted = kind === 'video' ? mediaPreference !== 'photos' : mediaPreference !== 'videos';
    if (wanted) requests.push({ provider: id, kind, query: l0 });
  }
  return requests.filter((r) => r.query.length > 0);
}

// Candidate hygiene at ingest (doc 08 §candidate hygiene).
export function passesHygiene(candidate: RawCandidate, targetHeight: number): boolean {
  if (candidate.kind === 'video' && (candidate.duration ?? 0) < 2) return false;
  if (candidate.height > 0 && candidate.height < 0.6 * targetHeight) return false;
  const targetAspect =
    candidate.width > 0 && candidate.height > 0 ? candidate.width / candidate.height : 1;
  if (targetAspect > 3 || targetAspect < 0.28) return false; // extreme mismatch
  return true;
}

// Durable quota accounting (doc 08 §QuotaGuard). One bucket key per rate window;
// shared by the worker guard (reserve) and the web /api/quota meter (read).
export type QuotaWindowUnit = 'minute' | 'hour' | 'day' | 'month';

export interface QuotaBudget {
  key: string; // provider_usage.provider value
  unit: QuotaWindowUnit;
  budget: number;
}

export const QUOTA_BUDGETS: readonly QuotaBudget[] = [
  { key: 'pexels:hour', unit: 'hour', budget: PEXELS_HOUR_BUDGET },
  { key: 'pexels:month', unit: 'month', budget: PEXELS_MONTH_BUDGET },
  { key: 'pixabay:minute', unit: 'minute', budget: PIXABAY_MINUTE_BUDGET },
  { key: 'openverse:day', unit: 'day', budget: OPENVERSE_DAY_BUDGET },
  { key: 'nasa:hour', unit: 'hour', budget: NASA_HOUR_BUDGET },
  { key: 'wikimedia:hour', unit: 'hour', budget: WIKIMEDIA_HOUR_BUDGET },
  { key: 'wikidata-commons:hour', unit: 'hour', budget: WIKIDATA_HOUR_BUDGET },
  { key: 'met:hour', unit: 'hour', budget: MET_HOUR_BUDGET },
  { key: 'internet-archive:hour', unit: 'hour', budget: INTERNET_ARCHIVE_HOUR_BUDGET },
  { key: 'inaturalist:hour', unit: 'hour', budget: INATURALIST_HOUR_BUDGET },
  { key: 'usgs:hour', unit: 'hour', budget: USGS_HOUR_BUDGET },
  { key: 'library-of-congress:hour', unit: 'hour', budget: LIBRARY_OF_CONGRESS_HOUR_BUDGET },
  { key: 'flickr:hour', unit: 'hour', budget: FLICKR_HOUR_BUDGET },
  { key: 'europeana:hour', unit: 'hour', budget: EUROPEANA_HOUR_BUDGET },
  { key: 'smithsonian:hour', unit: 'hour', budget: SMITHSONIAN_HOUR_BUDGET },
];

// Per-KEY budget windows a provider must satisfy to serve one request (doc 23). With
// multiple pooled keys the combined budget is (per-key budget × active keys).
export const PROVIDER_WINDOWS: Record<ProviderId, readonly QuotaBudget[]> = {
  pexels: [
    { key: 'pexels:hour', unit: 'hour', budget: PEXELS_HOUR_BUDGET },
    { key: 'pexels:month', unit: 'month', budget: PEXELS_MONTH_BUDGET },
  ],
  pixabay: [{ key: 'pixabay:minute', unit: 'minute', budget: PIXABAY_MINUTE_BUDGET }],
  openverse: [{ key: 'openverse:day', unit: 'day', budget: OPENVERSE_DAY_BUDGET }],
  nasa: [{ key: 'nasa:hour', unit: 'hour', budget: NASA_HOUR_BUDGET }],
  wikimedia: [{ key: 'wikimedia:hour', unit: 'hour', budget: WIKIMEDIA_HOUR_BUDGET }],
  'wikidata-commons': [
    { key: 'wikidata-commons:hour', unit: 'hour', budget: WIKIDATA_HOUR_BUDGET },
  ],
  met: [{ key: 'met:hour', unit: 'hour', budget: MET_HOUR_BUDGET }],
  'internet-archive': [
    { key: 'internet-archive:hour', unit: 'hour', budget: INTERNET_ARCHIVE_HOUR_BUDGET },
  ],
  inaturalist: [{ key: 'inaturalist:hour', unit: 'hour', budget: INATURALIST_HOUR_BUDGET }],
  usgs: [{ key: 'usgs:hour', unit: 'hour', budget: USGS_HOUR_BUDGET }],
  'library-of-congress': [
    { key: 'library-of-congress:hour', unit: 'hour', budget: LIBRARY_OF_CONGRESS_HOUR_BUDGET },
  ],
  flickr: [{ key: 'flickr:hour', unit: 'hour', budget: FLICKR_HOUR_BUDGET }],
  europeana: [{ key: 'europeana:hour', unit: 'hour', budget: EUROPEANA_HOUR_BUDGET }],
  smithsonian: [{ key: 'smithsonian:hour', unit: 'hour', budget: SMITHSONIAN_HOUR_BUDGET }],
};

// provider_usage key for one key's window, e.g. "pexels:hour#<keyId>" (doc 23).
export function usageKeyFor(budgetKey: string, keyId: string): string {
  return `${budgetKey}#${keyId}`;
}

export const PROVIDER_QUOTA_CODE = {
  pexels: 'E_QUOTA_PEXELS',
  pixabay: 'E_QUOTA_PIXABAY',
  openverse: 'E_QUOTA_OPENVERSE',
  nasa: 'E_QUOTA_NASA',
  wikimedia: 'E_QUOTA_WIKIMEDIA',
  'wikidata-commons': 'E_QUOTA_WIKIDATA',
  met: 'E_QUOTA_MET',
  'internet-archive': 'E_QUOTA_INTERNET_ARCHIVE',
  inaturalist: 'E_QUOTA_INATURALIST',
  usgs: 'E_QUOTA_USGS',
  'library-of-congress': 'E_QUOTA_LIBRARY_OF_CONGRESS',
  flickr: 'E_QUOTA_FLICKR',
  europeana: 'E_QUOTA_EUROPEANA',
  smithsonian: 'E_QUOTA_SMITHSONIAN',
} as const;

// Copyright-free archive/aggregator sources (doc 23). Curated stock (Pexels/Pixabay)
// is reliably on-topic; these are broader but variable quality, so the cross-check
// (doc 23 §6) holds their matches to a stricter bar on named-subject beats. Accepts a
// raw string so callers can pass a DB column (textcard/generated → not an archive).
const ARCHIVE_PROVIDER_SET: ReadonlySet<string> = new Set([
  'openverse',
  'nasa',
  'wikimedia',
  'wikidata-commons',
  'met',
  'internet-archive',
  'inaturalist',
  'usgs',
  'library-of-congress',
  'flickr',
  'europeana',
  'smithsonian',
]);
export function isArchiveProvider(provider: string): boolean {
  return ARCHIVE_PROVIDER_SET.has(provider);
}

// The media kind each specialized/archive source serves. Most are image-only; Internet Archive
// is the one video archive. `planTier1Requests` reads this to fire a topic-routed source only for
// the beat's media preference (image archives on mixed/photos, the video archive on mixed/videos).
// WHICH archives a beat gets is decided by topic + era (topics.ts); this is just their capability.
// The universal base providers (pexels/pixabay/openverse) are planned directly and aren't here.
export const ARCHIVE_KIND: Readonly<Partial<Record<ProviderId, MediaKind>>> = {
  nasa: 'image',
  wikimedia: 'image',
  met: 'image',
  'internet-archive': 'video',
  inaturalist: 'image',
  usgs: 'image',
  'library-of-congress': 'image',
  flickr: 'image',
  europeana: 'image',
  smithsonian: 'image',
};

// UTC-truncated window start for a bucket. Deterministic in its argument (no clock
// read) so it stays pure and testable; callers pass `new Date()`.
export function truncateWindow(date: Date, unit: QuotaWindowUnit): Date {
  const d = new Date(date);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  if (unit !== 'minute') d.setUTCMinutes(0);
  if (unit === 'day' || unit === 'month') d.setUTCHours(0);
  if (unit === 'month') d.setUTCDate(1);
  return d;
}

// Pixabay's video endpoint has no orientation param, so we post-filter its results
// by aspect within ±tol (doc 08). Pexels honors `orientation`, so callers skip it there.
export function matchesOrientation(
  width: number,
  height: number,
  orientation: Orientation,
  tol = 0.2,
): boolean {
  if (width <= 0 || height <= 0) return true; // unknown geometry — keep, hygiene decides
  const ar = width / height;
  const target = orientation === 'portrait' ? 9 / 16 : orientation === 'square' ? 1 : 16 / 9;
  return Math.abs(ar - target) / target <= tol;
}
