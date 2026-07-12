import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// Library of Congress (doc 25 §2): keyless historical photos/prints. One call — the
// results carry size-ordered image_url arrays. Only items whose rights_advisory says
// "no known restrictions" are emitted (as 'public domain', which round-trips the core
// gate); everything else is dropped. Every failure degrades to [] (invariant 7).
// A PLAIN (non-browser) User-Agent is required — a browser UA trips a 403 Cloudflare
// challenge; a curl-style UA returns 200 JSON.
const LOC_PHOTOS = 'https://www.loc.gov/photos/';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const LocResult = z.object({
  id: z.string().nullish(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  image_url: z.array(z.string()).nullish(),
  item: z.object({ rights_advisory: z.unknown() }).nullish(),
});
export type LocResult = z.infer<typeof LocResult>;
const LocResponse = z.object({ results: z.array(LocResult).nullish() });

// rights_advisory arrives as a string or an array of strings; normalize to one joined
// string so the "no known restrictions" test is uniform. Non-string shapes → ''.
export function normalizeRights(rights: unknown): string {
  if (typeof rights === 'string') return rights;
  if (Array.isArray(rights)) {
    return rights.filter((r): r is string => typeof r === 'string').join('; ');
  }
  return '';
}

// image_url is size-ordered (small → large); the full-res rendition is the LAST
// tile.loc.gov/...jpg entry. SVGs and /static/images/original-format/ entries are
// multi-image placeholders, not the photo. Strips the trailing `#h=..&w=..` fragment
// and upgrades protocol-relative URLs. Returns null when there is no usable photo.
export function pickLocImageUrl(imageUrls: readonly string[]): string | null {
  let best: string | null = null;
  for (const raw of imageUrls) {
    const stripped = (raw.split('#')[0] ?? raw).trim();
    const url = stripped.startsWith('//') ? `https:${stripped}` : stripped;
    if (!url.includes('tile.loc.gov')) continue;
    if (url.includes('/static/images/original-format/')) continue;
    if (!/\.jpe?g(\?|$)/i.test(url)) continue; // skips .svg and non-jpg renditions
    best = url; // keep overwriting → the last (largest) match wins
  }
  return best;
}

// Pure: keep only "no known restrictions" items that carry a real tile.loc.gov photo.
export function toLocCandidates(results: readonly LocResult[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const r of results) {
    if (!/no known restrictions/i.test(normalizeRights(r.item?.rights_advisory))) continue;
    const download = pickLocImageUrl(r.image_url ?? []);
    if (!download) continue; // svg/placeholder only — no usable full-res image
    out.push({
      provider: 'library-of-congress',
      providerId: r.id ?? r.url ?? download,
      kind: 'image',
      width: 0, // unknown until download; hygiene keeps unknown-geometry candidates
      height: 0,
      thumbUrl: download,
      downloadUrl: download,
      pageUrl: r.id ?? r.url ?? '',
      author: 'Library of Congress',
      license: 'public domain', // rights_advisory == "no known restrictions"
      meta: { source: 'library of congress', title: r.title ?? '' },
    });
  }
  return out;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA }, // plain UA — a browser UA gets a 403 Cloudflare challenge
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

export class LibraryOfCongressProvider implements MediaProvider {
  readonly id = 'library-of-congress' as const;

  // `_auth` is keyless (kept for the MediaProvider contract): the loc.gov JSON API takes
  // no key.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Library of Congress is image-only here

    const url = new URL(LOC_PHOTOS);
    url.searchParams.set('q', query.query);
    url.searchParams.set('fo', 'json');
    url.searchParams.set('c', String(query.perPage));

    const parsed = LocResponse.safeParse(await getJson(url));
    if (!parsed.success) return [];
    return toLocCandidates(parsed.data.results ?? []);
  }
}
