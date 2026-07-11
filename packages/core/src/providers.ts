import {
  NASA_HOUR_BUDGET,
  OPENVERSE_DAY_BUDGET,
  PEXELS_HOUR_BUDGET,
  PEXELS_MONTH_BUDGET,
  PIXABAY_MINUTE_BUDGET,
  WIKIMEDIA_HOUR_BUDGET,
} from './constants';
import type { Domain } from './domain';
import { sha1Hex } from './hash';
import type { RequestAuth } from './provider-auth';
import type { SubtitleAspect } from './subtitles/presets';

// Media provider seam (doc 08). Types + pure helpers live here; the HTTP impls
// (PexelsProvider/PixabayProvider) live in the worker. Every call goes through
// QuotaGuard then SearchCache — no path may hit a provider directly.

export type ProviderId = 'pexels' | 'pixabay' | 'openverse' | 'nasa' | 'wikimedia';
export type MediaKind = 'video' | 'image';
export type Orientation = 'landscape' | 'portrait' | 'square';

export interface SearchQuery {
  query: string;
  kind: MediaKind;
  orientation: Orientation;
  perPage: number;
}

export interface RawCandidate {
  provider: ProviderId;
  providerId: string;
  kind: MediaKind;
  width: number;
  height: number;
  duration?: number;
  thumbUrl: string;
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
): string {
  return sha1Hex(`${provider}|${kind}|${orientation}|${normalizeSearchQuery(query)}`);
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
}

export function planTier1Requests(
  literal: readonly string[],
  mediaPreference: 'videos' | 'mixed' | 'photos',
  domain: Domain = 'generic',
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
    // Domain-routed archives (doc 23 §5): e.g. NASA only on space/science/nature.
    for (const a of ARCHIVE_PROVIDERS) {
      if (a.domains.includes(domain)) requests.push({ provider: a.id, kind: a.kind, query: l0 });
    }
  }
  if (mediaPreference === 'photos') {
    requests.push({ provider: 'pexels', kind: 'image', query: l1 });
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
} as const;

// Domain-specific archive providers (doc 23 §5): fired only for beats whose domain
// they cover, so they add signal without polluting generic beats. Universal
// providers (pexels/pixabay/openverse) always run.
export const ARCHIVE_PROVIDERS: {
  id: ProviderId;
  kind: MediaKind;
  domains: readonly Domain[];
}[] = [
  { id: 'nasa', kind: 'image', domains: ['space', 'science', 'nature'] },
  // Wikimedia Commons is the universal named-subject archive (people, places,
  // events, works) — route it to every identifiable domain, leaving generic mood
  // beats and cityscapes to the stock providers.
  {
    id: 'wikimedia',
    kind: 'image',
    domains: ['space', 'nature', 'science', 'history', 'art', 'people', 'tech'],
  },
];

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
