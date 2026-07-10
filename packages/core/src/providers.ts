import { PEXELS_HOUR_BUDGET, PEXELS_MONTH_BUDGET, PIXABAY_MINUTE_BUDGET } from './constants';
import { sha1Hex } from './hash';
import type { SubtitleAspect } from './subtitles/presets';

// Media provider seam (doc 08). Types + pure helpers live here; the HTTP impls
// (PexelsProvider/PixabayProvider) live in the worker. Every call goes through
// QuotaGuard then SearchCache — no path may hit a provider directly.

export type ProviderId = 'pexels' | 'pixabay';
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
  search(query: SearchQuery): Promise<RawCandidate[]>; // one HTTP request max
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
): PlannedRequest[] {
  const l0 = literal[0] ?? '';
  const l1 = literal[1] ?? l0;
  const requests: PlannedRequest[] = [
    { provider: 'pexels', kind: 'video', query: l0 },
    { provider: 'pixabay', kind: 'video', query: l1 },
  ];
  if (mediaPreference === 'mixed' || mediaPreference === 'photos') {
    requests.push({ provider: 'pixabay', kind: 'image', query: l0 });
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
export type QuotaWindowUnit = 'minute' | 'hour' | 'month';

export interface QuotaBudget {
  key: string; // provider_usage.provider value
  unit: QuotaWindowUnit;
  budget: number;
}

export const QUOTA_BUDGETS: readonly QuotaBudget[] = [
  { key: 'pexels:hour', unit: 'hour', budget: PEXELS_HOUR_BUDGET },
  { key: 'pexels:month', unit: 'month', budget: PEXELS_MONTH_BUDGET },
  { key: 'pixabay:minute', unit: 'minute', budget: PIXABAY_MINUTE_BUDGET },
];

// UTC-truncated window start for a bucket. Deterministic in its argument (no clock
// read) so it stays pure and testable; callers pass `new Date()`.
export function truncateWindow(date: Date, unit: QuotaWindowUnit): Date {
  const d = new Date(date);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  if (unit === 'hour' || unit === 'month') d.setUTCMinutes(0);
  if (unit === 'month') {
    d.setUTCHours(0);
    d.setUTCDate(1);
  }
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
