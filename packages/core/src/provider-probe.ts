import type { ProviderId, QuotaWindowUnit } from './providers';

// Per-key validity + live-limit probe (doc 23 §4). Pure descriptors and parsing only;
// the worker/web does the actual HTTP (invariant 8). A "Test" reaches the provider
// with one key and reports whether it works and its TRUE limit — not our estimate.

export interface ProbeResult {
  ok: boolean; // the key authenticated / the request was accepted
  status: number; // HTTP status of the probe
  limit: number | null; // real limit for this window, straight from the provider
  remaining: number | null; // remaining in the current window
  resetAt: string | null; // ISO time the window resets, if known
  window: QuotaWindowUnit | null; // which window `limit`/`remaining` describe
  detail?: string; // human-readable note (model tier, error message, "no per-key limit")
}

// How a provider exposes its rate limit to a probe.
// - 'xratelimit-headers': standard x-ratelimit-limit/-remaining/-reset (Pexels/Pixabay)
// - 'openverse-endpoint': POST /v1/rate_limit/ with the bearer → JSON usage
// - 'none': keyless / no per-key limit published (NASA, Wikimedia)
export type LimitSource = 'xratelimit-headers' | 'openverse-endpoint' | 'none';

export interface ProbeSpec {
  // A cheap, side-effect-free request that still counts as a real authenticated call.
  url: string;
  method: 'GET' | 'POST';
  limitSource: LimitSource;
  // x-ratelimit-reset is a unix epoch (Pexels) or seconds-until-reset (Pixabay).
  resetKind: 'epoch' | 'seconds' | null;
  window: QuotaWindowUnit | null;
}

export const PROVIDER_PROBE: Record<ProviderId, ProbeSpec> = {
  pexels: {
    url: 'https://api.pexels.com/v1/search?query=nature&per_page=1',
    method: 'GET',
    limitSource: 'xratelimit-headers',
    resetKind: 'epoch',
    window: 'hour',
  },
  pixabay: {
    // key is appended by the caller (applyAuth query param)
    url: 'https://pixabay.com/api/?q=nature&per_page=3',
    method: 'GET',
    limitSource: 'xratelimit-headers',
    resetKind: 'seconds',
    window: 'minute',
  },
  openverse: {
    url: 'https://api.openverse.org/v1/rate_limit/',
    method: 'GET',
    limitSource: 'openverse-endpoint',
    resetKind: null,
    window: 'day',
  },
  nasa: {
    url: 'https://images-api.nasa.gov/search?q=nature&page_size=1',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  wikimedia: {
    url: 'https://commons.wikimedia.org/w/api.php?action=query&format=json&meta=siteinfo&formatversion=2',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless resolver (doc 24 §4): no per-key limit to read; a cheap siteinfo call just
  // confirms reachability. Not shown in the key manager (no credential fields).
  'wikidata-commons': {
    url: 'https://www.wikidata.org/w/api.php?action=query&format=json&meta=siteinfo&formatversion=2',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless archive (doc 25 §2): no per-key limit; a cheap search call confirms
  // reachability. Not shown in the key manager (no credential fields).
  met: {
    url: 'https://collectionapi.metmuseum.org/public/collection/v1/search?q=art&hasImages=true',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless video archive (doc 25 §2): no per-key limit; a cheap advancedsearch call
  // confirms reachability. Not shown in the key manager (no credential fields).
  'internet-archive': {
    url: 'https://archive.org/advancedsearch.php?q=mediatype:movies&rows=1&output=json',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless archive (doc 25 §2): no per-key limit; a cheap observations call confirms
  // reachability. Not shown in the key manager (no credential fields).
  inaturalist: {
    url: 'https://api.inaturalist.org/v1/observations?q=nature&photos=true&per_page=1',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless archive (doc 25 §2): no per-key limit; a cheap catalog call confirms
  // reachability. Not shown in the key manager (no credential fields).
  usgs: {
    url: 'https://www.sciencebase.gov/catalog/items?q=nature&format=json&max=1',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyless archive (doc 25 §2): no per-key limit; a cheap photos call confirms
  // reachability. Not shown in the key manager (no credential fields).
  'library-of-congress': {
    url: 'https://www.loc.gov/photos/?q=nature&fo=json&c=1',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
  // Keyed archive (doc 25 §2): a cheap search call validates the api_key; reads
  // x-ratelimit-* if present, same shape as the stock providers.
  flickr: {
    url: 'https://www.flickr.com/services/rest/?method=flickr.photos.search&text=nature&per_page=1&format=json&nojsoncallback=1',
    method: 'GET',
    limitSource: 'xratelimit-headers',
    resetKind: 'epoch',
    window: 'hour',
  },
  // Keyed archive (doc 25 §2): a cheap search call validates the wskey.
  europeana: {
    url: 'https://api.europeana.eu/record/v2/search.json?query=nature&rows=1',
    method: 'GET',
    limitSource: 'xratelimit-headers',
    resetKind: 'epoch',
    window: 'hour',
  },
  // Keyed archive (doc 25 §2): a cheap search call validates the api.data.gov api_key.
  smithsonian: {
    url: 'https://api.si.edu/openaccess/api/v1.0/search?q=nature&rows=1',
    method: 'GET',
    limitSource: 'xratelimit-headers',
    resetKind: 'epoch',
    window: 'hour',
  },
  // Keyless archive: no per-key limit; a cheap images call confirms reachability. Not shown in
  // the key manager (no credential fields).
  wellcome: {
    url: 'https://api.wellcomecollection.org/catalogue/v2/images?query=nature&pageSize=1',
    method: 'GET',
    limitSource: 'none',
    resetKind: null,
    window: null,
  },
};

function toInt(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Parse the standard x-ratelimit-* trio. `get` is a case-insensitive header accessor;
// `nowMs` is injected so this stays pure and deterministic (invariant 8).
export function parseRateLimitHeaders(
  get: (name: string) => string | null,
  resetKind: 'epoch' | 'seconds',
  nowMs: number,
): { limit: number | null; remaining: number | null; resetAt: string | null } {
  const limit = toInt(get('x-ratelimit-limit'));
  const remaining = toInt(get('x-ratelimit-remaining'));
  const resetRaw = toInt(get('x-ratelimit-reset'));
  let resetAt: string | null = null;
  if (resetRaw != null) {
    const ms = resetKind === 'epoch' ? resetRaw * 1000 : nowMs + resetRaw * 1000;
    resetAt = new Date(ms).toISOString();
  }
  return { limit, remaining, resetAt };
}

// Openverse's rate_limit endpoint returns usage + a model name rather than a raw cap.
// Map the model to its documented daily limit so the UI can show limit/remaining too.
const OPENVERSE_MODEL_DAY_LIMIT: Record<string, number> = {
  enhanced: 20_000,
  standard: 10_000,
  anonymous: 100,
};

export interface OpenverseRateLimit {
  requests_this_minute?: number | null;
  requests_today?: number | null;
  rate_limit_model?: string | null;
  verified?: boolean | null;
}

export function interpretOpenverseRateLimit(body: OpenverseRateLimit): {
  limit: number | null;
  remaining: number | null;
  detail: string;
} {
  const model = (body.rate_limit_model ?? '').toLowerCase();
  const limit = OPENVERSE_MODEL_DAY_LIMIT[model] ?? null;
  const used = body.requests_today ?? null;
  const remaining = limit != null && used != null ? Math.max(0, limit - used) : null;
  const tier = body.rate_limit_model ? `${body.rate_limit_model} tier` : 'authenticated';
  return { limit, remaining, detail: tier };
}
